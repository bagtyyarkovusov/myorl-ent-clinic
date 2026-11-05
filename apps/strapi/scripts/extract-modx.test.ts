import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  ASSET_WALK_SUBDIRS,
  type AssetInventoryEntry,
  type AssetInventoryStats,
  type ClassifiedRow,
  type ExtractRow,
  type SkippedRow,
} from './extract-modx.types';
import {
  assembleEnvelope,
  assertSupportedContexts,
  coerceRawRow,
  computeFileSha256,
  deriveCounts,
  deriveUtf8Scan,
  emptyCounts,
  ExtractHaltError,
  isAssetIncluded,
  newRunId,
  parseCliArgs,
  resolveAssetsRoot,
  resolveMysqlConfig,
  seedExtractLedger,
  serializeEnvelope,
  walkAssetInventory,
  writeExtractJson,
  UTF8_SCAN_SAMPLE_CAP,
} from './extract-modx';
import { ensureLedgerSchema } from './ledger-schema';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'extract-modx-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('parseCliArgs', () => {
  it('parses --key=value', () => {
    expect(parseCliArgs(['--assets-root=/tmp/x', '--out=foo.json'])).toEqual({
      'assets-root': '/tmp/x',
      out: 'foo.json',
    });
  });

  it('parses --key value', () => {
    expect(parseCliArgs(['--assets-root', '/tmp/x', '--dump', '/tmp/d.sql'])).toEqual({
      'assets-root': '/tmp/x',
      dump: '/tmp/d.sql',
    });
  });

  it('treats trailing bare flag as true', () => {
    expect(parseCliArgs(['--verbose'])).toEqual({ verbose: 'true' });
  });

  it('ignores non-flag positional args', () => {
    expect(parseCliArgs(['ignored', '--key=v'])).toEqual({ key: 'v' });
  });
});

describe('resolveAssetsRoot', () => {
  it('prefers CLI arg over env', async () => {
    const resolved = await resolveAssetsRoot({
      cliArg: tmpRoot,
      env: { MODX_ASSETS_ROOT: '/does/not/exist' },
    });
    expect(resolved).toBe(path.resolve(tmpRoot));
  });

  it('falls back to env when no CLI arg', async () => {
    const resolved = await resolveAssetsRoot({
      env: { MODX_ASSETS_ROOT: tmpRoot },
    });
    expect(resolved).toBe(path.resolve(tmpRoot));
  });

  it('halts when neither CLI arg nor env var is provided', async () => {
    await expect(resolveAssetsRoot({ env: {} })).rejects.toMatchObject({
      reason: 'asset_root_not_configured',
    } satisfies Partial<ExtractHaltError>);
  });

  it('throws when resolved path does not exist', async () => {
    const missing = path.join(tmpRoot, 'nope');
    await expect(resolveAssetsRoot({ cliArg: missing })).rejects.toThrow(/does not exist/);
  });

  it('throws when resolved path is not a directory', async () => {
    const asFile = path.join(tmpRoot, 'regular.txt');
    await fsp.writeFile(asFile, 'x');
    await expect(resolveAssetsRoot({ cliArg: asFile })).rejects.toThrow(/not a directory/);
  });
});

describe('isAssetIncluded', () => {
  it('excludes .DS_Store', () => {
    expect(isAssetIncluded('files/.DS_Store')).toBe(false);
  });

  it('excludes macOS resource-fork siblings', () => {
    expect(isAssetIncluded('files/._photo.jpg')).toBe(false);
  });

  it('includes ordinary files', () => {
    expect(isAssetIncluded('files/photo.jpg')).toBe(true);
    expect(isAssetIncluded('ru/files/document.pdf')).toBe(true);
  });
});

describe('computeFileSha256', () => {
  it('computes the well-known SHA256 of "hello\\n"', async () => {
    const p = path.join(tmpRoot, 'hello.txt');
    await fsp.writeFile(p, 'hello\n');
    // sha256 of "hello\n"
    const expected = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
    expect(await computeFileSha256(p)).toBe(expected);
  });
});

