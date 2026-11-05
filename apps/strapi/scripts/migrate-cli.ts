import { compileStrapi, createStrapi } from '@strapi/strapi';
import { execSync } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { currentGitSha, LEDGER_PATH, newRunId } from './extract-modx';
import { ensureLedgerSchema } from './ledger-schema';
import {
  DEFAULT_REASON_CODE_THRESHOLDS,
  exceedsSucceededDelta,
  parseReasonCodeThresholdOverrides,
  shouldPromoteReasonCode,
} from './halt-thresholds';
import {
  buildAssetPathSet,
  buildDesiredContentPayload,
  buildDesiredUrlMapping,
  buildRouteLookups,
  EXPECTED_EXTRACT_JSON_VERSION,
  isClassifiedRow,
  loadExtractEnvelope,
  TARGET_UID_BY_TYPE,
  type MigrationAnnotation,
} from '../src/lib/migration';
import type { ExtractRow } from './extract-modx.types';
import {
  applyNeedsReviewSetOnlyOnTrue,
  buildCanonicalUsageIndex,
  reconcileWritingRowDecision,
  resolveExistingDocumentForMerge,
  selectContentMergeAction,
  selectUrlMappingMergeAction,
  sortPagesByDepth,
  sortRowsForPass,
  type DocumentSnapshot,
  type UrlMappingSnapshot,
} from './migrate-core';

const APP_DIR = path.resolve(__dirname, '..');
const BASELINE_PATH = process.env.MIGRATION_BASELINE_PATH
  ? path.resolve(process.env.MIGRATION_BASELINE_PATH)
  : path.resolve(__dirname, '..', '..', '..', 'plans', 'migration-reports', 'baseline.json');
const REPORT_DIR = process.env.MIGRATION_REPORT_DIR
  ? path.resolve(process.env.MIGRATION_REPORT_DIR)
  : path.resolve(__dirname, '..', '..', '..', 'plans', 'migration-reports');
const CANONICALPATH_BASELINE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'plans',
  'verification',
  'canonicalpath-uniqueness-2026-04-19.txt',
);
const URL_MAPPING_UID = 'api::url-mapping.url-mapping';
const CONTENT_UIDS = [
  'api::page.page',
  'api::disease.disease',
  'api::disease-category.disease-category',
  'api::service.service',
  'api::service-category.service-category',
] as const;
const ROUTING_LOCALES = ['el', 'ru'] as const;

type RunMode = 'dry-run' | 'merge' | 'reset-dev';
type Command = 'run' | 'status' | 'row' | 'failed' | 'review' | 'diff';
type RowState =
  | 'discovered'
  | 'classified'
  | 'validated'
  | 'writing'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'superseded';

type ParsedArgs = {
  command: Command;
  flags: Record<string, string>;
  positionals: string[];
};

type Baseline = {
  schema_version: 1;
  generated_from_run: string;
  git_sha: string;
  succeeded_by_target_type: Record<string, number>;
  reason_code_counts: Record<string, number>;
  utf8_scan: {
    rows_scanned: number;
    rows_with_replacement_char: number;
  };
};

type RunSummary = {
  mode: RunMode;
  run_id: string;
  extract_run_id: string;
  source_row_count: number;
  succeeded_by_target_type: Record<string, number>;
  reason_code_counts: Record<string, number>;
  needs_review_count: number;
  state_counts: Record<string, number>;
  baseline_written: boolean;
  baseline_compared: boolean;
  notes: string[];
};

const URL_MAPPING_RELATION_BY_UID: Record<string, string> = {
  'api::page.page': 'page',
  'api::disease.disease': 'disease',
  'api::disease-category.disease-category': 'disease_category',
  'api::service.service': 'service',
  'api::service-category.service-category': 'service_category',
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[token.slice(2)] = next;
          i++;
        } else {
          flags[token.slice(2)] = 'true';
        }
      }
      continue;
    }

    if (token === '--') continue;
    positionals.push(token);
  }

  const command = (positionals[0] as Command | undefined) ?? 'run';
  if (!['run', 'status', 'row', 'failed', 'review', 'diff'].includes(command)) {
    return { command: 'run', flags, positionals };
  }

  return {
    command,
    flags,
    positionals: command === 'run' ? positionals : positionals.slice(1),
  };
}

function assertRunMode(value: string | undefined): RunMode {
  if (value === 'dry-run' || value === 'merge' || value === 'reset-dev') {
    return value;
  }
  throw new Error('usage: migrate-cli.ts --mode=<dry-run|merge|reset-dev>');
}

