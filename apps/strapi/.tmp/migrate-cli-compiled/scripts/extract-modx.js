"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TV_AUDIT_SQL = exports.EXTRACT_SQL = exports.UTF8_SCAN_SAMPLE_CAP = exports.ExtractHaltError = exports.DEFAULT_MYSQL_RETRY_MS = exports.DEFAULT_MYSQL_RETRY_ATTEMPTS = exports.CURRENT_RUN_PATH = exports.LEDGER_PATH = void 0;
exports.resolveAssetsRoot = resolveAssetsRoot;
exports.isAssetIncluded = isAssetIncluded;
exports.computeFileSha256 = computeFileSha256;
exports.walkAssetInventory = walkAssetInventory;
exports.emptyCounts = emptyCounts;
exports.deriveCounts = deriveCounts;
exports.deriveUtf8Scan = deriveUtf8Scan;
exports.assembleEnvelope = assembleEnvelope;
exports.serializeEnvelope = serializeEnvelope;
exports.writeExtractJson = writeExtractJson;
exports.parseCliArgs = parseCliArgs;
exports.resolveMysqlConfig = resolveMysqlConfig;
exports.connectMysql = connectMysql;
exports.connectMysqlWithRetry = connectMysqlWithRetry;
exports.fetchRawRows = fetchRawRows;
exports.fetchTvAudit = fetchTvAudit;
exports.coerceRawRow = coerceRawRow;
exports.currentGitSha = currentGitSha;
exports.newRunId = newRunId;
exports.assertSupportedContexts = assertSupportedContexts;
exports.clearCurrentRun = clearCurrentRun;
exports.seedExtractLedger = seedExtractLedger;
exports.main = main;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:stream/promises");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const extract_modx_row_1 = require("./extract-modx.row");
const extract_modx_types_1 = require("./extract-modx.types");
const ledger_schema_1 = require("./ledger-schema");
const render_run_report_1 = require("./render-run-report");
exports.LEDGER_PATH = node_path_1.default.resolve(__dirname, '.migration-ledger.sqlite');
exports.CURRENT_RUN_PATH = node_path_1.default.resolve(__dirname, '..', '..', '..', 'plans', '.migration-current-run');
exports.DEFAULT_MYSQL_RETRY_ATTEMPTS = 30;
exports.DEFAULT_MYSQL_RETRY_MS = 1000;
class ExtractHaltError extends Error {
    constructor(reason, detail) {
        super(`[extract-modx] HALT: ${reason}${detail ? ` — ${detail}` : ''}`);
        this.name = 'ExtractHaltError';
        this.reason = reason;
        this.detail = detail;
    }
}
exports.ExtractHaltError = ExtractHaltError;
/**
 * Resolve the MODX web-root path from (in precedence order): CLI arg, then
 * `MODX_ASSETS_ROOT` env var. Throws a Tier 1 halt if neither is provided.
 */