describe('walkAssetInventory', () => {
  it('walks only the configured subdirs', async () => {
    // Seed a subset of the nine walked subdirs + an off-list dir.
    await fsp.mkdir(path.join(tmpRoot, 'files'), { recursive: true });
    await fsp.mkdir(path.join(tmpRoot, 'ru/files'), { recursive: true });
    await fsp.mkdir(path.join(tmpRoot, 'should-not-walk'), { recursive: true });

    await fsp.writeFile(path.join(tmpRoot, 'files/a.jpg'), 'a');
    await fsp.writeFile(path.join(tmpRoot, 'ru/files/b.jpg'), 'bb');
    await fsp.writeFile(path.join(tmpRoot, 'should-not-walk/c.jpg'), 'ccc');

    const { entries, stats } = await walkAssetInventory(tmpRoot);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(['files/a.jpg', 'ru/files/b.jpg']);
    expect(stats.walked_dirs).toEqual(['files', 'ru/files']);
    expect(stats.total_count).toBe(2);
  });

  it('skips .DS_Store + resource forks', async () => {
    await fsp.mkdir(path.join(tmpRoot, 'files'), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, 'files/real.jpg'), 'x');
    await fsp.writeFile(path.join(tmpRoot, 'files/.DS_Store'), 'ds');
    await fsp.writeFile(path.join(tmpRoot, 'files/._real.jpg'), 'rf');

    const { entries } = await walkAssetInventory(tmpRoot, ['files']);
    expect(entries.map((e) => e.path)).toEqual(['files/real.jpg']);
  });

  it('counts zero-byte files as size_zero anomalies', async () => {
    await fsp.mkdir(path.join(tmpRoot, 'uploads'), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, 'uploads/empty.jpg'), '');
    await fsp.writeFile(path.join(tmpRoot, 'uploads/good.jpg'), 'data');

    const { entries, stats, anomalies } = await walkAssetInventory(tmpRoot, ['uploads']);
    expect(entries).toHaveLength(2);
    expect(stats.size_zero_count).toBe(1);
    expect(anomalies).toEqual([{ path: 'uploads/empty.jpg', reason: 'size_zero' }]);
  });

  it('sorts entries lexicographically (determinism)', async () => {
    await fsp.mkdir(path.join(tmpRoot, 'files/sub'), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, 'files/z.jpg'), '1');
    await fsp.writeFile(path.join(tmpRoot, 'files/a.jpg'), '2');
    await fsp.writeFile(path.join(tmpRoot, 'files/sub/m.jpg'), '3');

    const { entries } = await walkAssetInventory(tmpRoot, ['files']);
    const paths = entries.map((e) => e.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('produces stable output across two runs', async () => {
    await fsp.mkdir(path.join(tmpRoot, 'files'), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, 'files/a.jpg'), 'a');
    await fsp.writeFile(path.join(tmpRoot, 'files/b.jpg'), 'bb');

    const a = await walkAssetInventory(tmpRoot, ['files']);
    const b = await walkAssetInventory(tmpRoot, ['files']);
    expect(b.entries).toEqual(a.entries);
    expect(b.stats).toEqual(a.stats);
  });

  it('skips missing walk roots silently', async () => {
    // No subdirs created at all.
    const { entries, stats } = await walkAssetInventory(tmpRoot);
    expect(entries).toEqual([]);
    expect(stats.walked_dirs).toEqual([]);
    expect(stats.total_count).toBe(0);
  });

  it('exposes all nine locked walk subdirs', () => {
    expect([...ASSET_WALK_SUBDIRS]).toEqual([
      'files',
      'uploads',
      'webp',
      'template',
      'assets',
      'ru/files',
      'ru/assets',
      'ru/template',
      'ru/webp',
    ]);
  });
});

