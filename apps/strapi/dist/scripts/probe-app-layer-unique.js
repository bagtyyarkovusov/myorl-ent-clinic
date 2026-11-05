"use strict";
/**
 * probe-app-layer-unique — Q9 companion probe.
 *
 * `verify-schema-constraints.ts` answers: does SQLite emit a UNIQUE index on
 * `canonical_path`? (At Strapi 5.42.1: no — verdict `none`.)
 *
 * This script answers the complementary question: does Strapi's APPLICATION
 * LAYER enforce `unique: true` on `canonicalPath`, and at what scope?
 *
 * We boot Strapi against an isolated `.tmp/probe.db` (auto-synced fresh from
 * schema) and execute a 5-step probe:
 *
 *   1. el draft create canonicalPath=__probe_canonical_path   → expect OK
 *   2. el draft create canonicalPath=__probe_canonical_path   (same locale dup) → observe
 *   3. publish doc from step 1                                → expect OK
 *   4. el draft create canonicalPath=__probe_canonical_path   (over published) → observe
 *   5. ru draft create canonicalPath=__probe_canonical_path   (cross-locale) → observe
 *
 * Verdict matrix:
 *   - steps 2 + 4 error, step 5 OK      → per-locale   (matches migration assumption)
 *   - steps 2 + 4 error, step 5 error   → global      (AC-pre-9 schema-drop PR triggers)
 *   - steps 2 + 4 OK                    → none        (unique: true is dead code)
 *
 * Output captured to plans/verification/canonicalpath-app-enforcement-<date>.txt.
 *
 * DB isolation: DATABASE_FILENAME=.tmp/probe.db (honored by config/database.ts:48).
 * Fresh DB every run; probe teardown deletes probe.db + sidecar files.
 *
 * Middleware suppression: MIGRATION_IN_PROGRESS=true set before boot to prevent
 * sync-url-mapping middleware from firing on step-3 publish.
 *
 * Execution note: Node 24 + `tsx` + Koa 2.16.4's transitive `is-generator-function@1.1.2`
 * has a runtime compat issue (`getGeneratorFunction is not a function`) that manifests
 * when Strapi's admin register hook instantiates Koa under the tsx loader. The probe
 * runs as PRE-COMPILED JS via plain `node` to bypass the tsx loader path. See the
 * `probe:app-layer-unique` npm script for the compile-then-run one-liner.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const strapi_sqlite_path_1 = require("./strapi-sqlite-path");
// ---- env setup MUST happen before importing @strapi/strapi ----
process.env.DATABASE_FILENAME = '.tmp/probe.db';
process.env.APP_KEYS = process.env.APP_KEYS || 'probe_key_a,probe_key_b';
process.env.MIGRATION_IN_PROGRESS = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
// Strapi 5 also expects these admin-layer secrets; set dummies for the probe.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'probe_admin_jwt_secret';
process.env.API_TOKEN_SALT = process.env.API_TOKEN_SALT || 'probe_api_token_salt';
process.env.TRANSFER_TOKEN_SALT = process.env.TRANSFER_TOKEN_SALT || 'probe_transfer_token_salt';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'probe_jwt_secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'probe_encryption_key';
const strapi_1 = require("@strapi/strapi");
function findStrapiAppDir(startFrom) {
    // Walk up from the script directory until we find a dir containing
    // config/database.ts (the Strapi app-root signature). Works whether we
    // run as tsx (scripts/) or as pre-compiled JS (.tmp/probe-compiled/).
    let cur = startFrom;
    for (let i = 0; i < 10; i++) {
        if (node_fs_1.default.existsSync(node_path_1.default.join(cur, 'config', 'database.ts')))
            return cur;
        const parent = node_path_1.default.dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    throw new Error(`[probe-app-layer-unique] could not locate Strapi app root from ${startFrom}`);
}
const APP_DIR = process.env.STRAPI_APP_DIR || findStrapiAppDir(__dirname);
const PROBE_DB = (0, strapi_sqlite_path_1.resolveStrapiSqliteFilePath)(APP_DIR, '.tmp/probe.db');
const PROBE_SIDECARS = [PROBE_DB, `${PROBE_DB}-journal`, `${PROBE_DB}-wal`, `${PROBE_DB}-shm`];
const PAGE_UID = 'api::page.page';
const PROBE_PATH = '__probe_canonical_path';
const OUT_PATH = node_path_1.default.resolve(APP_DIR, '..', '..', 'plans', 'verification', 'canonicalpath-app-enforcement-2026-04-19.txt');
function cleanupProbeDb() {
    var _a;
    for (const f of PROBE_SIDECARS) {
        try {
            node_fs_1.default.unlinkSync(f);
        }
        catch (err) {
            if ((err === null || err === void 0 ? void 0 : err.code) !== 'ENOENT') {
                console.error(`[probe-app-layer-unique] warn: could not unlink ${f}: ${(_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : err}`);
            }
        }
    }
}
async function runStep(fn, step, label) {
    var _a, _b;
    try {
        const result = await fn();
        return {
            step,
            label,
            status: 'OK',
            documentId: result === null || result === void 0 ? void 0 : result.documentId,
        };
    }
    catch (err) {
        return {
            step,
            label,
            status: 'ERROR',
            errorName: (_a = err === null || err === void 0 ? void 0 : err.name) !== null && _a !== void 0 ? _a : 'Error',
            errorMessage: ((_b = err === null || err === void 0 ? void 0 : err.message) !== null && _b !== void 0 ? _b : String(err)).slice(0, 500),
        };
    }
}
function classifyVerdict(outcomes) {
    const s2 = outcomes.find((o) => o.step === 2);
    const s4 = outcomes.find((o) => o.step === 4);
    const s5 = outcomes.find((o) => o.step === 5);
    if (!s2 || !s4 || !s5)
        return 'indeterminate';
    const s2Err = s2.status === 'ERROR';
    const s4Err = s4.status === 'ERROR';
    const s5Err = s5.status === 'ERROR';
    if (s2Err && s4Err && s5Err)
        return 'global';
    if (s2Err && s4Err && !s5Err)
        return 'per-locale';
    if (!s2Err && !s4Err)
        return 'none';
    return 'indeterminate';
}
function renderReport(outcomes, verdict, bootMs) {
    const lines = [];
    lines.push(`Probe run: 2026-04-19`);
    lines.push(`Strapi version: 5.42.1`);
    lines.push(`Probe DB: ${PROBE_DB} (isolated, ephemeral; matches config/database.ts)`);
    lines.push(`Boot time: ${bootMs}ms`);
    lines.push('');
    lines.push(`[probe-app-layer-unique] 5-step probe sequence`);
    lines.push('='.repeat(64));
    for (const o of outcomes) {
        const head = `Step ${o.step} (${o.label}): ${o.status}`;
        if (o.status === 'OK') {
            lines.push(`${head}${o.documentId ? ` (documentId=${o.documentId})` : ''}`);
        }
        else if (o.status === 'ERROR') {
            lines.push(`${head} — ${o.errorName}: ${o.errorMessage}`);
        }
        else {
            lines.push(head);
        }
    }
    lines.push('');
    lines.push('='.repeat(64));
    const verdictMap = {
        'per-locale': 'per-locale — Strapi enforces canonicalPath uniqueness per-locale at the application layer. `usedPaths` Set in the importer is defense-in-depth; schema `unique: true` behaves as documented.',
        global: 'global — Strapi enforces canonicalPath uniqueness globally at the application layer. AC-pre-9 triggers: schema PR must drop `unique: true` from all 5 content types.',
        none: 'none — Strapi does NOT enforce canonicalPath uniqueness at any layer. `unique: true` in schema JSON is effectively dead at Strapi 5.42.1. Importer `usedPaths` Set is the SOLE collision guard during migration.',
        indeterminate: 'indeterminate — probe did not complete all 5 steps. Re-run required.',
    };
    lines.push(`[probe-app-layer-unique] OVERALL VERDICT: ${verdictMap[verdict]}`);
    lines.push('');
    return lines.join('\n');
}
async function main() {
    var _a, _b, _c, _d;
    cleanupProbeDb();
    const t0 = Date.now();
    let strapi = null;
    try {
        const { appDir, distDir } = await (0, strapi_1.compileStrapi)({ appDir: APP_DIR });
        strapi = await (0, strapi_1.createStrapi)({ appDir, distDir, autoReload: false, serveAdminPanel: false }).load();
    }
    catch (err) {
        console.error(`[probe-app-layer-unique] boot failed: ${(_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : err}`);
        console.error((_b = err === null || err === void 0 ? void 0 : err.stack) !== null && _b !== void 0 ? _b : '');
        cleanupProbeDb();
        return 1;
    }
    const bootMs = Date.now() - t0;
    const outcomes = [];
    try {
        // Step 1 — baseline: el draft create.
        const s1 = await runStep(() => strapi.documents(PAGE_UID).create({
            data: { title: '__probe_a', canonicalPath: PROBE_PATH },
            locale: 'el',
        }), 1, 'el draft create (baseline)');
        outcomes.push(s1);
        // Step 2 — same locale duplicate draft create.
        const s2 = await runStep(() => strapi.documents(PAGE_UID).create({
            data: { title: '__probe_b', canonicalPath: PROBE_PATH },
            locale: 'el',
        }), 2, 'el draft create (duplicate — same locale, draft-vs-draft)');
        outcomes.push(s2);
        // Step 3 — publish step-1 document (only if step 1 succeeded).
        if (s1.status === 'OK' && s1.documentId) {
            const s3 = await runStep(() => strapi.documents(PAGE_UID).publish({
                documentId: s1.documentId,
                locale: 'el',
            }), 3, 'publish step-1 draft');
            outcomes.push(s3);
        }
        else {
            outcomes.push({ step: 3, label: 'publish step-1 draft', status: 'SKIPPED' });
        }
        // Step 4 — el draft create while step-1 doc is published.
        const s4 = await runStep(() => strapi.documents(PAGE_UID).create({
            data: { title: '__probe_c', canonicalPath: PROBE_PATH },
            locale: 'el',
        }), 4, 'el draft create (duplicate — same locale, draft-vs-published)');
        outcomes.push(s4);
        // Step 5 — ru draft create, same path.
        const s5 = await runStep(() => strapi.documents(PAGE_UID).create({
            data: { title: '__probe_d', canonicalPath: PROBE_PATH },
            locale: 'ru',
        }), 5, 'ru draft create (cross-locale)');
        outcomes.push(s5);
    }
    finally {
        try {
            await (strapi === null || strapi === void 0 ? void 0 : strapi.destroy());
        }
        catch (err) {
            console.error(`[probe-app-layer-unique] warn: destroy failed: ${(_c = err === null || err === void 0 ? void 0 : err.message) !== null && _c !== void 0 ? _c : err}`);
        }
        cleanupProbeDb();
    }
    const verdict = classifyVerdict(outcomes);
    const report = renderReport(outcomes, verdict, bootMs);
    // Emit to stdout + capture file.
    console.log(report);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(OUT_PATH), { recursive: true });
        node_fs_1.default.writeFileSync(OUT_PATH, report, 'utf-8');
        console.log(`[probe-app-layer-unique] captured to ${node_path_1.default.relative(process.cwd(), OUT_PATH)}`);
    }
    catch (err) {
        console.error(`[probe-app-layer-unique] failed to write ${OUT_PATH}: ${(_d = err === null || err === void 0 ? void 0 : err.message) !== null && _d !== void 0 ? _d : err}`);
        return 1;
    }
    // Exit 0 whenever the probe sequence completed (including verdict=none or
    // verdict=global). Exit 1 only on boot/teardown infrastructure failure.
    return 0;
}
main()
    .then((code) => process.exit(code))
    .catch((err) => {
    console.error('[probe-app-layer-unique] unexpected top-level failure:', err);
    cleanupProbeDb();
    process.exit(1);
});
