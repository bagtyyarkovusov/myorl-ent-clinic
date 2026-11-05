import { describe, expect, it } from 'vitest';
import type { ExtractEnvelope } from '../../scripts/extract-modx.types';
import {
  buildAssetPathSet,
  buildDesiredContentPayload,
  buildDesiredUrlMapping,
  buildRouteLookups,
  normalizeLegacyPath,
  normalizeLegacyPaths,
  rewriteBodyHtml,
  routePathFor,
} from './migration';

const envelope: ExtractEnvelope = {
  schema_version: 1,
  run_id: 'run-a',
  git_sha: 'abc1234',
  source_row_count: 2,
  source_dump_sha256: 'f'.repeat(64),
  counts: {
    classified: 2,
    skipped: 0,
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
      unknown_template: 0,
      empty_uri: 0,
    },
  },
  tv_audit: [],
  utf8_scan: { rows_scanned: 2, rows_with_replacement_char: 0, sample_modx_ids: [] },
  asset_inventory_relative_to: 'public_html',
  asset_inventory_stats: { total_count: 1, size_zero_count: 0, walked_dirs: ['assets'] },
  asset_anomalies: [],
  asset_inventory: [{ path: 'assets/hero.jpg', size_bytes: 10, sha256: 'a'.repeat(64) }],
  rows: [
    {
      modx_id: 1,
      target_type: 'page',
      locale: 'el',
      canonical_path: 'about',
      status: 'published',
      title: 'About',
      body_html: '<p><a href="/legacy-about">legacy</a></p>',
      seo_meta_title: 'About',
      seo_meta_description: '',
      parent_modx_id: null,
      category_modx_id: null,
      legacy_paths: ['/legacy-about'],
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
    {
      modx_id: 2,
      target_type: 'disease',
      locale: 'el',
      canonical_path: 'sleep-apnea',
      status: 'published',
      title: 'Sleep Apnea',
      body_html: '<p><img src="https://myorl.gr/assets/hero.jpg" /></p>',
      seo_meta_title: 'Sleep Apnea',
      seo_meta_description: 'Desc',
      parent_modx_id: null,
      category_modx_id: 10,
      legacy_paths: ['/legacy-sleep'],
      needs_review_seed: false,
      needs_review_reasons: [],
      modx_raw: {
        uri: 'sleep-apnea',
        template: 11,
        context_key: 'web',
        published: 1,
        deleted: 0,
        status_guess: null,
        parent: 10,
      },
    },
  ],
};

describe('migration helpers', () => {
  it('normalizes legacy paths from absolute and locale-prefixed URLs', () => {
    expect(normalizeLegacyPath('https://myorl.gr/el/about')).toBe('about');
    expect(normalizeLegacyPath('/ru/index')).toBe('');
  });

  it('builds locale-prefixed frontend routes', () => {
    expect(routePathFor('el', '')).toBe('/el');
    expect(routePathFor('ru', 'sleep-apnea')).toBe('/ru/sleep-apnea');
  });

  it('rewrites internal links, shortcodes, and asset URLs', () => {
    const lookups = buildRouteLookups(envelope.rows);
    const assetPaths = buildAssetPathSet(envelope);

    const rewritten = rewriteBodyHtml(
      '<p><a href="/legacy-about">legacy</a> [[~2]] <img src="https://myorl.gr/assets/hero.jpg" /></p>',
      { locale: 'el', lookups, asset_paths: assetPaths },
    );

    expect(rewritten.html).toContain('href="/el/about"');
    expect(rewritten.html).toContain('/el/sleep-apnea');
    expect(rewritten.html).toContain('src="/assets/hero.jpg"');
    expect(rewritten.annotations).toEqual([]);
  });

  it('annotates unresolved shortcodes and missing assets', () => {
    const lookups = buildRouteLookups(envelope.rows);
    const rewritten = rewriteBodyHtml('<p>[[snippet]] <img src="/assets/missing.jpg" /></p>', {
      locale: 'el',
      lookups,
      asset_paths: new Set(),
    });

    expect(rewritten.html).toContain('<!-- MODX:unresolved:[[snippet]] -->');
    expect(rewritten.html).toContain('data-migration-missing-asset="true"');
    expect(rewritten.annotations).toEqual([
      { reason_code: 'unresolved_modx_shortcode', detail: '[[snippet]]' },
      { reason_code: 'missing_asset', detail: 'assets/missing.jpg' },
    ]);
  });

  it('builds the desired content payload with hash and needs_review flag', () => {
    const lookups = buildRouteLookups(envelope.rows);
    const assetPaths = buildAssetPathSet(envelope);
    const row = envelope.rows[1];
    if (!('target_type' in row)) throw new Error('expected classified row');

    const desired = buildDesiredContentPayload(row, {
      locale: row.locale,
      lookups,
      asset_paths: assetPaths,
    });

    expect(desired.uid).toBe('api::disease.disease');
    expect(desired.data).toMatchObject({
      title: 'Sleep Apnea',
      canonicalPath: 'sleep-apnea',
      modxId: 2,
      needs_review: false,
      seo: { metaTitle: 'Sleep Apnea', metaDescription: 'Desc' },
    });
    expect(typeof desired.content_hash).toBe('string');
    expect(desired.content_hash.length).toBe(64);
  });

  it('filters colliding legacy paths from desired UrlMapping payloads', () => {
    const lookups = buildRouteLookups(envelope.rows);
    const legacyOwners = new Map<string, number>([['el:about', 999]]);
    const row = envelope.rows[0];
    if (!('target_type' in row)) throw new Error('expected classified row');

    const mapping = buildDesiredUrlMapping(
      { ...row, legacy_paths: ['/about', '/legacy-about', '/legacy-about'] },
      lookups,
      legacyOwners,
    );

    expect(mapping.desired.legacyPaths).toEqual(['legacy-about']);
    expect(mapping.annotations).toEqual([
      { reason_code: 'legacy_path_ambiguous', detail: 'about' },
    ]);
  });

  it('normalizes, dedupes, and sorts legacy paths', () => {
    expect(normalizeLegacyPaths(['/b', 'https://myorl.gr/a', '/b'])).toEqual(['a', 'b']);
  });
});
