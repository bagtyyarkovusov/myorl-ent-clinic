/**
 * Integration: mocked Strapi boot + in-memory ledger + isolated baseline/report dirs.
 * Validates two identical dry-runs both succeed and the second compares against baseline.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExtractEnvelope } from './extract-modx.types';

const intCtx = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const Database = require('better-sqlite3') as typeof import('better-sqlite3').default;

  process.env.MIGRATION_LEDGER_PATH = ':memory:';
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'migrate-cli-int-'));
  const strapiSqlite = pathMod.join(root, 'strapi.db');
  const sdb = new Database(strapiSqlite);
  sdb.close();
  const workDir = pathMod.join(root, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  process.env.MIGRATION_BASELINE_PATH = pathMod.join(workDir, 'baseline.json');
  process.env.MIGRATION_REPORT_DIR = pathMod.join(workDir, 'reports');
  fs.mkdirSync(process.env.MIGRATION_REPORT_DIR, { recursive: true });
  return { root, strapiSqlite, workDir };
});

vi.mock('@strapi/strapi', () => ({
  compileStrapi: vi.fn(async () => ({ appDir: '/app', distDir: '/app/dist' })),
  createStrapi: vi.fn(() => ({
    load: async () => ({
      config: {
        get: (key: string) =>
          key === 'database'
            ? {
                connection: {
                  client: 'sqlite',
                  connection: { filename: intCtx.strapiSqlite },
                },
              }
            : undefined,
      },
      db: {
        query: () => ({
          findMany: async () => [],
          deleteMany: async () => {},
        }),
      },
      documents: () => ({
        findFirst: async () => null,
        create: async ({ data }: { data: { modxId?: number } }) => ({
          documentId: `doc-${data.modxId ?? 'x'}`,
        }),
        update: async () => {},
      }),
      destroy: async () => {},
    }),
  })),
}));

import { parseArgs, processRun } from './migrate-cli';

function minimalEnvelope(): ExtractEnvelope {
  return {
    schema_version: 1,
    run_id: 'integration-test-extract',
    git_sha: 'abc1234',
    source_row_count: 1,
    source_dump_sha256: 'f'.repeat(64),
    counts: {
      classified: 1,
      skipped: 0,
      by_target_type: {
        page: 1,
        disease: 0,
        'disease-category': 0,
        service: 0,
        'service-category': 0,
      },
      by_locale: { el: 1, ru: 0 },
      by_skip_reason: {
        non_content_context: 0,
        unknown_template: 0,
        empty_uri: 0,
      },
    },
    tv_audit: [],
    utf8_scan: { rows_scanned: 1, rows_with_replacement_char: 0, sample_modx_ids: [] },
    asset_inventory_relative_to: 'public_html',
    asset_inventory_stats: { total_count: 0, size_zero_count: 0, walked_dirs: [] },
    asset_anomalies: [],
    asset_inventory: [],
    rows: [
      {
        modx_id: 42,
        target_type: 'page',
        locale: 'el',
        canonical_path: 'about',
        status: 'published',
        title: 'About',
        body_html: '<p>Hi</p>',
        seo_meta_title: 'About',
        seo_meta_description: '',
        parent_modx_id: null,
        category_modx_id: null,
        legacy_paths: [],
        needs_review_seed: false,
        needs_review_reasons: [],
        modx_raw: {
          uri: 'about',
          template: 8,
          context_key: 'web',
          published: 1,
          deleted: 0,
          status_guess: null,
          parent: 0,
        },
      },
    ],
  };
}

describe('migrate-cli integration (mocked Strapi)', () => {
  afterAll(() => {
    rmSync(intCtx.root, { recursive: true, force: true });
    delete process.env.MIGRATION_LEDGER_PATH;
    delete process.env.MIGRATION_BASELINE_PATH;
    delete process.env.MIGRATION_REPORT_DIR;
  });

  it('two dry-runs: first writes baseline, second compares without halt', async () => {
    const extractPath = path.join(intCtx.workDir, 'modx-extract.json');
    writeFileSync(extractPath, JSON.stringify(minimalEnvelope()), 'utf8');

    await processRun(
      parseArgs(['run', '--mode=dry-run', `--extract=${extractPath}`, '--run=int-dry-1']),
    );
    expect(() => JSON.parse(readFileSync(process.env.MIGRATION_BASELINE_PATH!, 'utf8'))).not.toThrow();

    await processRun(
      parseArgs(['run', '--mode=dry-run', `--extract=${extractPath}`, '--run=int-dry-2']),
    );

    const reports = path.join(intCtx.workDir, 'reports');
    const jsonFiles = readFileSync(path.join(reports, 'run-int-dry-2.json'), 'utf8');
    const summary = JSON.parse(jsonFiles) as { baseline_compared: boolean; exit_status: string | null };
    expect(summary.baseline_compared).toBe(true);
    expect(summary.exit_status).toBe('ok');
  });
});