function hasDirtyGitWorktree(): boolean {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

function detectCanonicalPathVerdict(dbPath: string): 'per-locale' | 'global' | 'none' {
  if (!existsSync(dbPath)) {
    throw new Error(
      `strapi_sqlite_not_found: ${dbPath} — must match config/database.ts sqlite path (run dev once, or run merge after a successful Strapi init).`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = ['pages', 'diseases', 'disease_categories', 'services', 'service_categories'];
    let sawGlobal = false;
    let sawPerLocale = false;

    for (const table of tables) {
      const tableRow = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table) as { sql: string } | undefined;
      if (!tableRow?.sql) continue;

      const indexes = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
        .all(table) as Array<{ sql: string | null }>;

      for (const idx of indexes) {
        if (!idx.sql || !/UNIQUE/i.test(idx.sql) || !/canonical_path/.test(idx.sql)) continue;
        const match = idx.sql.match(/\(([^)]+)\)/);
        const cols = match ? match[1].split(',').map((col) => col.replace(/[`"]/g, '').trim()) : [];
        if (cols.includes('locale')) {
          sawPerLocale = true;
        } else if (cols.length === 1 && cols[0] === 'canonical_path') {
          sawGlobal = true;
        }
      }

      if (/UNIQUE\s*\([^)]*canonical_path[^)]*\)/i.test(tableRow.sql)) {
        sawGlobal = true;
      }
    }

    if (sawGlobal) return 'global';
    if (sawPerLocale) return 'per-locale';
    return 'none';
  } finally {
    db.close();
  }
}

function readExpectedCanonicalPathVerdict(): 'per-locale' | 'global' | 'none' {
  const text = existsSync(CANONICALPATH_BASELINE_PATH)
    ? execSync(`cat ${JSON.stringify(CANONICALPATH_BASELINE_PATH)}`, { encoding: 'utf8' })
    : '';
  if (text.includes('OVERALL VERDICT: global')) return 'global';
  if (text.includes('OVERALL VERDICT: per-locale')) return 'per-locale';
  return 'none';
}

/**
 * What Strapi actually uses after config load (dist paths, env, etc.); do not
 * re-derive with `__dirname` heuristics.
 */
function getStrapiSqlitePathFromStrapi(strapi: { config: { get: (key: string) => unknown } }): string {
  const raw = strapi.config.get('database') as
    | { connection?: { client?: string; connection?: { filename?: string } } }
    | undefined;
  const filename = raw?.connection?.connection?.filename;
  if (typeof filename === 'string' && filename.length > 0) {
    return path.resolve(filename);
  }
  throw new Error(
    'migrate:modx: could not read sqlite path from strapi config (set DATABASE_CLIENT=sqlite; check DATABASE_FILENAME).',
  );
}

async function bootStrapi(mode: RunMode) {
  process.env.APP_KEYS = process.env.APP_KEYS || 'migration_key_a,migration_key_b';
  process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'migration_admin_jwt_secret';
  process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'migration_api_token_salt';
  process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'migration_transfer_token_salt';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'migration_jwt_secret';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'migration_encryption_key';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';

  if (mode === 'merge' || mode === 'reset-dev') {
    process.env.MIGRATION_IN_PROGRESS = 'true';
  } else {
    delete process.env.MIGRATION_IN_PROGRESS;
  }

  const { appDir, distDir } = await compileStrapi({ appDir: APP_DIR });
  return createStrapi({ appDir, distDir, autoReload: false, serveAdminPanel: false }).load();
}

function insertRun(db: Database.Database, mode: RunMode, gitSha: string, runLabel: string): number {
  const info = db
    .prepare(`INSERT INTO migration_run (mode, git_sha, run_label) VALUES (?, ?, ?)`)
    .run(mode, gitSha, runLabel);
  return Number(info.lastInsertRowid);
}

function updateRunStatus(
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

function appendEvent(
  db: Database.Database,
  args: {
    runDbId: number;
    modxId: number;
    fromState: RowState | null;
    toState: RowState;
    stage: string;
    attempt: number;
    reasonCode?: string | null;
    errorDetail?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO migration_event (
      run_id, modx_id, from_state, to_state, stage, attempt, reason_code, error_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.runDbId,
    args.modxId,
    args.fromState,
    args.toState,
    args.stage,
    args.attempt,
    args.reasonCode ?? null,
    args.errorDetail ?? null,
  );
}

function seedRunFromExtract(
  db: Database.Database,
  runDbId: number,
  envelope: Awaited<ReturnType<typeof loadExtractEnvelope>>,
): Map<number, RowState> {
  const insertRecord = db.prepare(`
    INSERT INTO migration_record (
      run_id, modx_id, locale, target_type, state, stage, reason_code, needs_review
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const states = new Map<number, RowState>();
  for (const row of envelope.rows) {
    const locale = isClassifiedRow(row)
      ? row.locale
      : row.modx_raw.context_key === 'rus'
        ? 'ru'
        : 'el';
    const targetType = isClassifiedRow(row) ? row.target_type : 'unknown';
    const state: RowState = isClassifiedRow(row) ? 'classified' : 'skipped';
    const reasonCode = isClassifiedRow(row) ? null : row.skip_reason;
    const needsReview = isClassifiedRow(row) && row.needs_review_seed ? 1 : 0;

    insertRecord.run(runDbId, row.modx_id, locale, targetType, state, 'classify', reasonCode, needsReview);
    appendEvent(db, {
      runDbId,
      modxId: row.modx_id,
      fromState: null,
      toState: 'discovered',
      stage: 'extract-import',
      attempt: 0,
    });
    appendEvent(db, {
      runDbId,
      modxId: row.modx_id,
      fromState: 'discovered',
      toState: state,
      stage: 'classify',
      attempt: 0,
      reasonCode,
      errorDetail: reasonCode,
    });
    states.set(row.modx_id, state);
  }

  return states;
}

function transitionRecord(
  db: Database.Database,
  states: Map<number, RowState>,
  args: {
    runDbId: number;
    modxId: number;
    toState: RowState;
    stage: string;
    attempt?: number;
    reasonCode?: string | null;
    errorDetail?: string | null;
    strapiDocId?: string | null;
    contentHash?: string | null;
    needsReview?: boolean;
  },
): void {
  const currentState = states.get(args.modxId) ?? null;
  db.prepare(
    `UPDATE migration_record
        SET state = ?,
            stage = ?,
            attempts = ?,
            reason_code = ?,
            last_error = ?,
            strapi_doc_id = COALESCE(?, strapi_doc_id),
            content_hash = COALESCE(?, content_hash),
            needs_review = CASE WHEN ? IS NULL THEN needs_review ELSE ? END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE run_id = ? AND modx_id = ?`,
  ).run(
    args.toState,
    args.stage,
    args.attempt ?? 0,
    args.reasonCode ?? null,
    args.errorDetail ?? null,
    args.strapiDocId ?? null,
    args.contentHash ?? null,
    args.needsReview === undefined ? null : args.needsReview ? 1 : 0,
    args.needsReview === undefined ? null : args.needsReview ? 1 : 0,
    args.runDbId,
    args.modxId,
  );

  appendEvent(db, {
    runDbId: args.runDbId,
    modxId: args.modxId,
    fromState: currentState,
    toState: args.toState,
    stage: args.stage,
    attempt: args.attempt ?? 0,
    reasonCode: args.reasonCode,
    errorDetail: args.errorDetail,
  });
  states.set(args.modxId, args.toState);
}

function annotateRecord(
  db: Database.Database,
  states: Map<number, RowState>,
  args: {
    runDbId: number;
    modxId: number;
    annotations: MigrationAnnotation[];
    attempt?: number;
  },
): void {
  const currentState = states.get(args.modxId) ?? null;
  for (const annotation of args.annotations) {
    appendEvent(db, {
      runDbId: args.runDbId,
      modxId: args.modxId,
      fromState: currentState,
      toState: currentState ?? 'classified',
      stage: 'annotate',
      attempt: args.attempt ?? 0,
      reasonCode: annotation.reason_code,
      errorDetail: annotation.detail ?? null,
    });
  }
}

async function loadContentSnapshots(strapi: any): Promise<Map<string, DocumentSnapshot>> {
  const map = new Map<string, DocumentSnapshot>();
  for (const uid of CONTENT_UIDS) {
    const rows = (await strapi.db.query(uid).findMany({
      populate: {
        parent: true,
        category: true,
        seo: true,
      },
    })) as any[];

    for (const row of rows) {
      const snapshot: DocumentSnapshot = {
        uid,
        documentId: row.documentId,
        locale: row.locale,
        canonicalPath: row.canonicalPath,
        modxId: row.modxId ?? null,
        _migrationContentHash: row._migrationContentHash ?? null,
        needs_review: Boolean(row.needs_review),
        publishedAt: row.publishedAt ?? null,
        parentDocumentId: row.parent?.documentId ?? null,
        categoryDocumentId: row.category?.documentId ?? null,
      };
      map.set(`${uid}:${snapshot.locale}:${snapshot.documentId}`, snapshot);
    }
  }
  return map;
}

async function loadUrlMappingSnapshots(strapi: any): Promise<Map<string, UrlMappingSnapshot>> {
  const map = new Map<string, UrlMappingSnapshot>();
  const rows = (await strapi.db.query(URL_MAPPING_UID).findMany({
    populate: {
      page: true,
      disease: true,
      disease_category: true,
      service: true,
      service_category: true,
    },
  })) as any[];

  for (const row of rows) {
    const relationField = ['page', 'disease', 'disease_category', 'service', 'service_category'].find(
      (field) => row[field]?.documentId,
    ) ?? null;
    const relationDocumentId = relationField ? row[relationField]?.documentId ?? null : null;
    const snapshot: UrlMappingSnapshot = {
      documentId: row.documentId,
      locale: row.locale,
      path: row.path,
      type: row.type,
      isAutoGenerated: Boolean(row.isAutoGenerated),
      legacyPaths: Array.isArray(row.legacyPaths) ? [...row.legacyPaths].sort() : [],
      relationField,
      relationDocumentId,
    };
    map.set(`${snapshot.locale}:${relationField ?? 'none'}:${relationDocumentId ?? snapshot.documentId}`, snapshot);
  }

  return map;
}

async function reconcileWritingRows(
  db: Database.Database,
  strapi: any,
  currentRunDbId: number,
): Promise<void> {
  const writingRows = db
    .prepare(
      `SELECT mr.run_id, mr.modx_id, mr.locale, mr.target_type, mr.content_hash
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.state = 'writing' AND mr.run_id != ?
        ORDER BY mr.run_id ASC, mr.modx_id ASC`,
    )
    .all(currentRunDbId) as Array<{
      run_id: number;
      modx_id: number;
      locale: 'el' | 'ru';
      target_type: string;
      content_hash: string | null;
    }>;

  for (const row of writingRows) {
    const uid = TARGET_UID_BY_TYPE[row.target_type as keyof typeof TARGET_UID_BY_TYPE];
    if (!uid) continue;
    const existing = await strapi.documents(uid).findFirst({
      filters: { modxId: { $eq: row.modx_id } } as any,
      locale: row.locale,
    });

    const decision = reconcileWritingRowDecision({
      existingDoc: existing
        ? { _migrationContentHash: existing._migrationContentHash ?? null }
        : null,
      ledgerContentHash: row.content_hash,
    });
    const nextState: RowState = decision.nextState;
    const reasonCode = decision.reasonCode;

    db.prepare(
      `UPDATE migration_record
          SET state = ?, stage = 'reconcile', reason_code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE run_id = ? AND modx_id = ?`,
    ).run(nextState, reasonCode, row.run_id, row.modx_id);

    appendEvent(db, {
      runDbId: row.run_id,
      modxId: row.modx_id,
      fromState: 'writing',
      toState: nextState,
      stage: 'reconcile',
      attempt: 0,
      reasonCode,
    });
  }
}

async function updateSnapshotFromResult(
  contentSnapshots: Map<string, DocumentSnapshot>,
  snapshot: DocumentSnapshot,
): Promise<void> {
  contentSnapshots.set(`${snapshot.uid}:${snapshot.locale}:${snapshot.documentId}`, snapshot);
}

function countRowsByState(db: Database.Database, runDbId: number): Record<string, number> {
  const rows = db
    .prepare(`SELECT state, COUNT(*) AS count FROM migration_record WHERE run_id = ? GROUP BY state`)
    .all(runDbId) as Array<{ state: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}

function summarizeReasonCodes(db: Database.Database, runDbId: number): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT reason_code, COUNT(*) AS count
         FROM migration_event
        WHERE run_id = ? AND reason_code IS NOT NULL
        GROUP BY reason_code
        ORDER BY reason_code`,
    )
    .all(runDbId) as Array<{ reason_code: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.reason_code, row.count]));
}

function summarizeSucceededByTargetType(db: Database.Database, runDbId: number): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT target_type, COUNT(*) AS count
         FROM migration_record
        WHERE run_id = ? AND state = 'succeeded'
        GROUP BY target_type
        ORDER BY target_type`,
    )
    .all(runDbId) as Array<{ target_type: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.target_type, row.count]));
}

async function maybeWriteBaseline(
  summary: RunSummary,
  envelope: Awaited<ReturnType<typeof loadExtractEnvelope>>,
  gitSha: string,
): Promise<{ written: boolean; compared: boolean; notes: string[] }> {
  const notes: string[] = [];
  if (!existsSync(BASELINE_PATH)) {
    if (summary.mode === 'dry-run') {
      const baseline: Baseline = {
        schema_version: 1,
        generated_from_run: summary.run_id,
        git_sha: gitSha,
        succeeded_by_target_type: summary.succeeded_by_target_type,
        reason_code_counts: summary.reason_code_counts,
        utf8_scan: {
          rows_scanned: envelope.utf8_scan.rows_scanned,
          rows_with_replacement_char: envelope.utf8_scan.rows_with_replacement_char,
        },
      };
      await fsp.mkdir(path.dirname(BASELINE_PATH), { recursive: true });
      await fsp.writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
      notes.push(`baseline written to ${BASELINE_PATH}`);
      return { written: true, compared: false, notes };
    }

    notes.push('baseline missing; merge run continues with warning');
    return { written: false, compared: false, notes };
  }

  const baseline = JSON.parse(await fsp.readFile(BASELINE_PATH, 'utf8')) as Baseline;
  for (const [targetType, expected] of Object.entries(baseline.succeeded_by_target_type)) {
    const actual = summary.succeeded_by_target_type[targetType] ?? 0;
    if (exceedsSucceededDelta(expected, actual)) {
      throw new Error(`baseline_succeeded_delta_exceeded:${targetType}`);
    }
  }

  const thresholds = parseReasonCodeThresholdOverrides(process.env.MIGRATION_REASON_THRESHOLDS);
  for (const [reasonCode, count] of Object.entries(summary.reason_code_counts)) {
    if (shouldPromoteReasonCode(reasonCode, count, summary.source_row_count, thresholds)) {
      throw new Error(`reason_code_threshold_exceeded:${reasonCode}`);
    }
  }

  notes.push(`baseline compared against ${BASELINE_PATH}`);
  return { written: false, compared: true, notes };
}

async function writeRunReport(
  db: Database.Database,
  runDbId: number,
  summary: RunSummary,
): Promise<void> {
  const row = db
    .prepare(
      `SELECT started_at, finished_at, exit_status, halt_reason, git_sha
         FROM migration_run
        WHERE id = ?`,
    )
    .get(runDbId) as {
      started_at: string;
      finished_at: string | null;
      exit_status: string | null;
      halt_reason: string | null;
      git_sha: string;
    };

  await fsp.mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, `run-${summary.run_id}.json`);
  const markdownPath = path.join(REPORT_DIR, `run-${summary.run_id}.md`);

  const payload = {
    ...summary,
    started_at: row.started_at,
    finished_at: row.finished_at,
    exit_status: row.exit_status,
    halt_reason: row.halt_reason,
    git_sha: row.git_sha,
  };

  const markdown = [
    `# Migration run ${summary.run_id}`,
    '',
    '## Metadata',
    '',
    `- mode: ${summary.mode}`,
    `- extract_run_id: ${summary.extract_run_id}`,
    `- started_at: ${row.started_at}`,
    `- finished_at: ${row.finished_at ?? 'null'}`,
    `- exit_status: ${row.exit_status ?? 'null'}`,
    `- halt_reason: ${row.halt_reason ?? 'null'}`,
    '',
    '## Counts',
    '',
    `- source_row_count: ${summary.source_row_count}`,
    `- needs_review_count: ${summary.needs_review_count}`,
    `- state_counts: ${JSON.stringify(summary.state_counts)}`,
    `- succeeded_by_target_type: ${JSON.stringify(summary.succeeded_by_target_type)}`,
    `- reason_code_counts: ${JSON.stringify(summary.reason_code_counts)}`,
    '',
    '## Notes',
    '',
    ...summary.notes.map((note) => `- ${note}`),
    '',
  ].join('\n');

  await fsp.writeFile(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fsp.writeFile(markdownPath, markdown, 'utf8');
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function runStatusCommand(db: Database.Database, runLabel?: string): Promise<void> {
  const row = runLabel
    ? db
        .prepare(`SELECT * FROM migration_run WHERE run_label = ?`)
        .get(runLabel)
    : db
        .prepare(`SELECT * FROM migration_run ORDER BY started_at DESC LIMIT 1`)
        .get();
  printJson(row ?? null);
}

async function runRowCommand(db: Database.Database, modxIdRaw: string): Promise<void> {
  const modxId = Number(modxIdRaw);
  const records = db
    .prepare(
      `SELECT r.run_label, mr.*
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.modx_id = ?
        ORDER BY mr.run_id ASC`,
    )
    .all(modxId);
  const events = db
    .prepare(
      `SELECT r.run_label, me.*
         FROM migration_event me
         JOIN migration_run r ON r.id = me.run_id
        WHERE me.modx_id = ?
        ORDER BY me.id ASC`,
    )
    .all(modxId);
  printJson({ records, events });
}

async function runFailedCommand(db: Database.Database, runLabel?: string): Promise<void> {
  const sql = runLabel
    ? `SELECT r.run_label, mr.reason_code, COUNT(*) AS count
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.state = 'failed' AND r.run_label = ?
        GROUP BY r.run_label, mr.reason_code
        ORDER BY mr.reason_code`
    : `SELECT r.run_label, mr.reason_code, COUNT(*) AS count
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.state = 'failed'
        GROUP BY r.run_label, mr.reason_code
        ORDER BY r.run_label, mr.reason_code`;
  printJson(runLabel ? db.prepare(sql).all(runLabel) : db.prepare(sql).all());
}

async function runReviewCommand(db: Database.Database, runLabel?: string): Promise<void> {
  const sql = runLabel
    ? `SELECT r.run_label, mr.modx_id, mr.locale, mr.target_type, mr.state, mr.reason_code
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.needs_review = 1 AND r.run_label = ?
        ORDER BY mr.modx_id ASC`
    : `SELECT r.run_label, mr.modx_id, mr.locale, mr.target_type, mr.state, mr.reason_code
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.needs_review = 1
        ORDER BY r.run_label, mr.modx_id ASC`;
  printJson(runLabel ? db.prepare(sql).all(runLabel) : db.prepare(sql).all());
}

async function runDiffCommand(db: Database.Database, runLabel: string, againstRunLabel: string): Promise<void> {
  const rows = db
    .prepare(
      `SELECT a.modx_id,
              a.state AS run_state,
              b.state AS against_state,
              a.reason_code AS run_reason_code,
              b.reason_code AS against_reason_code
         FROM migration_record a
         LEFT JOIN migration_record b
           ON b.modx_id = a.modx_id
          AND b.run_id = (SELECT id FROM migration_run WHERE run_label = ?)
        WHERE a.run_id = (SELECT id FROM migration_run WHERE run_label = ?)
          AND (
            b.modx_id IS NULL OR
            a.state != b.state OR
            COALESCE(a.reason_code, '') != COALESCE(b.reason_code, '')
          )
        ORDER BY a.modx_id ASC`,
    )
    .all(againstRunLabel, runLabel);
  printJson(rows);
}

async function maybeDestroyStrapi(strapi: any): Promise<void> {
  if (typeof strapi?.destroy === 'function') {
    await strapi.destroy();
  }
  delete process.env.MIGRATION_IN_PROGRESS;
}

async function wipeContentForResetDev(strapi: any): Promise<void> {
  for (const uid of [...CONTENT_UIDS, URL_MAPPING_UID]) {
    await strapi.db.query(uid).deleteMany({ where: {} });
  }
}

export async function processRun(parsed: ParsedArgs): Promise<void> {
  const mode = assertRunMode(parsed.flags.mode);
  if (mode === 'merge' && hasDirtyGitWorktree() && process.env.MIGRATION_ALLOW_DIRTY_GIT !== 'true') {
    throw new Error('dirty_git_worktree');
  }
  if (mode === 'reset-dev' && process.env.NODE_ENV === 'production') {
    throw new Error('reset_dev_refused_in_production');
  }

  const envelope = await loadExtractEnvelope(parsed.flags.extract);
  if (envelope.schema_version !== EXPECTED_EXTRACT_JSON_VERSION) {
    throw new Error('extract_json_schema_version_mismatch');
  }

  const gitSha = currentGitSha();
  const runLabel = parsed.flags.run ?? newRunId(gitSha);
  const db = new Database(LEDGER_PATH);
  const strapi = await bootStrapi(mode);
  let runDbId: number | null = null;

  try {
    ensureLedgerSchema(db);

    const expectedVerdict = readExpectedCanonicalPathVerdict();
    const observedVerdict = detectCanonicalPathVerdict(getStrapiSqlitePathFromStrapi(strapi));
    if (observedVerdict !== expectedVerdict) {
      throw new Error('canonicalpath_uniqueness_behavior_changed');
    }

    if (mode === 'reset-dev') {
      await wipeContentForResetDev(strapi);
    }

    runDbId = insertRun(db, mode, gitSha, runLabel);
    const states = seedRunFromExtract(db, runDbId, envelope);
    await reconcileWritingRows(db, strapi, runDbId);

    const lookups = buildRouteLookups(envelope.rows);
    const assetPaths = buildAssetPathSet(envelope);
    const contentSnapshots = await loadContentSnapshots(strapi);
    const urlMappingSnapshots = await loadUrlMappingSnapshots(strapi);
    const indexes = buildCanonicalUsageIndex(contentSnapshots);
    const existingLegacyOwners = new Map<string, number>();
    for (const row of envelope.rows) {
      if (!isClassifiedRow(row)) continue;
      for (const legacyPath of row.legacy_paths) {
        existingLegacyOwners.set(`${row.locale}:${legacyPath.replace(/^\/+/, '')}`, row.modx_id);
      }
    }

    const dryRunNotes: string[] = [];

    const processRow = async (row: ExtractRow, stage: string): Promise<DocumentSnapshot | null> => {
      if (!isClassifiedRow(row)) {
        return null;
      }

      const desired = buildDesiredContentPayload(row, {
        locale: row.locale,
        lookups,
        asset_paths: assetPaths,
      });
      let annotations = [...desired.annotations];
      let relationDocumentId: string | null = null;

      if (row.target_type === 'disease' || row.target_type === 'service') {
        if (row.category_modx_id != null) {
          const relationUid =
            row.target_type === 'disease'
              ? 'api::disease-category.disease-category'
              : 'api::service-category.service-category';
          const targetSnapshot = [...contentSnapshots.values()].find(
            (snapshot) =>
              snapshot.uid === relationUid &&
              snapshot.locale === row.locale &&
              snapshot.modxId === row.category_modx_id,
          );
          if (!targetSnapshot) {
            annotations.push({ reason_code: 'orphan_parent', detail: String(row.category_modx_id) });
          } else {
            relationDocumentId = targetSnapshot.documentId;
            desired.data.category = relationDocumentId;
          }
        }
      } else if (row.target_type === 'page' && row.parent_modx_id != null) {
        const parentSnapshot = [...contentSnapshots.values()].find(
          (snapshot) =>
            snapshot.uid === 'api::page.page' &&
            snapshot.locale === row.locale &&
            snapshot.modxId === row.parent_modx_id,
        );
        if (!parentSnapshot) {
          annotations.push({ reason_code: 'orphan_parent', detail: String(row.parent_modx_id) });
        } else if (parentSnapshot.modxId === row.modx_id) {
          annotations.push({ reason_code: 'circular_parent', detail: String(row.parent_modx_id) });
        } else {
          relationDocumentId = parentSnapshot.documentId;
          desired.data.parent = relationDocumentId;
        }
      }

      const resolved = resolveExistingDocumentForMerge({
        uid: desired.uid,
        locale: row.locale,
        modxId: row.modx_id,
        canonicalPath: row.canonical_path,
        indexes,
      });
      if (resolved.ok === false) {
        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'failed',
          stage,
          reasonCode: resolved.code,
          errorDetail: resolved.detail,
        });
        return null;
      }
      const existing = resolved.existing;

      const desiredNeedsReview = row.needs_review_seed || annotations.length > 0;
      applyNeedsReviewSetOnlyOnTrue(desired.data, desiredNeedsReview, existing != null);

      transitionRecord(db, states, {
        runDbId,
        modxId: row.modx_id,
        toState: 'validated',
        stage,
        needsReview: desiredNeedsReview,
      });

      const desiredPublished = row.status === 'published';
      const relationBlocked = annotations.some((annotation) =>
        ['orphan_parent', 'cross_locale_parent', 'relation_type_mismatch', 'circular_parent'].includes(
          annotation.reason_code,
        ),
      );
      if (relationBlocked) {
        delete desired.data._migrationContentHash;
      }

      const action = selectContentMergeAction({
        existing,
        desiredContentHash: relationBlocked ? null : desired.content_hash,
        desiredPublished,
        desiredNeedsReview,
        relationBlocked,
      });

      annotateRecord(db, states, {
        runDbId,
        modxId: row.modx_id,
        annotations,
      });

      if (mode === 'dry-run') {
        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'succeeded',
          stage: 'dry-run',
          attempt: 1,
          reasonCode: action === 'no_change' ? 'no_change' : action === 'create' ? 'would_create' : 'would_update',
          strapiDocId: existing?.documentId ?? `dry-run:${desired.uid}:${row.modx_id}`,
          contentHash: relationBlocked ? null : desired.content_hash,
          needsReview: desiredNeedsReview,
        });

        const simulated: DocumentSnapshot = {
          uid: desired.uid,
          documentId: existing?.documentId ?? `dry-run:${desired.uid}:${row.modx_id}`,
          locale: row.locale,
          canonicalPath: row.canonical_path,
          modxId: row.modx_id,
          _migrationContentHash: relationBlocked ? null : desired.content_hash,
          needs_review: desiredNeedsReview || existing?.needs_review || false,
          publishedAt: desiredPublished ? 'dry-run' : null,
          parentDocumentId: row.target_type === 'page' ? relationDocumentId : null,
          categoryDocumentId:
            row.target_type === 'disease' || row.target_type === 'service' ? relationDocumentId : null,
        };
        await updateSnapshotFromResult(contentSnapshots, simulated);
        indexes.byModx.set(`${desired.uid}:${row.locale}:${row.modx_id}`, simulated);
        indexes.byCanonical.set(`${desired.uid}:${row.locale}:${row.canonical_path}`, [simulated]);
        return simulated;
      }

      try {
        let documentId = existing?.documentId ?? null;
        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'writing',
          stage: stage === 'page-pass' ? 'page-write' : 'write',
          attempt: 1,
          reasonCode: action,
          contentHash: relationBlocked ? null : desired.content_hash,
          needsReview: desiredNeedsReview,
        });

        // desired.uid is a valid Strapi content-type UID at runtime; cast to any
        // because DesiredContentPayload.uid is typed as string, not the Strapi
        // ContentType union. Strapi v5 removed separate publish/unpublish methods
        // in favour of passing status on create/update.
        const strapiDocs = (strapi as any).documents(desired.uid);
        if (!existing) {
          const created = await strapiDocs.create({
            locale: row.locale,
            data: desired.data,
            status: row.status,
          });
          documentId = created.documentId;
        } else if (action === 'update') {
          await strapiDocs.update({
            documentId: existing.documentId,
            locale: row.locale,
            data: desired.data,
            status: desiredPublished ? 'published' : 'draft',
          });
          documentId = existing.documentId;
        } else {
          documentId = existing.documentId;
        }

        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'succeeded',
          stage,
          attempt: 1,
          reasonCode: action === 'no_change' ? 'no_change' : action,
          strapiDocId: documentId,
          contentHash: relationBlocked ? null : desired.content_hash,
          needsReview: desiredNeedsReview,
        });

        const snapshot: DocumentSnapshot = {
          uid: desired.uid,
          documentId: documentId!,
          locale: row.locale,
          canonicalPath: row.canonical_path,
          modxId: row.modx_id,
          _migrationContentHash: relationBlocked ? null : desired.content_hash,
          needs_review: desiredNeedsReview || existing?.needs_review || false,
          publishedAt: desiredPublished ? 'published' : null,
          parentDocumentId: row.target_type === 'page' ? relationDocumentId : null,
          categoryDocumentId:
            row.target_type === 'disease' || row.target_type === 'service' ? relationDocumentId : null,
        };
        await updateSnapshotFromResult(contentSnapshots, snapshot);
        indexes.byModx.set(`${desired.uid}:${row.locale}:${row.modx_id}`, snapshot);
        indexes.byCanonical.set(`${desired.uid}:${row.locale}:${row.canonical_path}`, [snapshot]);
        return snapshot;
      } catch (error) {
        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'failed',
          stage,
          attempt: 1,
          reasonCode: 'write_failed',
          errorDetail: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    for (const row of sortRowsForPass(lookups.by_modx_id, ['disease-category', 'service-category'])) {
      await processRow(row, 'category-pass');
    }
    for (const row of sortRowsForPass(lookups.by_modx_id, ['disease', 'service'])) {
      await processRow(row, 'entity-pass');
    }
    for (const row of sortPagesByDepth(lookups.by_modx_id)) {
      await processRow(row, 'page-pass');
    }

    for (const row of envelope.rows) {
      if (!isClassifiedRow(row)) continue;
      const uid = TARGET_UID_BY_TYPE[row.target_type];
      const target = [...contentSnapshots.values()].find(
        (snapshot) => snapshot.uid === uid && snapshot.locale === row.locale && snapshot.modxId === row.modx_id,
      );
      if (!target) {
        annotateRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          annotations: [{ reason_code: 'url_mapping_target_missing', detail: row.canonical_path }],
        });
        continue;
      }

      const mappingPlan = buildDesiredUrlMapping(row, lookups, existingLegacyOwners);
      annotateRecord(db, states, {
        runDbId,
        modxId: row.modx_id,
        annotations: mappingPlan.annotations,
      });

      const relationField = URL_MAPPING_RELATION_BY_UID[uid];
      const existingUrlMapping = urlMappingSnapshots.get(`${row.locale}:${relationField}:${target.documentId}`) ?? null;
      const desiredLegacyPaths = [...mappingPlan.desired.legacyPaths].sort();
      const action = selectUrlMappingMergeAction(existingUrlMapping, {
        ...mappingPlan.desired,
        legacyPaths: mappingPlan.desired.legacyPaths,
      });

      if (mode === 'dry-run') {
        dryRunNotes.push(`${row.modx_id}:${action}:url-mapping`);
        continue;
      }

      try {
        if (!existingUrlMapping) {
          const created = await strapi.documents(URL_MAPPING_UID).create({
            locale: row.locale,
            data: {
              path: mappingPlan.desired.path,
              type: mappingPlan.desired.type,
              isAutoGenerated: mappingPlan.desired.isAutoGenerated,
              legacyPaths: desiredLegacyPaths,
              [relationField]: target.documentId,
            },
          });
          urlMappingSnapshots.set(`${row.locale}:${relationField}:${target.documentId}`, {
            documentId: created.documentId,
            locale: row.locale,
            path: mappingPlan.desired.path,
            type: mappingPlan.desired.type,
            isAutoGenerated: mappingPlan.desired.isAutoGenerated,
            legacyPaths: desiredLegacyPaths,
            relationField,
            relationDocumentId: target.documentId,
          });
        } else if (action === 'update') {
          await strapi.documents(URL_MAPPING_UID).update({
            documentId: existingUrlMapping.documentId,
            locale: row.locale,
            data: {
              path: mappingPlan.desired.path,
              type: mappingPlan.desired.type,
              isAutoGenerated: mappingPlan.desired.isAutoGenerated,
              legacyPaths: desiredLegacyPaths,
              [relationField]: target.documentId,
            },
          });
        }
      } catch (error) {
        transitionRecord(db, states, {
          runDbId,
          modxId: row.modx_id,
          toState: 'failed',
          stage: 'url-mapping',
          attempt: 1,
          reasonCode: 'url_mapping_write_failed',
          errorDetail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const summary: RunSummary = {
      mode,
      run_id: runLabel,
      extract_run_id: envelope.run_id,
      source_row_count: envelope.source_row_count,
      succeeded_by_target_type: summarizeSucceededByTargetType(db, runDbId),
      reason_code_counts: summarizeReasonCodes(db, runDbId),
      needs_review_count: db
        .prepare(`SELECT COUNT(*) AS count FROM migration_record WHERE run_id = ? AND needs_review = 1`)
        .get(runDbId).count,
      state_counts: countRowsByState(db, runDbId),
      baseline_written: false,
      baseline_compared: false,
      notes: dryRunNotes,
    };

    const baselineResult = await maybeWriteBaseline(summary, envelope, gitSha);
    summary.baseline_written = baselineResult.written;
    summary.baseline_compared = baselineResult.compared;
    summary.notes.push(...baselineResult.notes);

    updateRunStatus(db, runDbId, 'ok', null);
    await writeRunReport(db, runDbId, summary);
  } catch (error) {
    if (runDbId !== null) {
      updateRunStatus(
        db,
        runDbId,
        error instanceof Error && error.message.includes('threshold')
          ? 'halted'
          : error instanceof Error &&
              [
                'dirty_git_worktree',
                'reset_dev_refused_in_production',
                'canonicalpath_uniqueness_behavior_changed',
                'extract_json_schema_version_mismatch',
              ].includes(error.message)
            ? 'halted'
            : 'crashed',
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  } finally {
    db.close();
    await maybeDestroyStrapi(strapi);
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'run') {
    await processRun(parsed);
    return;
  }

  const db = new Database(LEDGER_PATH, { readonly: true });
  try {
    ensureLedgerSchema(db);
    if (parsed.command === 'status') {
      await runStatusCommand(db, parsed.flags.run);
      return;
    }
    if (parsed.command === 'row') {
      const modxId = parsed.positionals[0];
      if (!modxId) throw new Error('usage: migrate-cli.ts row <modxId>');
      await runRowCommand(db, modxId);
      return;
    }
    if (parsed.command === 'failed') {
      await runFailedCommand(db, parsed.flags.run);
      return;
    }
    if (parsed.command === 'review') {
      await runReviewCommand(db, parsed.flags.run);
      return;
    }
    if (parsed.command === 'diff') {
      const runLabel = parsed.flags.run;
      const against = parsed.flags.against;
      if (!runLabel || !against) {
        throw new Error('usage: migrate-cli.ts diff --run=<run> --against=<run>');
      }
      await runDiffCommand(db, runLabel, against);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate-cli] FATAL:', error);
    process.exit(1);
  });
}
