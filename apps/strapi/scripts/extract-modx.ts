/**
 * Phase 6.5 MODX extractor.
 *
 * Reads `modx_site_content` + meta TVs from the running MODX MySQL dump
 * (see `infra/legacy-modx/docker-compose.yml`), classifies each row, seeds the
 * migration ledger for the extract run, walks the configured asset tree, and
 * writes both `plans/modx-extract.json` and `plans/migration-reports/run-*.{md,json}`.
 *
 * Contract: see plans/gh-issue-6_5-content-hydration.md → "Extract JSON format".
 * Shape: apps/strapi/scripts/extract-modx.types.ts (locked by Q11).
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { Connection } from 'mysql2/promise';
import { classifyContextKey, classifyRow, containsReplacementChar, type RawModxRow } from './extract-modx.row';
import {
  ASSET_WALK_SUBDIRS,
  type AssetAnomaly,
  type AssetInventoryEntry,
  type AssetInventoryStats,
  type ClassifiedRow,
  type ExtractCounts,
  type ExtractEnvelope,
  type ExtractRow,
  type Locale,
  type SkipReason,
  type TargetType,
  type TvAuditEntry,
  type Utf8Scan,
} from './extract-modx.types';
import { ensureLedgerSchema, LedgerHaltError } from './ledger-schema';
import { writeRunReport } from './render-run-report';

/** Override with `MIGRATION_LEDGER_PATH` for tests (`:memory:` or an absolute path). */
export const LEDGER_PATH = (() => {
  const raw = process.env.MIGRATION_LEDGER_PATH;
  if (!raw) return path.resolve(__dirname, '.migration-ledger.sqlite');
  if (raw === ':memory:') return ':memory:';
  return path.resolve(raw);
})();
export const CURRENT_RUN_PATH = path.resolve(__dirname, '..', '..', '..', 'plans', '.migration-current-run');
export const DEFAULT_MYSQL_RETRY_ATTEMPTS = 30;
export const DEFAULT_MYSQL_RETRY_MS = 1000;

export type ExtractHaltReason = 'asset_root_not_configured' | 'unexpected_context_key';

export class ExtractHaltError extends Error {
  readonly reason: ExtractHaltReason;
  readonly detail?: string;

  constructor(reason: ExtractHaltReason, detail?: string) {
    super(`[extract-modx] HALT: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ExtractHaltError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Resolve the MODX web-root path from (in precedence order): CLI arg, then
 * `MODX_ASSETS_ROOT` env var. Throws a Tier 1 halt if neither is provided.
 */
export async function resolveAssetsRoot(opts: {
  cliArg?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = opts.env ?? process.env;
  const candidate = opts.cliArg ?? env.MODX_ASSETS_ROOT;
  if (!candidate) {
    throw new ExtractHaltError(
      'asset_root_not_configured',
      'pass --assets-root=<path> or set MODX_ASSETS_ROOT',
    );
  }

  const resolved = path.resolve(candidate);
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`[extract-modx] assets root is not a directory: ${resolved}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`[extract-modx] assets root does not exist: ${resolved}`);
    }
    throw err;
  }
  return resolved;
}

/**
 * Filter rule for the asset walker. Currently a no-op — every file under the
 * nine walked subtrees is included except known machine-generated noise.
 */
export function isAssetIncluded(relativePath: string): boolean {
  const base = path.basename(relativePath);
  if (base === '.DS_Store') return false;
  if (base.startsWith('._')) return false;
  return true;
}

/** SHA256 of a file streamed from disk. Used for both dump hashing and asset hashing. */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Recursively walk `{assetsRoot}/{subdir}` and return one
 * {@link AssetInventoryEntry} per regular file. Paths are POSIX-normalized
 * relative to `assetsRoot`. Output is sorted lexicographically.
 */