async function resolveAssetsRoot(opts) {
    var _a, _b;
    const env = (_a = opts.env) !== null && _a !== void 0 ? _a : process.env;
    const candidate = (_b = opts.cliArg) !== null && _b !== void 0 ? _b : env.MODX_ASSETS_ROOT;
    if (!candidate) {
        throw new ExtractHaltError('asset_root_not_configured', 'pass --assets-root=<path> or set MODX_ASSETS_ROOT');
    }
    const resolved = node_path_1.default.resolve(candidate);
    try {
        const stat = await node_fs_1.promises.stat(resolved);
        if (!stat.isDirectory()) {
            throw new Error(`[extract-modx] assets root is not a directory: ${resolved}`);
        }
    }
    catch (err) {
        if (err.code === 'ENOENT') {
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
function isAssetIncluded(relativePath) {
    const base = node_path_1.default.basename(relativePath);
    if (base === '.DS_Store')
        return false;
    if (base.startsWith('._'))
        return false;
    return true;
}
/** SHA256 of a file streamed from disk. Used for both dump hashing and asset hashing. */
async function computeFileSha256(filePath) {
    const hash = (0, node_crypto_1.createHash)('sha256');
    await (0, promises_1.pipeline)((0, node_fs_1.createReadStream)(filePath), hash);
    return hash.digest('hex');
}
/**
 * Recursively walk `{assetsRoot}/{subdir}` and return one
 * {@link AssetInventoryEntry} per regular file. Paths are POSIX-normalized
 * relative to `assetsRoot`. Output is sorted lexicographically.
 */
async function walkAssetInventory(assetsRoot, subdirs = extract_modx_types_1.ASSET_WALK_SUBDIRS) {
    const entries = [];
    const anomalies = [];
    const walkedDirs = [];
    for (const sub of subdirs) {
        const absSub = node_path_1.default.join(assetsRoot, sub);
        try {
            const stat = await node_fs_1.promises.stat(absSub);
            if (!stat.isDirectory())
                continue;
        }
        catch {
            continue;
        }
        walkedDirs.push(sub);
        await walkDir(absSub, assetsRoot, entries, anomalies);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    anomalies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    walkedDirs.sort();
    const stats = {
        total_count: entries.length,
        size_zero_count: entries.filter((entry) => entry.size_bytes === 0).length,
        walked_dirs: walkedDirs,
    };
    return { entries, stats, anomalies };
}
async function walkDir(absDir, assetsRoot, out, anomalies) {
    let dirents;
    try {
        dirents = await node_fs_1.promises.readdir(absDir, { withFileTypes: true });
    }
    catch (err) {
        anomalies.push({
            path: node_path_1.default.relative(assetsRoot, absDir),
            reason: 'unreadable',
            detail: err.message,
        });
        return;
    }
    for (const ent of dirents) {
        const abs = node_path_1.default.join(absDir, ent.name);
        const rel = toPosix(node_path_1.default.relative(assetsRoot, abs));
        if (!isAssetIncluded(rel))
            continue;
        if (ent.isDirectory()) {
            await walkDir(abs, assetsRoot, out, anomalies);
            continue;
        }
        if (!ent.isFile())
            continue;
        try {
            const stat = await node_fs_1.promises.stat(abs);
            const sha256 = await computeFileSha256(abs);
            out.push({ path: rel, size_bytes: stat.size, sha256 });
            if (stat.size === 0) {
                anomalies.push({ path: rel, reason: 'size_zero' });
            }
        }
        catch (err) {
            anomalies.push({
                path: rel,
                reason: 'unreadable',
                detail: err.message,
            });
        }
    }
}
function toPosix(p) {
    return p.split(node_path_1.default.sep).join('/');
}
/**
 * Zero-initialized counts. Keys are pre-seeded so every target_type / locale /
 * skip_reason appears in JSON output even when its histogram bucket is 0.
 */
function emptyCounts() {
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
function deriveCounts(rows) {
    const counts = emptyCounts();
    for (const row of rows) {
        if ('target_type' in row) {
            counts.classified++;
            counts.by_target_type[row.target_type]++;
            counts.by_locale[row.locale]++;
        }
        else {
            counts.skipped++;
            counts.by_skip_reason[row.skip_reason]++;
        }
    }
    return counts;
}
/** Cap on UTF-8 replacement-char sample ids emitted in the envelope. */
exports.UTF8_SCAN_SAMPLE_CAP = 20;
/**
 * Scan classified rows for the Unicode replacement character (U+FFFD) in any
 * text field. Records up to {@link UTF8_SCAN_SAMPLE_CAP} modx_ids for audit.
 */
function deriveUtf8Scan(rows) {
    const sample = [];
    let withBad = 0;
    let scanned = 0;
    for (const row of rows) {
        if (!('target_type' in row))
            continue;
        scanned++;
        const c = row;
        const hit = (0, extract_modx_row_1.containsReplacementChar)(c.title) ||
            (0, extract_modx_row_1.containsReplacementChar)(c.body_html) ||
            (0, extract_modx_row_1.containsReplacementChar)(c.seo_meta_title) ||
            (0, extract_modx_row_1.containsReplacementChar)(c.seo_meta_description);
        if (hit) {
            withBad++;
            if (sample.length < exports.UTF8_SCAN_SAMPLE_CAP)
                sample.push(c.modx_id);
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
function assembleEnvelope(opts) {
    var _a;
    return {
        schema_version: 1,
        run_id: opts.runId,
        git_sha: opts.gitSha,
        source_row_count: opts.sourceRowCount,
        source_dump_sha256: opts.sourceDumpSha256,
        counts: deriveCounts(opts.rows),
        tv_audit: (_a = opts.tvAudit) !== null && _a !== void 0 ? _a : [],
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
function serializeEnvelope(envelope) {
    return JSON.stringify(envelope, null, 2) + '\n';
}
async function writeExtractJson(envelope, outPath) {
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(outPath), { recursive: true });
    await node_fs_1.promises.writeFile(outPath, serializeEnvelope(envelope), 'utf8');
}
/** Minimal CLI flag parser — supports `--key=value` and `--key value`. */
function parseCliArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--'))
            continue;
        const eq = tok.indexOf('=');
        if (eq >= 0) {
            out[tok.slice(2, eq)] = tok.slice(eq + 1);
        }
        else {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                out[tok.slice(2)] = next;
                i++;
            }
            else {
                out[tok.slice(2)] = 'true';
            }
        }
    }
    return out;
}
/** Canonical SQL that yields one row per `modx_site_content` row with meta TVs. */
exports.EXTRACT_SQL = `
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
exports.TV_AUDIT_SQL = `
  SELECT tv.id AS tmplvar_id, tv.name AS name,
    (SELECT COUNT(*) FROM modx_site_tmplvar_contentvalues cv
       WHERE cv.tmplvarid = tv.id AND cv.value IS NOT NULL AND cv.value != '') AS rows_with_value
  FROM modx_site_tmplvars tv
  ORDER BY tv.id ASC
`;
function resolveMysqlConfig(env = process.env) {
    var _a, _b, _c, _d, _e;
    return {
        host: (_a = env.MYSQL_HOST) !== null && _a !== void 0 ? _a : '127.0.0.1',
        port: Number((_b = env.MYSQL_PORT) !== null && _b !== void 0 ? _b : 3307),
        user: (_c = env.MYSQL_USER) !== null && _c !== void 0 ? _c : 'root',
        password: (_d = env.MYSQL_PASSWORD) !== null && _d !== void 0 ? _d : 'modx',
        database: (_e = env.MYSQL_DATABASE) !== null && _e !== void 0 ? _e : 'modx',
    };
}
async function connectMysql(cfg) {
    const { createConnection } = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
    return createConnection({ ...cfg, charset: 'utf8mb4' });
}
async function connectMysqlWithRetry(cfg, opts = {}) {
    var _a, _b;
    const attempts = (_a = opts.attempts) !== null && _a !== void 0 ? _a : exports.DEFAULT_MYSQL_RETRY_ATTEMPTS;
    const baseDelayMs = (_b = opts.baseDelayMs) !== null && _b !== void 0 ? _b : exports.DEFAULT_MYSQL_RETRY_MS;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await connectMysql(cfg);
        }
        catch (err) {
            lastError = err;
            if (attempt === attempts)
                break;
            const delayMs = baseDelayMs * attempt;
            console.error(`[extract-modx] mysql not ready (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error('[extract-modx] failed to connect to MySQL after retries');
}
/** Read all content rows + meta TVs from the live MODX DB. */
async function fetchRawRows(conn) {
    const [rows] = await conn.query(exports.EXTRACT_SQL);
    return rows.map(coerceRawRow);
}
async function fetchTvAudit(conn) {
    const [rows] = await conn.query(exports.TV_AUDIT_SQL);
    return rows.map((row) => ({
        tmplvar_id: Number(row.tmplvar_id),
        name: String(row.name),
        rows_with_value: Number(row.rows_with_value),
    }));
}
/** Normalize mysql2's loose types (Buffer, BigInt, etc.) to RawModxRow. */
function coerceRawRow(input) {
    var _a;
    const row = input;
    const toStr = (value) => {
        if (value === null || value === undefined)
            return null;
        if (Buffer.isBuffer(value))
            return value.toString('utf8');
        return String(value);
    };
    const toNum = (value) => {
        if (typeof value === 'number')
            return value;
        if (typeof value === 'bigint')
            return Number(value);
        return Number(value !== null && value !== void 0 ? value : 0);
    };
    return {
        id: toNum(row.id),
        context_key: String((_a = row.context_key) !== null && _a !== void 0 ? _a : ''),
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
function currentGitSha() {
    try {
        return (0, node_child_process_1.execSync)('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    }
    catch {
        return 'unknown';
    }
}
/** Run id: `YYYYMMDDTHHMMSSZ-<gitsha>` (deterministic per invocation). */
function newRunId(gitSha, now = new Date()) {
    const iso = now.toISOString().replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
    return `${iso}-${gitSha}`;
}
function assertSupportedContexts(rawRows) {
    const unsupported = [...new Set(rawRows.map((row) => row.context_key).filter((ctx) => ctx !== 'web' && ctx !== 'rus'))]
        .sort();
    if (unsupported.length > 0) {
        throw new ExtractHaltError('unexpected_context_key', `only web/rus are allowed; saw ${unsupported.join(', ')}`);
    }
}
function createMigrationRun(db, gitSha, runLabel) {
    const info = db
        .prepare(`INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('extract', ?, ?)`)
        .run(gitSha, runLabel);
    return Number(info.lastInsertRowid);
}
async function writeCurrentRun(runId) {
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(exports.CURRENT_RUN_PATH), { recursive: true });
    await node_fs_1.promises.writeFile(exports.CURRENT_RUN_PATH, `${runId}\n`, 'utf8');
}
async function clearCurrentRun() {
    await node_fs_1.promises.rm(exports.CURRENT_RUN_PATH, { force: true });
}
function ledgerLocaleForRow(row) {
    if ('target_type' in row) {
        return row.locale;
    }
    const locale = (0, extract_modx_row_1.classifyContextKey)(row.modx_raw.context_key);
    if (!locale) {
        throw new ExtractHaltError('unexpected_context_key', `only web/rus are allowed; saw ${row.modx_raw.context_key}`);
    }
    return locale;
}
function seedExtractLedger(db, runDbId, rows) {
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
function setRunTerminalStatus(db, runDbId, exitStatus, haltReason) {
    db.prepare(`UPDATE migration_run
        SET exit_status = ?, halt_reason = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`).run(exitStatus, haltReason, runDbId);
}
/** CLI entry. Accepts `--assets-root`, `--dump`, `--out`, `--run-id`. */
async function main(argv = process.argv.slice(2)) {
    var _a, _b, _c;
    const flags = parseCliArgs(argv);
    const dumpPath = node_path_1.default.resolve((_a = flags.dump) !== null && _a !== void 0 ? _a : node_path_1.default.join(__dirname, '..', '..', '..', 'ce39229_myorl.sql'));
    const outPath = node_path_1.default.resolve((_b = flags.out) !== null && _b !== void 0 ? _b : node_path_1.default.join(__dirname, '..', '..', '..', 'plans', 'modx-extract.json'));
    const gitSha = currentGitSha();
    const runLabel = (_c = flags['run-id']) !== null && _c !== void 0 ? _c : newRunId(gitSha);
    const mysqlCfg = resolveMysqlConfig();
    console.error(`[extract-modx] dump=${dumpPath}`);
    console.error(`[extract-modx] out=${outPath}`);
    console.error(`[extract-modx] mysql=${mysqlCfg.host}:${mysqlCfg.port}/${mysqlCfg.database}`);
    console.error(`[extract-modx] run_id=${runLabel} git_sha=${gitSha}`);
    const db = new better_sqlite3_1.default(exports.LEDGER_PATH);
    let runDbId = null;
    try {
        (0, ledger_schema_1.ensureLedgerSchema)(db);
        runDbId = createMigrationRun(db, gitSha, runLabel);
        await writeCurrentRun(runLabel);
        const assetsRoot = await resolveAssetsRoot({ cliArg: flags['assets-root'] });
        console.error(`[extract-modx] assets_root=${assetsRoot}`);
        const sourceDumpSha256 = await computeFileSha256(dumpPath);
        console.error(`[extract-modx] source_dump_sha256=${sourceDumpSha256}`);
        const conn = await connectMysqlWithRetry(mysqlCfg);
        let rows;
        let tvAudit;
        try {
            const rawRows = await fetchRawRows(conn);
            console.error(`[extract-modx] fetched ${rawRows.length} rows`);
            assertSupportedContexts(rawRows);
            rows = rawRows.map(extract_modx_row_1.classifyRow);
            seedExtractLedger(db, runDbId, rows);
            tvAudit = await fetchTvAudit(conn);
            console.error(`[extract-modx] tv_audit: ${tvAudit.length} template variables`);
            const { entries, stats, anomalies } = await walkAssetInventory(assetsRoot);
            console.error(`[extract-modx] asset_inventory: ${entries.length} files across ${stats.walked_dirs.length} dirs`);
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
            const report = await (0, render_run_report_1.writeRunReport)(db, runLabel, envelope);
            console.error(`[extract-modx] wrote ${report.markdownPath}`);
            console.error(`[extract-modx] wrote ${report.jsonPath}`);
            console.error(`[extract-modx] counts: classified=${envelope.counts.classified} skipped=${envelope.counts.skipped}`);
        }
        finally {
            await conn.end();
        }
    }
    catch (err) {
        if (runDbId !== null) {
            const isHalt = err instanceof ExtractHaltError || err instanceof ledger_schema_1.LedgerHaltError;
            const haltReason = isHalt
                ? err.reason
                : err instanceof Error
                    ? err.message
                    : 'unknown_error';
            try {
                setRunTerminalStatus(db, runDbId, isHalt ? 'halted' : 'crashed', haltReason);
            }
            catch {
                // Best-effort status update only.
            }
        }
        await clearCurrentRun();
        throw err;
    }
    finally {
        db.close();
    }
}
if (require.main === module) {
    main().catch((err) => {
        console.error('[extract-modx] FATAL:', err);
        process.exit(1);
    });
}
