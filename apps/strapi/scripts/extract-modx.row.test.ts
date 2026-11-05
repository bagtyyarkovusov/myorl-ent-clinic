import { describe, it, expect } from 'vitest';
import {
  classifyContextKey,
  classifyRow,
  containsReplacementChar,
  parseLegacyPaths,
  TEMPLATE_TO_TARGET,
  type RawModxRow,
} from './extract-modx.row';

function raw(overrides: Partial<RawModxRow> = {}): RawModxRow {
  return {
    id: 1,
    context_key: 'web',
    template: 8,
    uri: 'foo',
    pagetitle: 'Foo',
    content: '<p>hi</p>',
    properties: null,
    published: 1,
    deleted: 0,
    parent: 0,
    status_guess: null,
    seo_meta_title: null,
    seo_meta_description: null,
    ...overrides,
  };
}

describe('classifyContextKey', () => {
  it('maps web → el', () => expect(classifyContextKey('web')).toBe('el'));
  it('maps rus → ru', () => expect(classifyContextKey('rus')).toBe('ru'));
  it('returns null for unknown context (e.g. mgr)', () => {
    expect(classifyContextKey('mgr')).toBeNull();
    expect(classifyContextKey('')).toBeNull();
  });
});

describe('TEMPLATE_TO_TARGET', () => {
  it('includes all locked page templates', () => {
    expect(TEMPLATE_TO_TARGET[7]).toBe('page');
    expect(TEMPLATE_TO_TARGET[8]).toBe('page');
    expect(TEMPLATE_TO_TARGET[18]).toBe('page');
    expect(TEMPLATE_TO_TARGET[20]).toBe('page');
  });

  it('includes disease + category templates', () => {
    expect(TEMPLATE_TO_TARGET[10]).toBe('disease-category');
    expect(TEMPLATE_TO_TARGET[11]).toBe('disease');
  });

  it('includes service + category templates', () => {
    expect(TEMPLATE_TO_TARGET[12]).toBe('service-category');
    expect(TEMPLATE_TO_TARGET[13]).toBe('service');
  });

  it('does NOT include legacy off-list templates', () => {
    for (const t of [0, 1, 2, 3, 5, 6, 14, 15, 16, 17]) {
      expect(TEMPLATE_TO_TARGET[t]).toBeUndefined();
    }
  });
});

describe('parseLegacyPaths', () => {
  it('returns no paths when properties is null/empty', () => {
    expect(parseLegacyPaths(null)).toEqual({ ok: true, paths: [] });
    expect(parseLegacyPaths('')).toEqual({ ok: true, paths: [] });
    expect(parseLegacyPaths(undefined)).toEqual({ ok: true, paths: [] });
  });

  it('extracts autoredirector.old_uri', () => {
    const props = '{"autoredirector":{"old_uri":"iatreio/"}}';
    expect(parseLegacyPaths(props)).toEqual({ ok: true, paths: ['iatreio/'] });
  });

  it('handles escaped slashes in the dump', () => {
    // MODX stores forward slashes as \/ in JSON inside MySQL.
    const props = '{"autoredirector":{"old_uri":"pathiseis\\/"}}';
    expect(parseLegacyPaths(props)).toEqual({ ok: true, paths: ['pathiseis/'] });
  });

  it('returns no paths when autoredirector is absent', () => {
    expect(parseLegacyPaths('{"other":{"k":"v"}}')).toEqual({ ok: true, paths: [] });
  });

  it('returns no paths when old_uri is absent or empty', () => {
    expect(parseLegacyPaths('{"autoredirector":{}}')).toEqual({ ok: true, paths: [] });
    expect(parseLegacyPaths('{"autoredirector":{"old_uri":""}}')).toEqual({
      ok: true,
      paths: [],
    });
  });

  it('flags malformed JSON as unparseable (ok:false)', () => {
    expect(parseLegacyPaths('{not-json')).toEqual({ ok: false });
  });

  it('flags non-string old_uri as unparseable (malformed autoredirector)', () => {
    expect(parseLegacyPaths('{"autoredirector":{"old_uri":42}}')).toEqual({ ok: false });
  });

  it('flags non-object autoredirector as unparseable', () => {
    expect(parseLegacyPaths('{"autoredirector":"oops"}')).toEqual({ ok: false });
  });

  it('discards non-autoredirector keys (Q7: discard rest)', () => {
    const props = '{"autoredirector":{"old_uri":"a"},"something_else":{"x":"y"}}';
    expect(parseLegacyPaths(props)).toEqual({ ok: true, paths: ['a'] });
  });
});