export async function walkAssetInventory(
  assetsRoot: string,
  subdirs: readonly string[] = ASSET_WALK_SUBDIRS,
): Promise<{
  entries: AssetInventoryEntry[];
  stats: AssetInventoryStats;
  anomalies: AssetAnomaly[];
}> {
  const entries: AssetInventoryEntry[] = [];
  const anomalies: AssetAnomaly[] = [];
  const walkedDirs: string[] = [];

  for (const sub of subdirs) {
    const absSub = path.join(assetsRoot, sub);
    try {
      const stat = await fsp.stat(absSub);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    walkedDirs.push(sub);
    await walkDir(absSub, assetsRoot, entries, anomalies);
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  anomalies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  walkedDirs.sort();

  const stats: AssetInventoryStats = {
    total_count: entries.length,
    size_zero_count: entries.filter((entry) => entry.size_bytes === 0).length,
    walked_dirs: walkedDirs,
  };

  return { entries, stats, anomalies };
}

async function walkDir(
  absDir: string,
  assetsRoot: string,
  out: AssetInventoryEntry[],
  anomalies: AssetAnomaly[],
): Promise<void> {
  let dirents;
  try {
    dirents = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    anomalies.push({
      path: path.relative(assetsRoot, absDir),
      reason: 'unreadable',
      detail: (err as Error).message,
    });
    return;
  }

  for (const ent of dirents) {
    const abs = path.join(absDir, ent.name);
    const rel = toPosix(path.relative(assetsRoot, abs));
    if (!isAssetIncluded(rel)) continue;

    if (ent.isDirectory()) {
      await walkDir(abs, assetsRoot, out, anomalies);
      continue;
    }
    if (!ent.isFile()) continue;

    try {
      const stat = await fsp.stat(abs);
      const sha256 = await computeFileSha256(abs);
      out.push({ path: rel, size_bytes: stat.size, sha256 });
      if (stat.size === 0) {
        anomalies.push({ path: rel, reason: 'size_zero' });
      }
    } catch (err) {
      anomalies.push({
        path: rel,
        reason: 'unreadable',
        detail: (err as Error).message,
      });
    }
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Zero-initialized counts. Keys are pre-seeded so every target_type / locale /
 * skip_reason appears in JSON output even when its histogram bucket is 0.
 */
export function emptyCounts(): ExtractCounts {
  return {
    classified: 0,
    skipped: 0,
    by_target_type: {
      page: 0,
      disease: 0,
      'disease-category': 0,
      service: 0,
      'service-category': 0,
    },
    by_locale: { el: 0, ru: 0 },
    by_skip_reason: {
      non_content_context: 0,
      unknown_template: 0,
      empty_uri: 0,
    },
  };
}

/** Derive the `counts` envelope from a list of classified/skipped rows. Pure. */
export function deriveCounts(rows: readonly ExtractRow[]): ExtractCounts {
  const counts = emptyCounts();
  for (const row of rows) {
    if ('target_type' in row) {
      counts.classified++;
      counts.by_target_type[row.target_type as TargetType]++;
      counts.by_locale[row.locale as Locale]++;
    } else {
      counts.skipped++;
      counts.by_skip_reason[row.skip_reason as SkipReason]++;
    }
  }
  return counts;
}

/** Cap on UTF-8 replacement-char sample ids emitted in the envelope. */
export const UTF8_SCAN_SAMPLE_CAP = 20;

/**
 * Scan classified rows for the Unicode replacement character (U+FFFD) in any
 * text field. Records up to {@link UTF8_SCAN_SAMPLE_CAP} modx_ids for audit.
 */
export function deriveUtf8Scan(rows: readonly ExtractRow[]): Utf8Scan {
  const sample: number[] = [];
  let withBad = 0;
  let scanned = 0;
  for (const row of rows) {
    if (!('target_type' in row)) continue;
    scanned++;
    const c = row as ClassifiedRow;
    const hit =
      containsReplacementChar(c.title) ||
      containsReplacementChar(c.body_html) ||
      containsReplacementChar(c.seo_meta_title) ||
      containsReplacementChar(c.seo_meta_description);
    if (hit) {
      withBad++;
      if (sample.length < UTF8_SCAN_SAMPLE_CAP) sample.push(c.modx_id);
    }
  }
  return {
    rows_scanned: scanned,
    rows_with_replacement_char: withBad,
    sample_modx_ids: sample,
  };
}

/**
 * Assemble the full envelope. Pure function — no IO. Counts, UTF-8 scan,
 * and TV audit are derived or accepted from the caller.
 */
export function assembleEnvelope(opts: {
  runId: string;
  gitSha: string;
  sourceRowCount: number;
  sourceDumpSha256: string;
  rows: ExtractRow[];
  tvAudit?: TvAuditEntry[];
  assetInventory: AssetInventoryEntry[];
  assetInventoryStats: AssetInventoryStats;
  assetAnomalies: AssetAnomaly[];
}): ExtractEnvelope {
  return {
    schema_version: 1,
    run_id: opts.runId,
    git_sha: opts.gitSha,
    source_row_count: opts.sourceRowCount,
    source_dump_sha256: opts.sourceDumpSha256,
    counts: deriveCounts(opts.rows),
    tv_audit: opts.tvAudit ?? [],
    utf8_scan: deriveUtf8Scan(opts.rows),
    asset_inventory_relative_to: 'public_html',
    asset_inventory_stats: opts.assetInventoryStats,
    asset_anomalies: opts.assetAnomalies,
    asset_inventory: opts.assetInventory,
    rows: opts.rows,
  };
}

/**
 * Serialize the envelope to JSON with a trailing newline. Key order is
 * preserved from object-literal construction, giving deterministic output for
 * a given set of inputs.
 */
export function serializeEnvelope(envelope: ExtractEnvelope): string {
  return JSON.stringify(envelope, null, 2) + '\n';
}

export async function writeExtractJson(
  envelope: ExtractEnvelope,
  outPath: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, serializeEnvelope(envelope), 'utf8');
}

/** Minimal CLI flag parser — supports `--key=value` and `--key value`. */
export function parseCliArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[tok.slice(2)] = next;
        i++;
      } else {
        out[tok.slice(2)] = 'true';
      }
    }
  }
  return out;
}

