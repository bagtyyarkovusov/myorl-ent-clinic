"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strapi_1 = require("@strapi/strapi");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const extract_modx_1 = require("./extract-modx");
const ledger_schema_1 = require("./ledger-schema");
const halt_thresholds_1 = require("./halt-thresholds");
const migration_1 = require("../src/lib/migration");
const APP_DIR = node_path_1.default.resolve(__dirname, '..');
const BASELINE_PATH = node_path_1.default.resolve(__dirname, '..', '..', '..', 'plans', 'migration-reports', 'baseline.json');
const CANONICALPATH_BASELINE_PATH = node_path_1.default.resolve(__dirname, '..', '..', '..', 'plans', 'verification', 'canonicalpath-uniqueness-2026-04-19.txt');
const URL_MAPPING_UID = 'api::url-mapping.url-mapping';
const CONTENT_UIDS = [
    'api::page.page',
    'api::disease.disease',
    'api::disease-category.disease-category',
    'api::service.service',
    'api::service-category.service-category',
];
const ROUTING_LOCALES = ['el', 'ru'];
const URL_MAPPING_RELATION_BY_UID = {
    'api::page.page': 'page',
    'api::disease.disease': 'disease',
    'api::disease-category.disease-category': 'disease_category',
    'api::service.service': 'service',
    'api::service-category.service-category': 'service_category',
};
function parseArgs(argv) {
    var _a;
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            if (eq >= 0) {
                flags[token.slice(2, eq)] = token.slice(eq + 1);
            }
            else {
                const next = argv[i + 1];
                if (next && !next.startsWith('--')) {
                    flags[token.slice(2)] = next;
                    i++;
                }
                else {
                    flags[token.slice(2)] = 'true';
                }
            }
            continue;
        }
        if (token === '--')
            continue;
        positionals.push(token);
    }
    const command = (_a = positionals[0]) !== null && _a !== void 0 ? _a : 'run';
    if (!['run', 'status', 'row', 'failed', 'review', 'diff'].includes(command)) {
        return { command: 'run', flags, positionals };
    }
    return {
        command,
        flags,
        positionals: command === 'run' ? positionals : positionals.slice(1),
    };
}
function assertRunMode(value) {
    if (value === 'dry-run' || value === 'merge' || value === 'reset-dev') {
        return value;
    }
    throw new Error('usage: migrate-cli.ts --mode=<dry-run|merge|reset-dev>');
}
function hasDirtyGitWorktree() {
    try {
        return (0, node_child_process_1.execSync)('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    }
    catch {
        return false;
    }
}
function detectCanonicalPathVerdict(dbPath) {
    const db = new better_sqlite3_1.default(dbPath, { readonly: true });
    try {
        const tables = ['pages', 'diseases', 'disease_categories', 'services', 'service_categories'];
        let sawGlobal = false;
        let sawPerLocale = false;
        for (const table of tables) {
            const tableRow = db
                .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
                .get(table);
            if (!(tableRow === null || tableRow === void 0 ? void 0 : tableRow.sql))
                continue;
            const indexes = db
                .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
                .all(table);
            for (const idx of indexes) {
                if (!idx.sql || !/UNIQUE/i.test(idx.sql) || !/canonical_path/.test(idx.sql))
                    continue;
                const match = idx.sql.match(/\(([^)]+)\)/);
                const cols = match ? match[1].split(',').map((col) => col.replace(/[`"]/g, '').trim()) : [];
                if (cols.includes('locale')) {
                    sawPerLocale = true;
                }
                else if (cols.length === 1 && cols[0] === 'canonical_path') {
                    sawGlobal = true;
                }
            }
            if (/UNIQUE\s*\([^)]*canonical_path[^)]*\)/i.test(tableRow.sql)) {
                sawGlobal = true;
            }
        }
        if (sawGlobal)
            return 'global';
        if (sawPerLocale)
            return 'per-locale';
        return 'none';
    }
    finally {
        db.close();
    }
}
function readExpectedCanonicalPathVerdict() {
    const text = (0, node_fs_1.existsSync)(CANONICALPATH_BASELINE_PATH)
        ? (0, node_child_process_1.execSync)(`cat ${JSON.stringify(CANONICALPATH_BASELINE_PATH)}`, { encoding: 'utf8' })
        : '';
    if (text.includes('OVERALL VERDICT: global'))
        return 'global';
    if (text.includes('OVERALL VERDICT: per-locale'))
        return 'per-locale';
    return 'none';
}
function getStrapiDbPath() {
    var _a;
    return node_path_1.default.join(APP_DIR, '.tmp', (_a = process.env.DATABASE_FILENAME) !== null && _a !== void 0 ? _a : 'data.db');
}
async function bootStrapi(mode) {
    process.env.APP_KEYS = process.env.APP_KEYS || 'migration_key_a,migration_key_b';
    process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'migration_admin_jwt_secret';
    process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'migration_api_token_salt';
    process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'migration_transfer_token_salt';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'migration_jwt_secret';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'migration_encryption_key';
    process.env.NODE_ENV = process.env.NODE_ENV || 'development';
    if (mode === 'merge' || mode === 'reset-dev') {
        process.env.MIGRATION_IN_PROGRESS = 'true';
    }
    else {
        delete process.env.MIGRATION_IN_PROGRESS;
    }
    const { appDir, distDir } = await (0, strapi_1.compileStrapi)({ appDir: APP_DIR });
    return (0, strapi_1.createStrapi)({ appDir, distDir, autoReload: false, serveAdminPanel: false }).load();
}
function insertRun(db, mode, gitSha, runLabel) {
    const info = db
        .prepare(`INSERT INTO migration_run (mode, git_sha, run_label) VALUES (?, ?, ?)`)
        .run(mode, gitSha, runLabel);
    return Number(info.lastInsertRowid);
}
function updateRunStatus(db, runDbId, exitStatus, haltReason) {
    db.prepare(`UPDATE migration_run
        SET exit_status = ?, halt_reason = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?`).run(exitStatus, haltReason, runDbId);
}
function appendEvent(db, args) {
    var _a, _b;
    db.prepare(`INSERT INTO migration_event (
      run_id, modx_id, from_state, to_state, stage, attempt, reason_code, error_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(args.runDbId, args.modxId, args.fromState, args.toState, args.stage, args.attempt, (_a = args.reasonCode) !== null && _a !== void 0 ? _a : null, (_b = args.errorDetail) !== null && _b !== void 0 ? _b : null);
}
function seedRunFromExtract(db, runDbId, envelope) {
    const insertRecord = db.prepare(`
    INSERT INTO migration_record (
      run_id, modx_id, locale, target_type, state, stage, reason_code, needs_review
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const states = new Map();
    for (const row of envelope.rows) {
        const locale = (0, migration_1.isClassifiedRow)(row)
            ? row.locale
            : row.modx_raw.context_key === 'rus'
                ? 'ru'
                : 'el';
        const targetType = (0, migration_1.isClassifiedRow)(row) ? row.target_type : 'unknown';
        const state = (0, migration_1.isClassifiedRow)(row) ? 'classified' : 'skipped';
        const reasonCode = (0, migration_1.isClassifiedRow)(row) ? null : row.skip_reason;
        const needsReview = (0, migration_1.isClassifiedRow)(row) && row.needs_review_seed ? 1 : 0;
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
function transitionRecord(db, states, args) {
    var _a, _b, _c, _d, _e, _f, _g;
    const currentState = (_a = states.get(args.modxId)) !== null && _a !== void 0 ? _a : null;
    db.prepare(`UPDATE migration_record
        SET state = ?,
            stage = ?,
            attempts = ?,
            reason_code = ?,
            last_error = ?,
            strapi_doc_id = COALESCE(?, strapi_doc_id),
            content_hash = COALESCE(?, content_hash),
            needs_review = CASE WHEN ? IS NULL THEN needs_review ELSE ? END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE run_id = ? AND modx_id = ?`).run(args.toState, args.stage, (_b = args.attempt) !== null && _b !== void 0 ? _b : 0, (_c = args.reasonCode) !== null && _c !== void 0 ? _c : null, (_d = args.errorDetail) !== null && _d !== void 0 ? _d : null, (_e = args.strapiDocId) !== null && _e !== void 0 ? _e : null, (_f = args.contentHash) !== null && _f !== void 0 ? _f : null, args.needsReview === undefined ? null : args.needsReview ? 1 : 0, args.needsReview === undefined ? null : args.needsReview ? 1 : 0, args.runDbId, args.modxId);
    appendEvent(db, {
        runDbId: args.runDbId,
        modxId: args.modxId,
        fromState: currentState,
        toState: args.toState,
        stage: args.stage,
        attempt: (_g = args.attempt) !== null && _g !== void 0 ? _g : 0,
        reasonCode: args.reasonCode,
        errorDetail: args.errorDetail,
    });
    states.set(args.modxId, args.toState);
}
function annotateRecord(db, states, args) {
    var _a, _b, _c;
    const currentState = (_a = states.get(args.modxId)) !== null && _a !== void 0 ? _a : null;
    for (const annotation of args.annotations) {
        appendEvent(db, {
            runDbId: args.runDbId,
            modxId: args.modxId,
            fromState: currentState,
            toState: currentState !== null && currentState !== void 0 ? currentState : 'classified',
            stage: 'annotate',
            attempt: (_b = args.attempt) !== null && _b !== void 0 ? _b : 0,
            reasonCode: annotation.reason_code,
            errorDetail: (_c = annotation.detail) !== null && _c !== void 0 ? _c : null,
        });
    }
}
async function loadContentSnapshots(strapi) {
    var _a, _b, _c, _d, _e, _f, _g;
    const map = new Map();
    for (const uid of CONTENT_UIDS) {
        const rows = (await strapi.db.query(uid).findMany({
            populate: {
                parent: true,
                category: true,
                seo: true,
            },
        }));
        for (const row of rows) {
            const snapshot = {
                uid,
                documentId: row.documentId,
                locale: row.locale,
                canonicalPath: row.canonicalPath,
                modxId: (_a = row.modxId) !== null && _a !== void 0 ? _a : null,
                _migrationContentHash: (_b = row._migrationContentHash) !== null && _b !== void 0 ? _b : null,
                needs_review: Boolean(row.needs_review),
                publishedAt: (_c = row.publishedAt) !== null && _c !== void 0 ? _c : null,
                parentDocumentId: (_e = (_d = row.parent) === null || _d === void 0 ? void 0 : _d.documentId) !== null && _e !== void 0 ? _e : null,
                categoryDocumentId: (_g = (_f = row.category) === null || _f === void 0 ? void 0 : _f.documentId) !== null && _g !== void 0 ? _g : null,
            };
            map.set(`${uid}:${snapshot.locale}:${snapshot.documentId}`, snapshot);
        }
    }
    return map;
}
async function loadUrlMappingSnapshots(strapi) {
    var _a, _b, _c;
    const map = new Map();
    const rows = (await strapi.db.query(URL_MAPPING_UID).findMany({
        populate: {
            page: true,
            disease: true,
            disease_category: true,
            service: true,
            service_category: true,
        },
    }));
    for (const row of rows) {
        const relationField = (_a = ['page', 'disease', 'disease_category', 'service', 'service_category'].find((field) => { var _a; return (_a = row[field]) === null || _a === void 0 ? void 0 : _a.documentId; })) !== null && _a !== void 0 ? _a : null;
        const relationDocumentId = relationField ? (_c = (_b = row[relationField]) === null || _b === void 0 ? void 0 : _b.documentId) !== null && _c !== void 0 ? _c : null : null;
        const snapshot = {
            documentId: row.documentId,
            locale: row.locale,
            path: row.path,
            type: row.type,
            isAutoGenerated: Boolean(row.isAutoGenerated),
            legacyPaths: Array.isArray(row.legacyPaths) ? [...row.legacyPaths].sort() : [],
            relationField,
            relationDocumentId,
        };
        map.set(`${snapshot.locale}:${relationField !== null && relationField !== void 0 ? relationField : 'none'}:${relationDocumentId !== null && relationDocumentId !== void 0 ? relationDocumentId : snapshot.documentId}`, snapshot);
    }
    return map;
}
function buildCanonicalUsageIndex(contentSnapshots) {
    var _a;
    const byCanonical = new Map();
    const byModx = new Map();
    const byUidAndDocument = new Map();
    for (const snapshot of contentSnapshots.values()) {
        const canonicalKey = `${snapshot.uid}:${snapshot.locale}:${snapshot.canonicalPath}`;
        const current = (_a = byCanonical.get(canonicalKey)) !== null && _a !== void 0 ? _a : [];
        current.push(snapshot);
        byCanonical.set(canonicalKey, current);
        if (snapshot.modxId !== null) {
            byModx.set(`${snapshot.uid}:${snapshot.locale}:${snapshot.modxId}`, snapshot);
        }
        byUidAndDocument.set(`${snapshot.uid}:${snapshot.documentId}:${snapshot.locale}`, snapshot);
    }
    return { byCanonical, byModx, byUidAndDocument };
}
function sortRowsForPass(rows, targetTypes) {
    return [...rows.values()]
        .filter((row) => targetTypes.includes(row.target_type))
        .sort((a, b) => a.modx_id - b.modx_id);
}
function sortPagesByDepth(rows) {
    const pages = [...rows.values()].filter((row) => row.target_type === 'page');
    const depthCache = new Map();
    const getDepth = (row, stack = new Set()) => {
        if (depthCache.has(row.modx_id))
            return depthCache.get(row.modx_id);
        if (row.parent_modx_id == null)
            return 0;
        if (stack.has(row.modx_id))
            return 1000;
        const parent = rows.get(row.parent_modx_id);
        if (!parent || parent.target_type !== 'page')
            return 1;
        stack.add(row.modx_id);
        const depth = getDepth(parent, stack) + 1;
        stack.delete(row.modx_id);
        depthCache.set(row.modx_id, depth);
        return depth;
    };
    return pages.sort((a, b) => {
        const depthDelta = getDepth(a) - getDepth(b);
        return depthDelta !== 0 ? depthDelta : a.modx_id - b.modx_id;
    });
}
async function reconcileWritingRows(db, strapi, currentRunDbId) {
    const writingRows = db
        .prepare(`SELECT mr.run_id, mr.modx_id, mr.locale, mr.target_type, mr.content_hash
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.state = 'writing' AND mr.run_id != ?
        ORDER BY mr.run_id ASC, mr.modx_id ASC`)
        .all(currentRunDbId);
    for (const row of writingRows) {
        const uid = migration_1.TARGET_UID_BY_TYPE[row.target_type];
        if (!uid)
            continue;
        const existing = await strapi.documents(uid).findFirst({
            filters: { modxId: { $eq: row.modx_id } },
            locale: row.locale,
        });
        const nextState = existing && existing._migrationContentHash === row.content_hash ? 'succeeded' : 'failed';
        const reasonCode = nextState === 'failed' ? 'crashed_before_write' : 'reconciled_after_crash';
        db.prepare(`UPDATE migration_record
          SET state = ?, stage = 'reconcile', reason_code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE run_id = ? AND modx_id = ?`).run(nextState, reasonCode, row.run_id, row.modx_id);
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
async function updateSnapshotFromResult(contentSnapshots, snapshot) {
    contentSnapshots.set(`${snapshot.uid}:${snapshot.locale}:${snapshot.documentId}`, snapshot);
}
function countRowsByState(db, runDbId) {
    const rows = db
        .prepare(`SELECT state, COUNT(*) AS count FROM migration_record WHERE run_id = ? GROUP BY state`)
        .all(runDbId);
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}
function summarizeReasonCodes(db, runDbId) {
    const rows = db
        .prepare(`SELECT reason_code, COUNT(*) AS count
         FROM migration_event
        WHERE run_id = ? AND reason_code IS NOT NULL
        GROUP BY reason_code
        ORDER BY reason_code`)
        .all(runDbId);
    return Object.fromEntries(rows.map((row) => [row.reason_code, row.count]));
}
function summarizeSucceededByTargetType(db, runDbId) {
    const rows = db
        .prepare(`SELECT target_type, COUNT(*) AS count
         FROM migration_record
        WHERE run_id = ? AND state = 'succeeded'
        GROUP BY target_type
        ORDER BY target_type`)
        .all(runDbId);
    return Object.fromEntries(rows.map((row) => [row.target_type, row.count]));
}
async function maybeWriteBaseline(summary, envelope, gitSha) {
    var _a;
    const notes = [];
    if (!(0, node_fs_1.existsSync)(BASELINE_PATH)) {
        if (summary.mode === 'dry-run') {
            const baseline = {
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
            await node_fs_1.promises.mkdir(node_path_1.default.dirname(BASELINE_PATH), { recursive: true });
            await node_fs_1.promises.writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
            notes.push(`baseline written to ${BASELINE_PATH}`);
            return { written: true, compared: false, notes };
        }
        notes.push('baseline missing; merge run continues with warning');
        return { written: false, compared: false, notes };
    }
    const baseline = JSON.parse(await node_fs_1.promises.readFile(BASELINE_PATH, 'utf8'));
    for (const [targetType, expected] of Object.entries(baseline.succeeded_by_target_type)) {
        const actual = (_a = summary.succeeded_by_target_type[targetType]) !== null && _a !== void 0 ? _a : 0;
        if ((0, halt_thresholds_1.exceedsSucceededDelta)(expected, actual)) {
            throw new Error(`baseline_succeeded_delta_exceeded:${targetType}`);
        }
    }
    const thresholds = (0, halt_thresholds_1.parseReasonCodeThresholdOverrides)(process.env.MIGRATION_REASON_THRESHOLDS);
    for (const [reasonCode, count] of Object.entries(summary.reason_code_counts)) {
        if ((0, halt_thresholds_1.shouldPromoteReasonCode)(reasonCode, count, summary.source_row_count, thresholds)) {
            throw new Error(`reason_code_threshold_exceeded:${reasonCode}`);
        }
    }
    notes.push(`baseline compared against ${BASELINE_PATH}`);
    return { written: false, compared: true, notes };
}
async function writeRunReport(db, runDbId, summary) {
    var _a, _b, _c;
    const row = db
        .prepare(`SELECT started_at, finished_at, exit_status, halt_reason, git_sha
         FROM migration_run
        WHERE id = ?`)
        .get(runDbId);
    const reportDir = node_path_1.default.resolve(__dirname, '..', '..', '..', 'plans', 'migration-reports');
    await node_fs_1.promises.mkdir(reportDir, { recursive: true });
    const jsonPath = node_path_1.default.join(reportDir, `run-${summary.run_id}.json`);
    const markdownPath = node_path_1.default.join(reportDir, `run-${summary.run_id}.md`);
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
        `- finished_at: ${(_a = row.finished_at) !== null && _a !== void 0 ? _a : 'null'}`,
        `- exit_status: ${(_b = row.exit_status) !== null && _b !== void 0 ? _b : 'null'}`,
        `- halt_reason: ${(_c = row.halt_reason) !== null && _c !== void 0 ? _c : 'null'}`,
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
    await node_fs_1.promises.writeFile(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await node_fs_1.promises.writeFile(markdownPath, markdown, 'utf8');
}
function printJson(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
async function runStatusCommand(db, runLabel) {
    const row = runLabel
        ? db
            .prepare(`SELECT * FROM migration_run WHERE run_label = ?`)
            .get(runLabel)
        : db
            .prepare(`SELECT * FROM migration_run ORDER BY started_at DESC LIMIT 1`)
            .get();
    printJson(row !== null && row !== void 0 ? row : null);
}
async function runRowCommand(db, modxIdRaw) {
    const modxId = Number(modxIdRaw);
    const records = db
        .prepare(`SELECT r.run_label, mr.*
         FROM migration_record mr
         JOIN migration_run r ON r.id = mr.run_id
        WHERE mr.modx_id = ?
        ORDER BY mr.run_id ASC`)
        .all(modxId);
    const events = db
        .prepare(`SELECT r.run_label, me.*
         FROM migration_event me
         JOIN migration_run r ON r.id = me.run_id
        WHERE me.modx_id = ?
        ORDER BY me.id ASC`)
        .all(modxId);
    printJson({ records, events });
}
async function runFailedCommand(db, runLabel) {
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
async function runReviewCommand(db, runLabel) {
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
async function runDiffCommand(db, runLabel, againstRunLabel) {
    const rows = db
        .prepare(`SELECT a.modx_id,
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
        ORDER BY a.modx_id ASC`)
        .all(againstRunLabel, runLabel);
    printJson(rows);
}
async function maybeDestroyStrapi(strapi) {
    if (typeof (strapi === null || strapi === void 0 ? void 0 : strapi.destroy) === 'function') {
        await strapi.destroy();
    }
    delete process.env.MIGRATION_IN_PROGRESS;
}
async function wipeContentForResetDev(strapi) {
    for (const uid of [...CONTENT_UIDS, URL_MAPPING_UID]) {
        await strapi.db.query(uid).deleteMany({ where: {} });
    }
}
async function processRun(parsed) {
    var _a, _b;
    const mode = assertRunMode(parsed.flags.mode);
    if (mode === 'merge' && hasDirtyGitWorktree()) {
        throw new Error('dirty_git_worktree');
    }
    if (mode === 'reset-dev' && process.env.NODE_ENV === 'production') {
        throw new Error('reset_dev_refused_in_production');
    }
    const envelope = await (0, migration_1.loadExtractEnvelope)(parsed.flags.extract);
    if (envelope.schema_version !== migration_1.EXPECTED_EXTRACT_JSON_VERSION) {
        throw new Error('extract_json_schema_version_mismatch');
    }
    const gitSha = (0, extract_modx_1.currentGitSha)();
    const runLabel = (_a = parsed.flags.run) !== null && _a !== void 0 ? _a : (0, extract_modx_1.newRunId)(gitSha);
    const db = new better_sqlite3_1.default(extract_modx_1.LEDGER_PATH);
    const strapi = await bootStrapi(mode);
    let runDbId = null;
    try {
        (0, ledger_schema_1.ensureLedgerSchema)(db);
        const expectedVerdict = readExpectedCanonicalPathVerdict();
        const observedVerdict = detectCanonicalPathVerdict(getStrapiDbPath());
        if (observedVerdict !== expectedVerdict) {
            throw new Error('canonicalpath_uniqueness_behavior_changed');
        }
        if (mode === 'reset-dev') {
            await wipeContentForResetDev(strapi);
        }
        runDbId = insertRun(db, mode, gitSha, runLabel);
        const states = seedRunFromExtract(db, runDbId, envelope);
        await reconcileWritingRows(db, strapi, runDbId);
        const lookups = (0, migration_1.buildRouteLookups)(envelope.rows);
        const assetPaths = (0, migration_1.buildAssetPathSet)(envelope);
        const contentSnapshots = await loadContentSnapshots(strapi);
        const urlMappingSnapshots = await loadUrlMappingSnapshots(strapi);
        const indexes = buildCanonicalUsageIndex(contentSnapshots);
        const existingLegacyOwners = new Map();
        for (const row of envelope.rows) {
            if (!(0, migration_1.isClassifiedRow)(row))
                continue;
            for (const legacyPath of row.legacy_paths) {
                existingLegacyOwners.set(`${row.locale}:${legacyPath.replace(/^\/+/, '')}`, row.modx_id);
            }
        }
        const dryRunNotes = [];
        const processRow = async (row, stage) => {
            var _a, _b, _c, _d, _e;
            if (!(0, migration_1.isClassifiedRow)(row)) {
                return null;
            }
            const desired = (0, migration_1.buildDesiredContentPayload)(row, {
                locale: row.locale,
                lookups,
                asset_paths: assetPaths,
            });
            let annotations = [...desired.annotations];
            let relationDocumentId = null;
            if (row.target_type === 'disease' || row.target_type === 'service') {
                if (row.category_modx_id != null) {
                    const relationUid = row.target_type === 'disease'
                        ? 'api::disease-category.disease-category'
                        : 'api::service-category.service-category';
                    const targetSnapshot = [...contentSnapshots.values()].find((snapshot) => snapshot.uid === relationUid &&
                        snapshot.locale === row.locale &&
                        snapshot.modxId === row.category_modx_id);
                    if (!targetSnapshot) {
                        annotations.push({ reason_code: 'orphan_parent', detail: String(row.category_modx_id) });
                    }
                    else {
                        relationDocumentId = targetSnapshot.documentId;
                        desired.data.category = relationDocumentId;
                    }
                }
            }
            else if (row.target_type === 'page' && row.parent_modx_id != null) {
                const parentSnapshot = [...contentSnapshots.values()].find((snapshot) => snapshot.uid === 'api::page.page' &&
                    snapshot.locale === row.locale &&
                    snapshot.modxId === row.parent_modx_id);
                if (!parentSnapshot) {
                    annotations.push({ reason_code: 'orphan_parent', detail: String(row.parent_modx_id) });
                }
                else if (parentSnapshot.modxId === row.modx_id) {
                    annotations.push({ reason_code: 'circular_parent', detail: String(row.parent_modx_id) });
                }
                else {
                    relationDocumentId = parentSnapshot.documentId;
                    desired.data.parent = relationDocumentId;
                }
            }
            const canonicalCandidates = (_a = indexes.byCanonical.get(`${desired.uid}:${row.locale}:${row.canonical_path}`)) !== null && _a !== void 0 ? _a : [];
            let existing = (_b = indexes.byModx.get(`${desired.uid}:${row.locale}:${row.modx_id}`)) !== null && _b !== void 0 ? _b : null;
            if (!existing && canonicalCandidates.length > 1) {
                transitionRecord(db, states, {
                    runDbId,
                    modxId: row.modx_id,
                    toState: 'failed',
                    stage,
                    reasonCode: 'ambiguous_backfill_match',
                    errorDetail: `${canonicalCandidates.length} candidates`,
                });
                return null;
            }
            if (!existing && canonicalCandidates.length === 1) {
                existing = canonicalCandidates[0];
            }
            const collisionOwner = canonicalCandidates.find((candidate) => !existing || candidate.documentId !== existing.documentId);
            if (collisionOwner && !existing) {
                transitionRecord(db, states, {
                    runDbId,
                    modxId: row.modx_id,
                    toState: 'failed',
                    stage,
                    reasonCode: 'canonical_path_collision',
                    errorDetail: collisionOwner.documentId,
                });
                return null;
            }
            const desiredNeedsReview = row.needs_review_seed || annotations.length > 0;
            if (!desiredNeedsReview && existing) {
                delete desired.data.needs_review;
            }
            transitionRecord(db, states, {
                runDbId,
                modxId: row.modx_id,
                toState: 'validated',
                stage,
                needsReview: desiredNeedsReview,
            });
            const desiredPublished = row.status === 'published';
            const statusMatches = Boolean(existing === null || existing === void 0 ? void 0 : existing.publishedAt) === desiredPublished;
            const needsReviewUpdate = desiredNeedsReview && !(existing === null || existing === void 0 ? void 0 : existing.needs_review);
            const relationBlocked = annotations.some((annotation) => ['orphan_parent', 'cross_locale_parent', 'relation_type_mismatch', 'circular_parent'].includes(annotation.reason_code));
            if (relationBlocked) {
                delete desired.data._migrationContentHash;
            }
            const hashMatches = !relationBlocked &&
                (existing === null || existing === void 0 ? void 0 : existing._migrationContentHash) != null &&
                existing._migrationContentHash === desired.content_hash;
            const action = !existing
                ? 'create'
                : hashMatches && !needsReviewUpdate && statusMatches
                    ? 'no_change'
                    : 'update';
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
                    strapiDocId: (_c = existing === null || existing === void 0 ? void 0 : existing.documentId) !== null && _c !== void 0 ? _c : `dry-run:${desired.uid}:${row.modx_id}`,
                    contentHash: relationBlocked ? null : desired.content_hash,
                    needsReview: desiredNeedsReview,
                });
                const simulated = {
                    uid: desired.uid,
                    documentId: (_d = existing === null || existing === void 0 ? void 0 : existing.documentId) !== null && _d !== void 0 ? _d : `dry-run:${desired.uid}:${row.modx_id}`,
                    locale: row.locale,
                    canonicalPath: row.canonical_path,
                    modxId: row.modx_id,
                    _migrationContentHash: relationBlocked ? null : desired.content_hash,
                    needs_review: desiredNeedsReview || (existing === null || existing === void 0 ? void 0 : existing.needs_review) || false,
                    publishedAt: desiredPublished ? 'dry-run' : null,
                    parentDocumentId: row.target_type === 'page' ? relationDocumentId : null,
                    categoryDocumentId: row.target_type === 'disease' || row.target_type === 'service' ? relationDocumentId : null,
                };
                await updateSnapshotFromResult(contentSnapshots, simulated);
                indexes.byModx.set(`${desired.uid}:${row.locale}:${row.modx_id}`, simulated);
                indexes.byCanonical.set(`${desired.uid}:${row.locale}:${row.canonical_path}`, [simulated]);
                return simulated;
            }
            try {
                let documentId = (_e = existing === null || existing === void 0 ? void 0 : existing.documentId) !== null && _e !== void 0 ? _e : null;
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
                const strapiDocs = strapi.documents(desired.uid);
                if (!existing) {
                    const created = await strapiDocs.create({
                        locale: row.locale,
                        data: desired.data,
                        status: row.status,
                    });
                    documentId = created.documentId;
                }
                else if (action === 'update') {
                    await strapiDocs.update({
                        documentId: existing.documentId,
                        locale: row.locale,
                        data: desired.data,
                        status: desiredPublished ? 'published' : 'draft',
                    });
                    documentId = existing.documentId;
                }
                else {
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
                const snapshot = {
                    uid: desired.uid,
                    documentId: documentId,
                    locale: row.locale,
                    canonicalPath: row.canonical_path,
                    modxId: row.modx_id,
                    _migrationContentHash: relationBlocked ? null : desired.content_hash,
                    needs_review: desiredNeedsReview || (existing === null || existing === void 0 ? void 0 : existing.needs_review) || false,
                    publishedAt: desiredPublished ? 'published' : null,
                    parentDocumentId: row.target_type === 'page' ? relationDocumentId : null,
                    categoryDocumentId: row.target_type === 'disease' || row.target_type === 'service' ? relationDocumentId : null,
                };
                await updateSnapshotFromResult(contentSnapshots, snapshot);
                indexes.byModx.set(`${desired.uid}:${row.locale}:${row.modx_id}`, snapshot);
                indexes.byCanonical.set(`${desired.uid}:${row.locale}:${row.canonical_path}`, [snapshot]);
                return snapshot;
            }
            catch (error) {
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
            if (!(0, migration_1.isClassifiedRow)(row))
                continue;
            const uid = migration_1.TARGET_UID_BY_TYPE[row.target_type];
            const target = [...contentSnapshots.values()].find((snapshot) => snapshot.uid === uid && snapshot.locale === row.locale && snapshot.modxId === row.modx_id);
            if (!target) {
                annotateRecord(db, states, {
                    runDbId,
                    modxId: row.modx_id,
                    annotations: [{ reason_code: 'url_mapping_target_missing', detail: row.canonical_path }],
                });
                continue;
            }
            const mappingPlan = (0, migration_1.buildDesiredUrlMapping)(row, lookups, existingLegacyOwners);
            annotateRecord(db, states, {
                runDbId,
                modxId: row.modx_id,
                annotations: mappingPlan.annotations,
            });
            const relationField = URL_MAPPING_RELATION_BY_UID[uid];
            const existingUrlMapping = (_b = urlMappingSnapshots.get(`${row.locale}:${relationField}:${target.documentId}`)) !== null && _b !== void 0 ? _b : null;
            const desiredLegacyPaths = [...mappingPlan.desired.legacyPaths].sort();
            const action = !existingUrlMapping
                ? 'create'
                : existingUrlMapping.path === mappingPlan.desired.path &&
                    existingUrlMapping.type === mappingPlan.desired.type &&
                    existingUrlMapping.isAutoGenerated === mappingPlan.desired.isAutoGenerated &&
                    JSON.stringify(existingUrlMapping.legacyPaths) === JSON.stringify(desiredLegacyPaths)
                    ? 'no_change'
                    : 'update';
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
                }
                else if (action === 'update') {
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
            }
            catch (error) {
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
        const summary = {
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
    }
    catch (error) {
        if (runDbId !== null) {
            updateRunStatus(db, runDbId, error instanceof Error && error.message.includes('threshold')
                ? 'halted'
                : error instanceof Error &&
                    [
                        'dirty_git_worktree',
                        'reset_dev_refused_in_production',
                        'canonicalpath_uniqueness_behavior_changed',
                        'extract_json_schema_version_mismatch',
                    ].includes(error.message)
                    ? 'halted'
                    : 'crashed', error instanceof Error ? error.message : String(error));
        }
        throw error;
    }
    finally {
        db.close();
        await maybeDestroyStrapi(strapi);
    }
}
async function main(argv = process.argv.slice(2)) {
    const parsed = parseArgs(argv);
    if (parsed.command === 'run') {
        await processRun(parsed);
        return;
    }
    const db = new better_sqlite3_1.default(extract_modx_1.LEDGER_PATH, { readonly: true });
    try {
        (0, ledger_schema_1.ensureLedgerSchema)(db);
        if (parsed.command === 'status') {
            await runStatusCommand(db, parsed.flags.run);
            return;
        }
        if (parsed.command === 'row') {
            const modxId = parsed.positionals[0];
            if (!modxId)
                throw new Error('usage: migrate-cli.ts row <modxId>');
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
    }
    finally {
        db.close();
    }
}
if (require.main === module) {
    main().catch((error) => {
        console.error('[migrate-cli] FATAL:', error);
        process.exit(1);
    });
}