describe('assembleEnvelope', () => {
  const emptyStats: AssetInventoryStats = {
    total_count: 0,
    size_zero_count: 0,
    walked_dirs: [],
  };

  it('emits schema_version 1 and expected top-level keys in locked order', () => {
    const env = assembleEnvelope({
      runId: 'run-xyz',
      gitSha: 'deadbee',
      sourceRowCount: 0,
      sourceDumpSha256: 'f'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: emptyStats,
      assetAnomalies: [],
    });

    expect(env.schema_version).toBe(1);
    expect(Object.keys(env)).toEqual([
      'schema_version',
      'run_id',
      'git_sha',
      'source_row_count',
      'source_dump_sha256',
      'counts',
      'tv_audit',
      'utf8_scan',
      'asset_inventory_relative_to',
      'asset_inventory_stats',
      'asset_anomalies',
      'asset_inventory',
      'rows',
    ]);
  });

  it('does NOT include generated_at (Q9e)', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: emptyStats,
      assetAnomalies: [],
    });
    expect(env).not.toHaveProperty('generated_at');
  });

  it('seeds all by_target_type counters at 0', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: emptyStats,
      assetAnomalies: [],
    });
    expect(env.counts.by_target_type).toEqual({
      page: 0,
      disease: 0,
      'disease-category': 0,
      service: 0,
      'service-category': 0,
    });
    expect(env.counts.by_locale).toEqual({ el: 0, ru: 0 });
    expect(env.counts.by_skip_reason).toEqual({
      non_content_context: 0,
      unknown_template: 0,
      empty_uri: 0,
    });
  });

  it('pins asset_inventory_relative_to to "public_html"', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: emptyStats,
      assetAnomalies: [],
    });
    expect(env.asset_inventory_relative_to).toBe('public_html');
  });

  it('carries through caller-supplied inventory + anomalies verbatim', () => {
    const inv: AssetInventoryEntry[] = [
      { path: 'files/a.jpg', size_bytes: 1, sha256: 'a'.repeat(64) },
    ];
    const stats: AssetInventoryStats = {
      total_count: 1,
      size_zero_count: 0,
      walked_dirs: ['files'],
    };
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: inv,
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    expect(env.asset_inventory).toBe(inv);
    expect(env.asset_inventory_stats).toBe(stats);
  });
});

describe('serializeEnvelope', () => {
  const stats: AssetInventoryStats = {
    total_count: 0,
    size_zero_count: 0,
    walked_dirs: [],
  };

  it('ends with a trailing newline', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    const out = serializeEnvelope(env);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('byte-for-byte stable across two serializations of the same inputs', () => {
    const mkEnv = () =>
      assembleEnvelope({
        runId: 'fixed-run',
        gitSha: 'abc1234',
        sourceRowCount: 0,
        sourceDumpSha256: '0'.repeat(64),
        rows: [],
        assetInventory: [],
        assetInventoryStats: stats,
        assetAnomalies: [],
      });
    expect(serializeEnvelope(mkEnv())).toBe(serializeEnvelope(mkEnv()));
  });

  it('places schema_version as the first key in the JSON output', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    const out = serializeEnvelope(env);
    expect(out.trimStart().startsWith('{\n  "schema_version": 1')).toBe(true);
  });
});

describe('writeExtractJson', () => {
  it('writes envelope to disk and round-trips through JSON.parse', async () => {
    const outPath = path.join(tmpRoot, 'out', 'modx-extract.json');
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: { total_count: 0, size_zero_count: 0, walked_dirs: [] },
      assetAnomalies: [],
    });
    await writeExtractJson(env, outPath);
    const parsed = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.run_id).toBe('r');
  });
});

function classified(overrides: Partial<ClassifiedRow> = {}): ClassifiedRow {
  return {
    modx_id: 1,
    target_type: 'page',
    locale: 'el',
    canonical_path: 'x',
    status: 'published',
    title: 't',
    body_html: 'b',
    seo_meta_title: '',
    seo_meta_description: '',
    parent_modx_id: null,
    category_modx_id: null,
    legacy_paths: [],
    needs_review_seed: false,
    needs_review_reasons: [],
    modx_raw: {
      uri: 'x',
      template: 8,
      context_key: 'web',
      published: 1,
      deleted: 0,
      status_guess: null,
      parent: 0,
    },
    ...overrides,
  };
}

