import { describe, expect, it } from 'vitest';
import { buildContentHashPayload, hashContentPayload } from './content-hash';

describe('content-hash', () => {
  it('builds the locked canonical payload shape', () => {
    expect(
      buildContentHashPayload({
        title: 'Home',
        body: '<p>Hello</p>',
        canonicalPath: '',
        seo: { metaTitle: 'Home', metaDescription: '' },
        parent_modx_id: null,
        category_modx_id: null,
      }),
    ).toEqual({
      title: 'Home',
      body: '<p>Hello</p>',
      canonicalPath: '',
      seo: { metaTitle: 'Home', metaDescription: '' },
      parent_modx_id: null,
      category_modx_id: null,
    });
  });

  it('produces stable hashes for equivalent inputs', () => {
    const input = {
      title: 'Sleep Apnea',
      body: '<p>Body</p>',
      canonicalPath: 'sleep-apnea',
      seo: { metaTitle: 'Sleep Apnea', metaDescription: 'Desc' },
      parent_modx_id: null,
      category_modx_id: 11,
    } as const;

    expect(hashContentPayload(input)).toBe(hashContentPayload({ ...input }));
  });

  it('changes when the rewritten body changes', () => {
    const base = {
      title: 'Sleep Apnea',
      body: '<p>Body</p>',
      canonicalPath: 'sleep-apnea',
      seo: { metaTitle: 'Sleep Apnea', metaDescription: 'Desc' },
      parent_modx_id: null,
      category_modx_id: 11,
    } as const;

    expect(hashContentPayload(base)).not.toBe(
      hashContentPayload({ ...base, body: '<p>Body <a href="/el/about">link</a></p>' }),
    );
  });

  it('treats absent seo as null in the payload', () => {
    expect(
      buildContentHashPayload({
        title: 'Category',
        body: '',
        canonicalPath: 'category',
        seo: null,
        parent_modx_id: null,
        category_modx_id: null,
      }),
    ).toEqual({
      title: 'Category',
      body: '',
      canonicalPath: 'category',
      seo: null,
      parent_modx_id: null,
      category_modx_id: null,
    });
  });

  it('matches the locked fixture hashes', () => {
    expect(
      hashContentPayload({
        title: 'Home',
        body: '<p>Hello</p>',
        canonicalPath: '',
        seo: { metaTitle: 'Home', metaDescription: '' },
        parent_modx_id: null,
        category_modx_id: null,
      }),
    ).toBe('be0944c4aa789e09ac95a85d2a56925f5dce42b3f5a38297d210ffb79a7f5d24');

    expect(
      hashContentPayload({
        title: 'Disease',
        body: '<p>Body</p>',
        canonicalPath: 'disease',
        seo: { metaTitle: 'Meta', metaDescription: 'Desc' },
        parent_modx_id: null,
        category_modx_id: 10,
      }),
    ).toBe('f2933784662731a889ce4e0c232f03188751d5645e47982d74c66c1e2b89d33e');

    expect(
      hashContentPayload({
        title: 'Service',
        body: '',
        canonicalPath: 'service',
        seo: null,
        parent_modx_id: null,
        category_modx_id: 12,
      }),
    ).toBe('e3da00a8547f4d49c7426c3d389212522dbc315c28d1e3a2df32cf01f3bcd638');
  });
});
