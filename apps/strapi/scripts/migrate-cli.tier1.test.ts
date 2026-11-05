/**
 * Tier-1 dry-run / merge halts (AC-merge-8): dirty git, reset-dev in production,
 * extract schema mismatch, canonical_path uniqueness drift vs baseline verdict file.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractEnvelope } from './extract-modx.types';

const cpTest = vi.hoisted(() => {
  const nodeCp = require('node:child_process') as typeof import('node:child_process');
  return { actualExecSync: nodeCp.execSync.bind(nodeCp) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn((cmd: string, options?: Parameters<typeof actual.execSync>[1]) =>
      actual.execSync(cmd, options),
    ) as typeof actual.execSync,
  };
});

const tier1Ctx = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const pathMod = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');

  process.env.MIGRATION_LEDGER_PATH = ':memory:';
  const root = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'migrate-cli-tier1-'));
  const strapiSqlite = pathMod.join(root, 'strapi.db');
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
                  connection: { filename: tier1Ctx.strapiSqlite },
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

import * as child_process from 'node:child_process';
import { parseArgs, processRun } from './migrate-cli';

const execSyncMock = vi.mocked(child_process.execSync);

function resetEmptyStrapiDb(): void {
  rmSync(tier1Ctx.strapiSqlite, { force: true });
  const sdb = new Database(tier1Ctx.strapiSqlite);
  sdb.close();
}

function minimalEnvelope(): ExtractEnvelope {
  return {
    schema_version: 1,
    run_id: 'tier1-extract',
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
        modx_id: 1,
        target_type: 'page',
        locale: 'el',
        canonical_path: 'about',
        status: 'published',
        title: 'About',
        body_html: '<p>x</p>',
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

describe('migrate-cli tier-1 halts (AC-merge-8)', () => {
  afterAll(() => {
    rmSync(tier1Ctx.root, { recursive: true, force: true });
    delete process.env.MIGRATION_LEDGER_PATH;
    delete process.env.MIGRATION_BASELINE_PATH;
    delete process.env.MIGRATION_REPORT_DIR;
    delete process.env.MIGRATION_ALLOW_DIRTY_GIT;
  });

  beforeEach(() => {
    resetEmptyStrapiDb();
    delete process.env.MIGRATION_ALLOW_DIRTY_GIT;
    execSyncMock.mockImplementation((cmd, options) => cpTest.actualExecSync(cmd, options));
  });

  it('merge with dirty git worktree throws dirty_git_worktree', async () => {
    const extractPath = path.join(tier1Ctx.workDir, 'modx-extract.json');
    writeFileSync(extractPath, JSON.stringify(minimalEnvelope()), 'utf8');

    execSyncMock.mockImplementation((cmd, options) => {
      if (String(cmd) === 'git status --porcelain') return ' M dirty-tier1\n';
      return cpTest.actualExecSync(cmd, options);
    });

    await expect(
      processRun(
        parseArgs(['run', '--mode=merge', `--extract=${extractPath}`, '--run=tier1-dirty-git']),
      ),
    ).rejects.toThrow('dirty_git_worktree');
  });

  it('reset-dev with NODE_ENV=production throws reset_dev_refused_in_production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        processRun(parseArgs(['run', '--mode=reset-dev', '--run=tier1-prod-reset'])),
      ).rejects.toThrow('reset_dev_refused_in_production');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('extract schema_version mismatch throws extract_json_schema_version_mismatch', async () => {
    const extractPath = path.join(tier1Ctx.workDir, 'bad-schema.json');
    const bad = { ...minimalEnvelope(), schema_version: 999 };
    writeFileSync(extractPath, JSON.stringify(bad), 'utf8');

    await expect(
      processRun(
        parseArgs(['run', '--mode=dry-run', `--extract=${extractPath}`, '--run=tier1-schema']),
      ),
    ).rejects.toThrow('extract_json_schema_version_mismatch');
  });

  it('canonical_path DB verdict drift vs baseline file throws canonicalpath_uniqueness_behavior_changed', async () => {
    const db = new Database(tier1Ctx.strapiSqlite);
    db.exec(`
      CREATE TABLE pages (id integer PRIMARY KEY NOT NULL, canonical_path varchar(255) NULL);
      CREATE UNIQUE INDEX pages_canonical_path_unique ON pages (canonical_path);
    `);
    db.close();

    const extractPath = path.join(tier1Ctx.workDir, 'modx-extract.json');
    writeFileSync(extractPath, JSON.stringify(minimalEnvelope()), 'utf8');

    await expect(
      processRun(
        parseArgs(['run', '--mode=dry-run', `--extract=${extractPath}`, '--run=tier1-canonical']),
      ),
    ).rejects.toThrow('canonicalpath_uniqueness_behavior_changed');
  });

  it('MIGRATION_ALLOW_DIRTY_GIT=true allows merge despite dirty git', async () => {
    const extractPath = path.join(tier1Ctx.workDir, 'modx-extract.json');
    writeFileSync(extractPath, JSON.stringify(minimalEnvelope()), 'utf8');

    execSyncMock.mockImplementation((cmd, options) => {
      if (String(cmd) === 'git status --porcelain') return ' M bypass\n';
      return cpTest.actualExecSync(cmd, options);
    });

    process.env.MIGRATION_ALLOW_DIRTY_GIT = 'true';

    await processRun(
      parseArgs(['run', '--mode=merge', `--extract=${extractPath}`, '--run=tier1-allow-dirty']),
    );

    const reportPath = path.join(
      process.env.MIGRATION_REPORT_DIR!,
      'run-tier1-allow-dirty.json',
    );
    const summary = JSON.parse(readFileSync(reportPath, 'utf8')) as { exit_status: string | null };
    expect(summary.exit_status).toBe('ok');
  });
});