function skipped(overrides: Partial<SkippedRow> = {}): SkippedRow {
  return {
    modx_id: 99,
    skip_reason: 'unknown_template',
    modx_raw: { uri: '', template: 1, context_key: 'web', pagetitle: '' },
    ...overrides,
  };
}

describe('deriveCounts', () => {
  it('seeds all buckets at zero with no rows', () => {
    expect(deriveCounts([])).toEqual(emptyCounts());
  });

  it('tallies classified rows by target_type + locale', () => {
    const rows: ExtractRow[] = [
      classified({ modx_id: 1, target_type: 'page', locale: 'el' }),
      classified({ modx_id: 2, target_type: 'page', locale: 'ru' }),
      classified({ modx_id: 3, target_type: 'disease', locale: 'el' }),
      classified({ modx_id: 4, target_type: 'service-category', locale: 'ru' }),
    ];
    const c = deriveCounts(rows);
    expect(c.classified).toBe(4);
    expect(c.skipped).toBe(0);
    expect(c.by_target_type).toEqual({
      page: 2,
      disease: 1,
      'disease-category': 0,
      service: 0,
      'service-category': 1,
    });
    expect(c.by_locale).toEqual({ el: 2, ru: 2 });
  });

  it('tallies skipped rows by skip_reason', () => {
    const rows: ExtractRow[] = [
      skipped({ modx_id: 10, skip_reason: 'unknown_template' }),
      skipped({ modx_id: 11, skip_reason: 'empty_uri' }),
      skipped({ modx_id: 12, skip_reason: 'non_content_context' }),
      skipped({ modx_id: 13, skip_reason: 'unknown_template' }),
    ];
    const c = deriveCounts(rows);
    expect(c.classified).toBe(0);
    expect(c.skipped).toBe(4);
    expect(c.by_skip_reason).toEqual({
      unknown_template: 2,
      empty_uri: 1,
      non_content_context: 1,
    });
  });
});

describe('deriveUtf8Scan', () => {
  it('returns zero counters with no classified rows', () => {
    const scan = deriveUtf8Scan([]);
    expect(scan).toEqual({
      rows_scanned: 0,
      rows_with_replacement_char: 0,
      sample_modx_ids: [],
    });
  });

  it('only scans classified rows; skipped rows do not contribute', () => {
    const scan = deriveUtf8Scan([
      classified({ modx_id: 1 }),
      skipped({ modx_id: 2 }),
    ]);
    expect(scan.rows_scanned).toBe(1);
    expect(scan.rows_with_replacement_char).toBe(0);
  });

  it('detects U+FFFD in any text field', () => {
    const fields = ['title', 'body_html', 'seo_meta_title', 'seo_meta_description'] as const;
    for (const field of fields) {
      const scan = deriveUtf8Scan([classified({ modx_id: 42, [field]: 'bad � text' })]);
      expect(scan.rows_with_replacement_char).toBe(1);
      expect(scan.sample_modx_ids).toEqual([42]);
    }
  });

  it(`caps sample_modx_ids at ${UTF8_SCAN_SAMPLE_CAP}`, () => {
    const rows: ExtractRow[] = [];
    for (let i = 0; i < UTF8_SCAN_SAMPLE_CAP + 5; i++) {
      rows.push(classified({ modx_id: 1000 + i, title: '�' }));
    }
    const scan = deriveUtf8Scan(rows);
    expect(scan.rows_with_replacement_char).toBe(UTF8_SCAN_SAMPLE_CAP + 5);
    expect(scan.sample_modx_ids.length).toBe(UTF8_SCAN_SAMPLE_CAP);
  });
});

