#!/usr/bin/env tsx
"use strict";
/**
 * verify-schema-constraints — Q9 empirical probe for canonicalPath uniqueness.
 *
 * Opens the Strapi SQLite DB read-only and inspects `sqlite_master` for any
 * UNIQUE index or constraint touching `canonical_path` on the five routable
 * content-type tables. Outputs one of three verdicts:
 *
 *   per-locale  — UNIQUE over (canonical_path, locale) or equivalent.
 *                 Safe for our per-locale collision model.
 *   global      — UNIQUE over (canonical_path) alone. Forces schema PR to
 *                 drop `unique: true` (see AC-pre-9).
 *   none        — No DB-level UNIQUE enforcement. Importer `usedPaths` Set
 *                 is the sole collision guard. Advisory `unique: true` in
 *                 schema JSON is harmless but effectively dead.
 *
 * Exit code:  0 for per-locale or none, 1 for global.
 *
 * Captured output is committed under `plans/verification/` for audit.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const strapi_sqlite_path_1 = require("./strapi-sqlite-path");
const CONTENT_TABLES = [
    'pages',
    'diseases',
    'disease_categories',
    'services',
    'service_categories',
];
function main() {
    const strapiAppRoot = node_path_1.default.resolve(__dirname, '..');
    const dbPath = (0, strapi_sqlite_path_1.resolveStrapiSqliteFilePath)(strapiAppRoot);
    if (!node_fs_1.default.existsSync(dbPath)) {
        console.error(`[verify-schema-constraints] DB not found at ${dbPath}. Run \`pnpm --filter @myorl/strapi dev\` once first to initialize.`);
        return 1;
    }
    const db = new better_sqlite3_1.default(dbPath, { readonly: true });
    const findings = {};
    for (const table of CONTENT_TABLES) {
        const evidence = [];
        const tableRow = db
            .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name = ?`)
            .get(table);
        if (!tableRow) {
            findings[table] = { verdict: 'none', evidence: ['table does not exist'] };
            continue;
        }
        evidence.push(`table DDL: ${tableRow.sql}`);
        const indexes = db
            .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
            .all(table);
        for (const idx of indexes) {
            if (idx.sql)
                evidence.push(`index: ${idx.sql}`);
        }
        const uniqueOnCanonical = indexes.filter((i) => i.sql && /UNIQUE/i.test(i.sql) && /canonical_path/.test(i.sql));
        const tableHasUniqueCanonical = /UNIQUE\s*\([^)]*canonical_path[^)]*\)/i.test(tableRow.sql);
        let verdict = 'none';
        for (const i of uniqueOnCanonical) {
            const match = i.sql && i.sql.match(/\(([^)]+)\)/);
            const cols = match ? match[1].split(',').map((s) => s.replace(/[`"]/g, '').trim()) : [];
            if (cols.includes('locale')) {
                verdict = 'per-locale';
            }
            else if (cols.length === 1 && cols[0] === 'canonical_path') {
                verdict = 'global';
            }
        }
        if (verdict === 'none' && tableHasUniqueCanonical) {
            verdict = 'global';
        }
        findings[table] = { verdict, evidence };
    }
    db.close();
    const verdicts = new Set(Object.values(findings).map((f) => f.verdict));
    console.log('[verify-schema-constraints] probe results');
    console.log('='.repeat(64));
    for (const [table, { verdict, evidence }] of Object.entries(findings)) {
        console.log(`\n${table}: VERDICT=${verdict}`);
        for (const line of evidence)
            console.log(`  ${line}`);
    }
    console.log('\n' + '='.repeat(64));
    if (verdicts.has('global')) {
        console.log('[verify-schema-constraints] OVERALL VERDICT: global — schema PR required (AC-pre-9).');
        return 1;
    }
    if (verdicts.size === 1 && verdicts.has('per-locale')) {
        console.log('[verify-schema-constraints] OVERALL VERDICT: per-locale — safe; importer may lean on DB enforcement.');
        return 0;
    }
    console.log('[verify-schema-constraints] OVERALL VERDICT: none — no DB-level enforcement on canonical_path.');
    console.log('  Importer `usedPaths` Set is the sole per-locale collision guard.');
    console.log('  Advisory `"unique": true` in schema JSON is effectively dead at this Strapi version.');
    return 0;
}
const code = main();
process.exit(code);