describe('containsReplacementChar', () => {
  it('detects U+FFFD', () => {
    expect(containsReplacementChar('clean')).toBe(false);
    expect(containsReplacementChar('bad � text')).toBe(true);
  });

  it('handles null/undefined/empty safely', () => {
    expect(containsReplacementChar(null)).toBe(false);
    expect(containsReplacementChar(undefined)).toBe(false);
    expect(containsReplacementChar('')).toBe(false);
  });
});

describe('classifyRow — skipped paths', () => {
  it('skips rows in non-content contexts (e.g. mgr)', () => {
    const r = classifyRow(raw({ id: 500, context_key: 'mgr' }));
    expect(r).toEqual({
      modx_id: 500,
      skip_reason: 'non_content_context',
      modx_raw: {
        uri: 'foo',
        template: 8,
        context_key: 'mgr',
        pagetitle: 'Foo',
      },
    });
  });

  it('skips rows with empty URI (whitespace-only)', () => {
    const r = classifyRow(raw({ id: 501, uri: '   ' }));
    expect('skip_reason' in r && r.skip_reason).toBe('empty_uri');
  });

  it('skips rows with null URI', () => {
    const r = classifyRow(raw({ id: 502, uri: null }));
    expect('skip_reason' in r && r.skip_reason).toBe('empty_uri');
  });

  it('skips rows with unknown templates', () => {
    for (const t of [0, 1, 2, 3, 5, 6, 14, 15, 16, 17]) {
      const r = classifyRow(raw({ id: 600 + t, template: t }));
      expect('skip_reason' in r && r.skip_reason).toBe('unknown_template');
    }
  });

  it('attaches minimal audit shape (Q3) — no body/properties/SEO', () => {
    const r = classifyRow(raw({ id: 700, context_key: 'mgr', content: '<giant>' }));
    expect(r).not.toHaveProperty('body_html');
    expect(r).not.toHaveProperty('seo_meta_title');
    expect('modx_raw' in r && Object.keys(r.modx_raw)).toEqual([
      'uri',
      'template',
      'context_key',
      'pagetitle',
    ]);
  });
});

