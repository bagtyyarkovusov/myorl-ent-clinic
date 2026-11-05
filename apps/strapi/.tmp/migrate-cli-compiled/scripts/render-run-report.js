"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderRunReport = renderRunReport;
exports.writeRunReport = writeRunReport;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const REPORT_DIR = node_path_1.default.resolve(__dirname, '..', '..', '..', 'plans', 'migration-reports');
function queryRun(db, runId) {
    const row = db
        .prepare(`SELECT id, run_label, mode, git_sha, started_at, finished_at, exit_status, halt_reason
         FROM migration_run
        WHERE run_label = ?`)
        .get(runId);
    if (!row) {
        throw new Error(`[render-run-report] unknown run_id: ${runId}`);
    }
    return {
        run_id: row.run_label,
        ledger_id: row.id,
        mode: row.mode,
        git_sha: row.git_sha,
        started_at: row.started_at,
        finished_at: row.finished_at,
        exit_status: row.exit_status,
        halt_reason: row.halt_reason,
    };
}
function deriveClassificationMatrix(rows) {
    const matrix = {
        el: {
            page: 0,
            disease: 0,
            'disease-category': 0,
            service: 0,
            'service-category': 0,
        },
        ru: {
            page: 0,
            disease: 0,
            'disease-category': 0,
            service: 0,
            'service-category': 0,
        },
    };
    for (const row of rows) {
        if (!('target_type' in row))
            continue;
        matrix[row.locale][row.target_type]++;
    }
    return matrix;
}
function deriveUnknownTemplateBreakdown(rows) {
    var _a;
    const counts = new Map();
    for (const row of rows) {
        if ('target_type' in row || row.skip_reason !== 'unknown_template')
            continue;
        const current = (_a = counts.get(row.modx_raw.template)) !== null && _a !== void 0 ? _a : 0;
        counts.set(row.modx_raw.template, current + 1);
    }
    return Object.fromEntries([...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([template, count]) => [String(template), count]));
}
function deriveNeedsReviewSummary(rows) {
    const byReason = {
        deleted_flag: 0,
        status_guess_review: 0,
        malformed_autoredirector: 0,
        properties_column_unparseable: 0,
    };
    let total = 0;
    for (const row of rows) {
        if (!('target_type' in row) || !row.needs_review_seed)
            continue;
        total++;
        for (const reason of row.needs_review_reasons) {
            byReason[reason]++;
        }
    }
    return { total, by_reason: byReason };
}
function classifyTvStatus(tv) {
    if (tv.name === 'metaTitle' || tv.name === 'metaDescription') {
        return 'extracted';
    }
    if (tv.rows_with_value === 0) {
        return 'noise';
    }
    return 'phase_6_6';
}
function summarizeExtractRun(db, base, envelope) {
    const recordsByStateRows = db
        .prepare(`SELECT state, COUNT(*) AS count
         FROM migration_record
        WHERE run_id = ?
        GROUP BY state
        ORDER BY state`)
        .all(base.ledger_id);
    const migrationRecordCount = db
        .prepare(`SELECT COUNT(*) AS count FROM migration_record WHERE run_id = ?`)
        .get(base.ledger_id);
    const migrationEventCount = db
        .prepare(`SELECT COUNT(*) AS count FROM migration_event WHERE run_id = ?`)
        .get(base.ledger_id);
    return {
        ...base,
        mode: 'extract',
        source: {
            row_count: envelope.source_row_count,
            dump_sha256: envelope.source_dump_sha256,
        },
        counts: envelope.counts,
        classification_matrix: deriveClassificationMatrix(envelope.rows),
        skips: {
            by_reason: envelope.counts.by_skip_reason,
            unknown_template_by_template: deriveUnknownTemplateBreakdown(envelope.rows),
        },
        tv_audit: envelope.tv_audit.map((tv) => ({
            ...tv,
            status: classifyTvStatus(tv),
        })),
        utf8_scan: envelope.utf8_scan,
        asset_inventory: {
            relative_to: envelope.asset_inventory_relative_to,
            stats: envelope.asset_inventory_stats,
            anomaly_count: envelope.asset_anomalies.length,
        },
        needs_review_seed: deriveNeedsReviewSummary(envelope.rows),
        ledger_snapshot: {
            migration_record_count: migrationRecordCount.count,
            migration_event_count: migrationEventCount.count,
            records_by_state: Object.fromEntries(recordsByStateRows.map((row) => [row.state, row.count])),
            row_count_matches_source: migrationRecordCount.count === envelope.source_row_count,
        },
        next_step: `Boot Strapi and run: pnpm migrate:modx -- --mode=dry-run --run=${base.run_id}`,
    };
}
function renderCountsTable(summary) {
    const lines = [
        '| locale | page | disease | disease-category | service | service-category |',
        '|---|---:|---:|---:|---:|---:|',
    ];
    for (const locale of ['el', 'ru']) {
        const row = summary.classification_matrix[locale];
        lines.push(`| ${locale} | ${row.page} | ${row.disease} | ${row['disease-category']} | ${row.service} | ${row['service-category']} |`);
    }
    return lines.join('\n');
}
function renderSkipTable(summary) {
    const lines = [
        '| skip_reason | count | detail |',
        '|---|---:|---|',
        `| non_content_context | ${summary.skips.by_reason.non_content_context} | Tier 1 halt in valid runs; bucket retained for schema compatibility |`,
        `| unknown_template | ${summary.skips.by_reason.unknown_template} | templates: ${JSON.stringify(summary.skips.unknown_template_by_template)} |`,
        `| empty_uri | ${summary.skips.by_reason.empty_uri} | — |`,
    ];
    return lines.join('\n');
}
function renderTvAuditTable(summary) {
    const lines = [
        '| tv_id | name | rows_with_value | status |',
        '|---:|---|---:|---|',
    ];
    for (const tv of summary.tv_audit) {
        const status = tv.status === 'phase_6_6' ? 'Dropped (Phase 6.6)' : tv.status === 'noise' ? 'Noise' : 'Extracted';
        lines.push(`| ${tv.tmplvar_id} | ${tv.name} | ${tv.rows_with_value} | ${status} |`);
    }
    return lines.join('\n');
}
function renderNeedsReviewTable(summary) {
    const lines = [
        '| reason | count |',
        '|---|---:|',
        `| deleted_flag | ${summary.needs_review_seed.by_reason.deleted_flag} |`,
        `| status_guess_review | ${summary.needs_review_seed.by_reason.status_guess_review} |`,
        `| malformed_autoredirector | ${summary.needs_review_seed.by_reason.malformed_autoredirector} |`,
        `| properties_column_unparseable | ${summary.needs_review_seed.by_reason.properties_column_unparseable} |`,
    ];
    return lines.join('\n');
}
function renderExtractMarkdown(summary) {
    var _a, _b, _c;
    return [
        `# Migration run ${summary.run_id}`,
        '',
        '## Run metadata',
        '',
        `- mode: ${summary.mode}`,
        `- ledger_id: ${summary.ledger_id}`,
        `- git_sha: ${summary.git_sha}`,
        `- started_at: ${summary.started_at}`,
        `- finished_at: ${(_a = summary.finished_at) !== null && _a !== void 0 ? _a : 'null'}`,
        `- exit_status: ${(_b = summary.exit_status) !== null && _b !== void 0 ? _b : 'null'}`,
        `- halt_reason: ${(_c = summary.halt_reason) !== null && _c !== void 0 ? _c : 'null'}`,
        '',
        '## Source',
        '',
        `- source_row_count: ${summary.source.row_count}`,
        `- source_dump_sha256: ${summary.source.dump_sha256}`,
        '',
        '## Classification matrix',
        '',
        renderCountsTable(summary),
        '',
        '## Skip table',
        '',
        renderSkipTable(summary),
        '',
        '## TV audit',
        '',
        renderTvAuditTable(summary),
        '',
        '## UTF-8 scan',
        '',
        `- rows_scanned: ${summary.utf8_scan.rows_scanned}`,
        `- rows_with_replacement_char: ${summary.utf8_scan.rows_with_replacement_char}`,
        `- sample_modx_ids: ${summary.utf8_scan.sample_modx_ids.length ? summary.utf8_scan.sample_modx_ids.join(', ') : 'none'}`,
        '',
        '## Asset inventory',
        '',
        `- relative_to: ${summary.asset_inventory.relative_to}`,
        `- total_count: ${summary.asset_inventory.stats.total_count}`,
        `- size_zero_count: ${summary.asset_inventory.stats.size_zero_count}`,
        `- walked_dirs: ${summary.asset_inventory.stats.walked_dirs.join(', ') || 'none'}`,
        `- anomaly_count: ${summary.asset_inventory.anomaly_count}`,
        '',
        '## needs_review_seed',
        '',
        `- total: ${summary.needs_review_seed.total}`,
        '',
        renderNeedsReviewTable(summary),
        '',
        '## Ledger snapshot',
        '',
        `- migration_record_count: ${summary.ledger_snapshot.migration_record_count}`,
        `- migration_event_count: ${summary.ledger_snapshot.migration_event_count}`,
        `- records_by_state: ${JSON.stringify(summary.ledger_snapshot.records_by_state)}`,
        `- row_count_matches_source: ${summary.ledger_snapshot.row_count_matches_source}`,
        '',
        '## Next step',
        '',
        summary.next_step,
        '',
    ].join('\n');
}
function renderRunReport(db, runId, envelope) {
    const base = queryRun(db, runId);
    if (base.mode !== 'extract') {
        throw new Error(`[render-run-report] mode ${base.mode} is not implemented yet`);
    }
    const json = summarizeExtractRun(db, base, envelope);
    const md = renderExtractMarkdown(json);
    return { md, json };
}
async function writeRunReport(db, runId, envelope, reportDir = REPORT_DIR) {
    const rendered = renderRunReport(db, runId, envelope);
    await node_fs_1.promises.mkdir(reportDir, { recursive: true });
    const markdownPath = node_path_1.default.join(reportDir, `run-${runId}.md`);
    const jsonPath = node_path_1.default.join(reportDir, `run-${runId}.json`);
    await node_fs_1.promises.writeFile(markdownPath, rendered.md, 'utf8');
    await node_fs_1.promises.writeFile(jsonPath, JSON.stringify(rendered.json, null, 2) + '\n', 'utf8');
    return { markdownPath, jsonPath, summary: rendered.json };
}