describe('assembleEnvelope with derived counts', () => {
  const stats: AssetInventoryStats = {
    total_count: 0,
    size_zero_count: 0,
    walked_dirs: [],
  };

  it('wires counts + utf8_scan automatically from rows', () => {
    const env = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 3,
      sourceDumpSha256: '0'.repeat(64),
      rows: [
        classified({ modx_id: 1, target_type: 'page', locale: 'el' }),
        classified({ modx_id: 2, target_type: 'disease', locale: 'ru', body_html: '�' }),
        skipped({ modx_id: 9, skip_reason: 'empty_uri' }),
      ],
      assetInventory: [],
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    expect(env.counts.classified).toBe(2);
    expect(env.counts.skipped).toBe(1);
    expect(env.counts.by_target_type.page).toBe(1);
    expect(env.counts.by_target_type.disease).toBe(1);
    expect(env.counts.by_skip_reason.empty_uri).toBe(1);
    expect(env.utf8_scan.rows_scanned).toBe(2);
    expect(env.utf8_scan.rows_with_replacement_char).toBe(1);
    expect(env.utf8_scan.sample_modx_ids).toEqual([2]);
  });

  it('passes tv_audit through verbatim and defaults to []', () => {
    const a = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      assetInventory: [],
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    expect(a.tv_audit).toEqual([]);

    const b = assembleEnvelope({
      runId: 'r',
      gitSha: 'g',
      sourceRowCount: 0,
      sourceDumpSha256: '0'.repeat(64),
      rows: [],
      tvAudit: [{ tmplvar_id: 1, name: 'metaTitle', rows_with_value: 280 }],
      assetInventory: [],
      assetInventoryStats: stats,
      assetAnomalies: [],
    });
    expect(b.tv_audit).toEqual([{ tmplvar_id: 1, name: 'metaTitle', rows_with_value: 280 }]);
  });
});

describe('coerceRawRow', () => {
  it('unwraps Buffers as utf8 strings', () => {
    const row = coerceRawRow({
      id: 1,
      context_key: 'web',
      template: 8,
      uri: Buffer.from('iatreio', 'utf8'),
      pagetitle: Buffer.from('Ιατρείο', 'utf8'),
      content: Buffer.from('<p>σ</p>', 'utf8'),
      properties: null,
      published: 1,
      deleted: 0,
      parent: 0,
      status_guess: null,
      seo_meta_title: null,
      seo_meta_description: null,
    });
    expect(row.uri).toBe('iatreio');
    expect(row.pagetitle).toBe('Ιατρείο');
    expect(row.content).toBe('<p>σ</p>');
  });

  it('coerces mysql2 bigints to regular numbers', () => {
    const row = coerceRawRow({
      id: BigInt(42),
      context_key: 'web',
      template: BigInt(8),
      uri: 'x',
      pagetitle: 'x',
      content: null,
      properties: null,
      published: BigInt(1),
      deleted: BigInt(0),
      parent: BigInt(0),
      status_guess: null,
      seo_meta_title: null,
      seo_meta_description: null,
    });
    expect(row.id).toBe(42);
    expect(row.template).toBe(8);
    expect(row.published).toBe(1);
  });

  it('passes null and undefined through as null on nullable string cols', () => {
    const row = coerceRawRow({
      id: 1,
      context_key: 'web',
      template: 8,
      uri: null,
      pagetitle: undefined,
      content: null,
      properties: null,
      published: 0,
      deleted: 0,
      parent: 0,
      status_guess: null,
      seo_meta_title: null,
      seo_meta_description: null,
    });
    expect(row.uri).toBeNull();
    expect(row.pagetitle).toBeNull();
  });
});

describe('resolveMysqlConfig', () => {
  it('uses locked defaults when env vars are absent', () => {
    expect(resolveMysqlConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3307,
      user: 'root',
      password: 'modx',
      database: 'modx',
    });
  });

  it('honors MYSQL_* overrides', () => {
    expect(
      resolveMysqlConfig({
        MYSQL_HOST: 'db',
        MYSQL_PORT: '3308',
        MYSQL_USER: 'u',
        MYSQL_PASSWORD: 'p',
        MYSQL_DATABASE: 'd',
      }),
    ).toEqual({ host: 'db', port: 3308, user: 'u', password: 'p', database: 'd' });
  });
});