describe('classifyRow — classified paths', () => {
  it('classifies a template-8 web row as a Greek page', () => {
    const r = classifyRow(raw({ id: 42, template: 8, context_key: 'web', uri: 'iatreio/' }));
    expect(r).toMatchObject({
      modx_id: 42,
      target_type: 'page',
      locale: 'el',
      canonical_path: 'iatreio/',
      status: 'published',
      parent_modx_id: null,
      category_modx_id: null,
      needs_review_seed: false,
      needs_review_reasons: [],
      legacy_paths: [],
    });
  });

  it('classifies a template-11 rus row as a Russian disease', () => {
    const r = classifyRow(
      raw({ id: 88, template: 11, context_key: 'rus', uri: 'x/y', parent: 500 }),
    );
    expect(r).toMatchObject({
      target_type: 'disease',
      locale: 'ru',
      parent_modx_id: null,
      category_modx_id: 500,
    });
  });

  it('sets category_modx_id for service, parent_modx_id for page', () => {
    const disease = classifyRow(raw({ template: 11, parent: 100 }));
    const service = classifyRow(raw({ template: 13, parent: 200 }));
    const page = classifyRow(raw({ template: 8, parent: 300 }));
    const cat = classifyRow(raw({ template: 10, parent: 400 }));
    expect('parent_modx_id' in disease && disease.parent_modx_id).toBeNull();
    expect('category_modx_id' in disease && disease.category_modx_id).toBe(100);
    expect('parent_modx_id' in service && service.parent_modx_id).toBeNull();
    expect('category_modx_id' in service && service.category_modx_id).toBe(200);
    expect('parent_modx_id' in page && page.parent_modx_id).toBe(300);
    expect('category_modx_id' in page && page.category_modx_id).toBeNull();
    expect('parent_modx_id' in cat && cat.parent_modx_id).toBeNull();
    expect('category_modx_id' in cat && cat.category_modx_id).toBeNull();
  });

  it('treats parent=0 as null', () => {
    const r = classifyRow(raw({ template: 8, parent: 0 }));
    expect('parent_modx_id' in r && r.parent_modx_id).toBeNull();
  });

  it('normalizes canonical path for homepage alias', () => {
    const r = classifyRow(raw({ uri: 'index/' }));
    expect('canonical_path' in r && r.canonical_path).toBe('index/');
    const h = classifyRow(raw({ uri: 'index' }));
    expect('canonical_path' in h && h.canonical_path).toBe('');
  });

  it('marks draft when deleted=1, regardless of published', () => {
    const r = classifyRow(raw({ published: 1, deleted: 1 }));
    expect('status' in r && r.status).toBe('draft');
  });

  it('marks draft when published=0', () => {
    const r = classifyRow(raw({ published: 0, deleted: 0 }));
    expect('status' in r && r.status).toBe('draft');
  });

  it('flags needs_review when deleted=1 (reason: deleted_flag)', () => {
    const r = classifyRow(raw({ deleted: 1 }));
    expect('needs_review_seed' in r && r.needs_review_seed).toBe(true);
    expect('needs_review_reasons' in r && r.needs_review_reasons).toContain('deleted_flag');
  });

  it('flags needs_review when status_guess=review', () => {
    const r = classifyRow(raw({ status_guess: 'review' }));
    expect('needs_review_reasons' in r && r.needs_review_reasons).toContain(
      'status_guess_review',
    );
  });

  it('flags needs_review when properties is malformed JSON', () => {
    const r = classifyRow(raw({ properties: 'not-json' }));
    expect('needs_review_reasons' in r && r.needs_review_reasons).toContain(
      'properties_column_unparseable',
    );
    expect('legacy_paths' in r && r.legacy_paths).toEqual([]);
  });

  it('populates legacy_paths from autoredirector.old_uri', () => {
    const r = classifyRow(
      raw({ properties: '{"autoredirector":{"old_uri":"pathiseis/"}}' }),
    );
    expect('legacy_paths' in r && r.legacy_paths).toEqual(['pathiseis/']);
  });

  it('carries SEO fields through verbatim and defaults null to ""', () => {
    const r1 = classifyRow(
      raw({ seo_meta_title: 'Hello', seo_meta_description: 'Desc' }),
    );
    expect('seo_meta_title' in r1 && r1.seo_meta_title).toBe('Hello');
    expect('seo_meta_description' in r1 && r1.seo_meta_description).toBe('Desc');

    const r2 = classifyRow(raw({ seo_meta_title: null, seo_meta_description: null }));
    expect('seo_meta_title' in r2 && r2.seo_meta_title).toBe('');
    expect('seo_meta_description' in r2 && r2.seo_meta_description).toBe('');
  });

  it('emits the locked ClassifiedRow key order', () => {
    const r = classifyRow(raw({ template: 8 }));
    expect(Object.keys(r)).toEqual([
      'modx_id',
      'target_type',
      'locale',
      'canonical_path',
      'status',
      'title',
      'body_html',
      'seo_meta_title',
      'seo_meta_description',
      'parent_modx_id',
      'category_modx_id',
      'legacy_paths',
      'needs_review_seed',
      'needs_review_reasons',
      'modx_raw',
    ]);
  });

  it('emits the locked modx_raw key order for classified rows', () => {
    const r = classifyRow(raw({ template: 8 })) as Extract<
      ReturnType<typeof classifyRow>,
      { target_type: unknown }
    >;
    expect(Object.keys(r.modx_raw)).toEqual([
      'uri',
      'template',
      'context_key',
      'published',
      'deleted',
      'status_guess',
      'parent',
    ]);
  });
});