/** Canonical SQL that yields one row per `modx_site_content` row with meta TVs. */
export const EXTRACT_SQL = `
  SELECT
    sc.id                                             AS id,
    sc.context_key                                    AS context_key,
    sc.template                                       AS template,
    sc.uri                                            AS uri,
    sc.pagetitle                                      AS pagetitle,
    sc.content                                        AS content,
    sc.properties                                     AS properties,
    sc.published                                      AS published,
    sc.deleted                                        AS deleted,
    sc.parent                                         AS parent,
    NULL                                              AS status_guess,
    MAX(CASE WHEN cv.tmplvarid = 1 THEN cv.value END) AS seo_meta_title,
    MAX(CASE WHEN cv.tmplvarid = 3 THEN cv.value END) AS seo_meta_description
  FROM modx_site_content sc
  LEFT JOIN modx_site_tmplvar_contentvalues cv
    ON cv.contentid = sc.id AND cv.tmplvarid IN (1, 3)
  GROUP BY sc.id
  ORDER BY sc.id ASC
`;

/** Canonical TV-audit query: one row per TV with its row-coverage count. */
export const TV_AUDIT_SQL = `
  SELECT tv.id AS tmplvar_id, tv.name AS name,
    (SELECT COUNT(*) FROM modx_site_tmplvar_contentvalues cv
       WHERE cv.tmplvarid = tv.id AND cv.value IS NOT NULL AND cv.value != '') AS rows_with_value
  FROM modx_site_tmplvars tv
  ORDER BY tv.id ASC
`;

export type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export function resolveMysqlConfig(env: NodeJS.ProcessEnv = process.env): MysqlConfig {
  return {
    host: env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(env.MYSQL_PORT ?? 3307),
    user: env.MYSQL_USER ?? 'root',
    password: env.MYSQL_PASSWORD ?? 'modx',
    database: env.MYSQL_DATABASE ?? 'modx',
  };
}

export async function connectMysql(cfg: MysqlConfig): Promise<Connection> {
  const { createConnection } = await import('mysql2/promise');
  return createConnection({ ...cfg, charset: 'utf8mb4' });
}

