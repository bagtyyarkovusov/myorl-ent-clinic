import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureLedgerSchema } from './ledger-schema';
import type { ExtractEnvelope } from './extract-modx.types';
import { renderRunReport } from './render-run-report';

describe('render-run-report', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureLedgerSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('renders extract-mode markdown and structured JSON summary', () => {
    const info = db
      .prepare(
        `INSERT INTO migration_run (started_at, finished_at, mode, git_sha, run_label, exit_status)
         VALUES ('2026-04-22T10:37:19.000Z', '2026-04-22T10:38:00.000Z', 'extract', 'abc1234', '20260422T103719Z-abc1234', 'ok')`,
      )
      .run();
    const runId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO migration_record (run_id, modx_id, locale, target_type, state, stage, needs_review)
       VALUES
         (?, 1, 'el', 'page', 'classified', 'extract', 0),
         (?, 2, 'ru', 'unknown', 'skipped', 'extract', 0),
         (?, 3, 'el', 'disease', 'classified', 'extract', 1)`,
    ).run(runId, runId, runId);

    db.prepare(
      `INSERT INTO migration_event (run_id, modx_id, from_state, to_state, stage, attempt, error_detail)
       VALUES
         (?, 1, NULL, 'discovered', 'extract', 0, NULL),
         (?, 1, 'discovered', 'classified', 'classify', 0, NULL),
         (?, 2, NULL, 'discovered', 'extract', 0, NULL),
         (?, 2, 'discovered', 'skipped', 'classify', 0, 'unknown_template'),
         (?, 3, NULL, 'discovered', 'extract', 0, NULL),
         (?, 3, 'discovered', 'classified', 'classify', 0, NULL)`,
    ).run(runId, runId, runId, runId, runId, runId);

    const envelope: ExtractEnvelope = {
      schema_version: 1,
      run_id: '20260422T103719Z-abc1234',
      git_sha: 'abc1234',
      source_row_count: 3,
      source_dump_sha256: 'f'.repeat(64),
      counts: {
        classified: 2,
        skipped: 1,
        by_target_type: {
          page: 1,
          disease: 1,
          'disease-category': 0,
          service: 0,
          'service-category': 0,
        },
        by_locale: { el: 2, ru: 0 },
        by_skip_reason: {
          non_content_context: 0,
          unknown_template: 1,
          empty_uri: 0,
        },
      },
      tv_audit: [
        { tmplvar_id: 1, name: 'metaTitle', rows_with_value: 2 },
        { tmplvar_id: 4, name: 'image', rows_with_value: 2 },
        { tmplvar_id: 99, name: 'noiseTv', rows_with_value: 0 },
      ],
      utf8_scan: {
        rows_scanned: 2,
        rows_with_replacement_char: 0,
        sample_modx_ids: [],
      },
      asset_inventory_relative_to: 'public_html',
      asset_inventory_stats: {
        total_count: 10,
        size_zero_count: 1,
        walked_dirs: ['assets', 'files'],
      },
      asset_anomalies: [{ path: 'files/empty.jpg', reason: 'size_zero' }],
      asset_inventory: [{ path: 'files/hero.jpg', size_bytes: 42, sha256: 'a'.repeat(64) }],
      rows: [
        {
          modx_id: 1,
          target_type: 'page',
          locale: 'el',
          canonical_path: '',
          status: 'published',
          title: 'Home',
          body_html: '<p>Hello</p>',
          seo_meta_title: 'Home',
          seo_meta_description: '',
          parent_modx_id: null,
          category_modx_id: null,
          legacy_paths: [],
          needs_review_seed: false,
          needs_review_reasons: [],
          modx_raw: {
            uri: '',
            template: 8,
            context_key: 'web',
            published: 1,
            deleted: 0,
            status_guess: null,
            parent: 0,
          },
        },
        {
          modx_id: 2,
          skip_reason: 'unknown_template',
          modx_raw: {
            uri: 'legacy',
            template: 15,
            context_key: 'rus',
            pagetitle: 'Legacy',
          },
        },
        {
          modx_id: 3,
          target_type: 'disease',
          locale: 'el',
          canonical_path: 'sleep-apnea',
          status: 'draft',
          title: 'Sleep Apnea',
          body_html: '<p>Body</p>',
          seo_meta_title: 'Sleep Apnea',
          seo_meta_description: 'Desc',
          parent_modx_id: null,
          category_modx_id: 11,
          legacy_paths: ['/legacy'],
          needs_review_seed: true,
          needs_review_reasons: ['deleted_flag'],
          modx_raw: {
            uri: 'sleep-apnea',
            template: 11,
            context_key: 'web',
            published: 1,
            deleted: 1,
            status_guess: null,
            parent: 11,
          },
        },
      ],
    };

    const rendered = renderRunReport(db, envelope.run_id, envelope);

    expect(rendered.md).toContain('# Migration run 20260422T103719Z-abc1234');
    expect(rendered.md).toContain('## Classification matrix');
    expect(rendered.md).toContain('Dropped (Phase 6.6)');
    expect(rendered.json).toMatchInlineSnapshot(`
      {
        "asset_inventory": {
          "anomaly_count": 1,
          "relative_to": "public_html",
          "stats": {
            "size_zero_count": 1,
            "total_count": 10,
            "walked_dirs": [
              "assets",
              "files",
            ],
          },
        },
        "classification_matrix": {
          "el": {
            "disease": 1,
            "disease-category": 0,
            "page": 1,
            "service": 0,
            "service-category": 0,
          },
          "ru": {
            "disease": 0,
            "disease-category": 0,
            "page": 0,
            "service": 0,
            "service-category": 0,
          },
        },
        "counts": {
          "by_locale": {
            "el": 2,
            "ru": 0,
          },
          "by_skip_reason": {
            "empty_uri": 0,
            "non_content_context": 0,
            "unknown_template": 1,
          },
          "by_target_type": {
            "disease": 1,
            "disease-category": 0,
            "page": 1,
            "service": 0,
            "service-category": 0,
          },
          "classified": 2,
          "skipped": 1,
        },
        "exit_status": "ok",
        "finished_at": "2026-04-22T10:38:00.000Z",
        "git_sha": "abc1234",
        "halt_reason": null,
        "ledger_id": 1,
        "ledger_snapshot": {
          "migration_event_count": 6,
          "migration_record_count": 3,
          "records_by_state": {
            "classified": 2,
            "skipped": 1,
          },
          "row_count_matches_source": true,
        },
        "mode": "extract",
        "needs_review_seed": {
          "by_reason": {
            "deleted_flag": 1,
            "malformed_autoredirector": 0,
            "properties_column_unparseable": 0,
            "status_guess_review": 0,
          },
          "total": 1,
        },
        "next_step": "Boot Strapi and run: pnpm migrate:modx -- --mode=dry-run --run=20260422T103719Z-abc1234",
        "run_id": "20260422T103719Z-abc1234",
        "skips": {
          "by_reason": {
            "empty_uri": 0,
            "non_content_context": 0,
            "unknown_template": 1,
          },
          "unknown_template_by_template": {
            "15": 1,
          },
        },
        "source": {
          "dump_sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "row_count": 3,
        },
        "started_at": "2026-04-22T10:37:19.000Z",
        "tv_audit": [
          {
            "name": "metaTitle",
            "rows_with_value": 2,
            "status": "extracted",
            "tmplvar_id": 1,
          },
          {
            "name": "image",
            "rows_with_value": 2,
            "status": "phase_6_6",
            "tmplvar_id": 4,
          },
          {
            "name": "noiseTv",
            "rows_with_value": 0,
            "status": "noise",
            "tmplvar_id": 99,
          },
        ],
        "utf8_scan": {
          "rows_scanned": 2,
          "rows_with_replacement_char": 0,
          "sample_modx_ids": [],
        },
      }
    `);
  });
});