describe('assertSupportedContexts', () => {
  it('accepts web and rus only', () => {
    expect(() =>
      assertSupportedContexts([
        {
          id: 1,
          context_key: 'web',
          template: 8,
          uri: 'home',
          pagetitle: 'Home',
          content: '',
          properties: null,
          published: 1,
          deleted: 0,
          parent: 0,
          status_guess: null,
          seo_meta_title: null,
          seo_meta_description: null,
        },
        {
          id: 2,
          context_key: 'rus',
          template: 8,
          uri: 'home',
          pagetitle: 'Home',
          content: '',
          properties: null,
          published: 1,
          deleted: 0,
          parent: 0,
          status_guess: null,
          seo_meta_title: null,
          seo_meta_description: null,
        },
      ]),
    ).not.toThrow();
  });

  it('halts when a non-web/rus context appears', () => {
    expect(() =>
      assertSupportedContexts([
        {
          id: 3,
          context_key: 'mgr',
          template: 8,
          uri: 'x',
          pagetitle: 'x',
          content: '',
          properties: null,
          published: 1,
          deleted: 0,
          parent: 0,
          status_guess: null,
          seo_meta_title: null,
          seo_meta_description: null,
        },
      ]),
    ).toThrow(/unexpected_context_key/);
  });
});

describe('seedExtractLedger', () => {
  it('writes classified/skipped records and append-only events', () => {
    const db = new Database(':memory:');
    try {
      ensureLedgerSchema(db);
      const info = db
        .prepare(
          `INSERT INTO migration_run (mode, git_sha, run_label) VALUES ('extract', 'abc1234', 'run-a')`,
        )
        .run();
      const runId = Number(info.lastInsertRowid);

      seedExtractLedger(db, runId, [
        classified({ modx_id: 1, target_type: 'page', locale: 'el' }),
        skipped({
          modx_id: 2,
          skip_reason: 'unknown_template',
          modx_raw: { uri: 'legacy', template: 15, context_key: 'rus', pagetitle: 'Legacy' },
        }),
      ]);

      const records = db
        .prepare(
          `SELECT modx_id, locale, target_type, state, reason_code, needs_review
             FROM migration_record
            WHERE run_id = ?
            ORDER BY modx_id ASC`,
        )
        .all(runId);
      expect(records).toEqual([
        {
          modx_id: 1,
          locale: 'el',
          target_type: 'page',
          state: 'classified',
          reason_code: null,
          needs_review: 0,
        },
        {
          modx_id: 2,
          locale: 'ru',
          target_type: 'unknown',
          state: 'skipped',
          reason_code: 'unknown_template',
          needs_review: 0,
        },
      ]);

      const events = db
        .prepare(
          `SELECT modx_id, from_state, to_state, stage, attempt, reason_code, error_detail
             FROM migration_event
            WHERE run_id = ?
            ORDER BY id ASC`,
        )
        .all(runId);
      expect(events).toEqual([
        { modx_id: 1, from_state: null, to_state: 'discovered', stage: 'extract', attempt: 0, reason_code: null, error_detail: null },
        { modx_id: 1, from_state: 'discovered', to_state: 'classified', stage: 'classify', attempt: 0, reason_code: null, error_detail: null },
        { modx_id: 2, from_state: null, to_state: 'discovered', stage: 'extract', attempt: 0, reason_code: null, error_detail: null },
        {
          modx_id: 2,
          from_state: 'discovered',
          to_state: 'skipped',
          stage: 'classify',
          attempt: 0,
          reason_code: 'unknown_template',
          error_detail: 'unknown_template',
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('newRunId', () => {
  it('produces YYYYMMDDTHHMMSSZ-<sha>', () => {
    const id = newRunId('abc1234', new Date(Date.UTC(2026, 3, 21, 10, 15, 30)));
    expect(id).toBe('20260421T101530Z-abc1234');
  });
});