export async function connectMysqlWithRetry(
  cfg: MysqlConfig,
  opts: {
    attempts?: number;
    baseDelayMs?: number;
  } = {},
): Promise<Connection> {
  const attempts = opts.attempts ?? DEFAULT_MYSQL_RETRY_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_MYSQL_RETRY_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await connectMysql(cfg);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      const delayMs = baseDelayMs * attempt;
      console.error(
        `[extract-modx] mysql not ready (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('[extract-modx] failed to connect to MySQL after retries');
}

/** Read all content rows + meta TVs from the live MODX DB. */
export async function fetchRawRows(conn: Connection): Promise<RawModxRow[]> {
  const [rows] = await conn.query(EXTRACT_SQL);
  return (rows as unknown[]).map(coerceRawRow);
}

export async function fetchTvAudit(conn: Connection): Promise<TvAuditEntry[]> {
  const [rows] = await conn.query(TV_AUDIT_SQL);
  return (rows as Array<{ tmplvar_id: number; name: string; rows_with_value: number }>).map(
    (row) => ({
      tmplvar_id: Number(row.tmplvar_id),
      name: String(row.name),
      rows_with_value: Number(row.rows_with_value),
    }),
  );
}

/** Normalize mysql2's loose types (Buffer, BigInt, etc.) to RawModxRow. */
export function coerceRawRow(input: unknown): RawModxRow {
  const row = input as Record<string, unknown>;
  const toStr = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return String(value);
  };
  const toNum = (value: unknown): number => {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    return Number(value ?? 0);
  };
  return {
    id: toNum(row.id),
    context_key: String(row.context_key ?? ''),
    template: toNum(row.template),
    uri: toStr(row.uri),
    pagetitle: toStr(row.pagetitle),
    content: toStr(row.content),
    properties: toStr(row.properties),
    published: toNum(row.published),
    deleted: toNum(row.deleted),
    parent: toNum(row.parent),
    status_guess: toStr(row.status_guess),
    seo_meta_title: toStr(row.seo_meta_title),
    seo_meta_description: toStr(row.seo_meta_description),
  };
}

/** Resolve the current git SHA (short). Falls back to 'unknown' off-VCS. */
export function currentGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Run id: `YYYYMMDDTHHMMSSZ-<gitsha>` (deterministic per invocation). */
export function newRunId(gitSha: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
  return `${iso}-${gitSha}`;
}

export function assertSupportedContexts(rawRows: readonly RawModxRow[]): void {
  const unsupported = [...new Set(rawRows.map((row) => row.context_key).filter((ctx) => ctx !== 'web' && ctx !== 'rus'))]
    .sort();
  if (unsupported.length > 0) {
    throw new ExtractHaltError(
      'unexpected_context_key',
      `only web/rus are allowed; saw ${unsupported.join(', ')}`,
    );
  }
}

function createMigrationRun(db: Database.Database, gitSha: string, runLabel: string): number {
  const info = db
    .prepare(`INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('extract', ?, ?)`)
    .run(gitSha, runLabel);
  return Number(info.lastInsertRowid);
}

async function writeCurrentRun(runId: string): Promise<void> {
  await fsp.mkdir(path.dirname(CURRENT_RUN_PATH), { recursive: true });
  await fsp.writeFile(CURRENT_RUN_PATH, `${runId}\n`, 'utf8');
}

export async function clearCurrentRun(): Promise<void> {
  await fsp.rm(CURRENT_RUN_PATH, { force: true });
}

function ledgerLocaleForRow(row: ExtractRow): Locale {
  if ('target_type' in row) {
    return row.locale;
  }

  const locale = classifyContextKey(row.modx_raw.context_key);
  if (!locale) {
    throw new ExtractHaltError(
      'unexpected_context_key',
      `only web/rus are allowed; saw ${row.modx_raw.context_key}`,
    );
  }
  return locale;
}

export function seedExtractLedger(
  db: Database.Database,
  runDbId: number,
  rows: readonly ExtractRow[],
): void {
  const insertRecord = db.prepare(`
    INSERT INTO migration_record (
      run_id, modx_id, locale, target_type, state, stage, reason_code, needs_review
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO migration_event (
      run_id, modx_id, from_state, to_state, stage, attempt, reason_code, error_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const locale = ledgerLocaleForRow(row);
    const targetType = 'target_type' in row ? row.target_type : 'unknown';
    const state = 'target_type' in row ? 'classified' : 'skipped';
    const reasonCode = 'target_type' in row ? null : row.skip_reason;
    const needsReview = 'target_type' in row && row.needs_review_seed ? 1 : 0;

    insertRecord.run(runDbId, row.modx_id, locale, targetType, state, 'extract', reasonCode, needsReview);
    insertEvent.run(runDbId, row.modx_id, null, 'discovered', 'extract', 0, null, null);
    insertEvent.run(runDbId, row.modx_id, 'discovered', state, 'classify', 0, reasonCode, reasonCode);
  }
}

function setRunTerminalStatus(
  db: Database.Database,
  runDbId: number,
  exitStatus: 'ok' | 'halted' | 'crashed',
  haltReason: string | null,
): void {
  db.prepare(
    `UPDATE migration_run
        SET exit_status = ?, halt_reason = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`,
  ).run(exitStatus, haltReason, runDbId);
}

/** CLI entry. Accepts `--assets-root`, `--dump`, `--out`, `--run-id`. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseCliArgs(argv);
  const dumpPath = path.resolve(
    flags.dump ?? path.join(__dirname, '..', '..', '..', 'ce39229_myorl.sql'),
  );
  const outPath = path.resolve(
    flags.out ?? path.join(__dirname, '..', '..', '..', 'plans', 'modx-extract.json'),
  );
  const gitSha = currentGitSha();
  const runLabel = flags['run-id'] ?? newRunId(gitSha);
  const mysqlCfg = resolveMysqlConfig();

  console.error(`[extract-modx] dump=${dumpPath}`);
  console.error(`[extract-modx] out=${outPath}`);
  console.error(`[extract-modx] mysql=${mysqlCfg.host}:${mysqlCfg.port}/${mysqlCfg.database}`);
  console.error(`[extract-modx] run_id=${runLabel} git_sha=${gitSha}`);

  const db = new Database(LEDGER_PATH);
  let runDbId: number | null = null;

  try {
    ensureLedgerSchema(db);
    runDbId = createMigrationRun(db, gitSha, runLabel);
    await writeCurrentRun(runLabel);

    const assetsRoot = await resolveAssetsRoot({ cliArg: flags['assets-root'] });
    console.error(`[extract-modx] assets_root=${assetsRoot}`);

    const sourceDumpSha256 = await computeFileSha256(dumpPath);
    console.error(`[extract-modx] source_dump_sha256=${sourceDumpSha256}`);

    const conn = await connectMysqlWithRetry(mysqlCfg);
    let rows: ExtractRow[];
    let tvAudit: TvAuditEntry[];
    try {
      const rawRows = await fetchRawRows(conn);
      console.error(`[extract-modx] fetched ${rawRows.length} rows`);
      assertSupportedContexts(rawRows);

      rows = rawRows.map(classifyRow);
      seedExtractLedger(db, runDbId, rows);

      tvAudit = await fetchTvAudit(conn);
      console.error(`[extract-modx] tv_audit: ${tvAudit.length} template variables`);

      const { entries, stats, anomalies } = await walkAssetInventory(assetsRoot);
      console.error(
        `[extract-modx] asset_inventory: ${entries.length} files across ${stats.walked_dirs.length} dirs`,
      );

      const envelope = assembleEnvelope({
        runId: runLabel,
        gitSha,
        sourceRowCount: rawRows.length,
        sourceDumpSha256,
        rows,
        tvAudit,
        assetInventory: entries,
        assetInventoryStats: stats,
        assetAnomalies: anomalies,
      });

      await writeExtractJson(envelope, outPath);
      console.error(`[extract-modx] wrote ${outPath}`);

      setRunTerminalStatus(db, runDbId, 'ok', null);
      const report = await writeRunReport(db, runLabel, envelope);
      console.error(`[extract-modx] wrote ${report.markdownPath}`);
      console.error(`[extract-modx] wrote ${report.jsonPath}`);
      console.error(
        `[extract-modx] counts: classified=${envelope.counts.classified} skipped=${envelope.counts.skipped}`,
      );
    } finally {
      await conn.end();
    }
  } catch (err) {
    if (runDbId !== null) {
      const isHalt = err instanceof ExtractHaltError || err instanceof LedgerHaltError;
      const haltReason = isHalt
        ? err.reason
        : err instanceof Error
          ? err.message
          : 'unknown_error';
      try {
        setRunTerminalStatus(db, runDbId, isHalt ? 'halted' : 'crashed', haltReason);
      } catch {
        // Best-effort status update only.
      }
    }
    await clearCurrentRun();
    throw err;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[extract-modx] FATAL:', err);
    process.exit(1);
  });
}
