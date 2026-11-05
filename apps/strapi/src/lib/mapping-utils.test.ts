import { describe, expect, it } from 'vitest';
import { mapModxRecord, type ModxRecord } from './mapping-utils';

function rec(overrides: Partial<ModxRecord>): ModxRecord {
  return {
    id: '1',
    locale: 'el',
    uri: '/about',
    pagetitle: 'About',
    template: '8',
    published: '1',
    deleted: '0',
    status_guess: 'candidate',
    ...overrides,
  };
}

describe('mapModxRecord — template → type matrix', () => {
  it('template 8 → page', () => {
    expect(mapModxRecord(rec({ template: '8' })).type).toBe('page');
  });

  it('template 18 → page', () => {
    expect(mapModxRecord(rec({ template: '18' })).type).toBe('page');
  });

  it('template 20 → page', () => {
    expect(mapModxRecord(rec({ template: '20' })).type).toBe('page');
  });

  it('template 7 → page', () => {
    expect(mapModxRecord(rec({ template: '7' })).type).toBe('page');
  });

  it('template 11 → disease', () => {
    expect(mapModxRecord(rec({ template: '11', uri: '/d/flu' })).type).toBe('disease');
  });

  it('template 10 → disease-category', () => {
    expect(mapModxRecord(rec({ template: '10', uri: '/d' })).type).toBe('disease-category');
  });

  it('template 13 → service', () => {
    expect(mapModxRecord(rec({ template: '13', uri: '/s/surgery' })).type).toBe('service');
  });

  it('template 12 → service-category', () => {
    expect(mapModxRecord(rec({ template: '12', uri: '/s' })).type).toBe('service-category');
  });

  it('unmapped template 0 → unknown (silently skipped today; migration-report gap #3)', () => {
    expect(mapModxRecord(rec({ template: '0' })).type).toBe('unknown');
  });

  it('unmapped template 3 → unknown', () => {
    expect(mapModxRecord(rec({ template: '3' })).type).toBe('unknown');
  });
});

describe('mapModxRecord — locale normalization', () => {
  it("MODX locale '0' → el", () => {
    expect(mapModxRecord(rec({ locale: '0' })).locale).toBe('el');
  });

  it("MODX locale 'el' → el", () => {
    expect(mapModxRecord(rec({ locale: 'el' })).locale).toBe('el');
  });

  it("MODX locale '1' → ru (fallback branch)", () => {
    expect(mapModxRecord(rec({ locale: '1' })).locale).toBe('ru');
  });

  it("MODX locale 'ru' → ru", () => {
    expect(mapModxRecord(rec({ locale: 'ru' })).locale).toBe('ru');
  });
});

describe('mapModxRecord — status derivation', () => {
  it('published=1 + deleted=0 → published', () => {
    expect(mapModxRecord(rec({ published: '1', deleted: '0' })).status).toBe('published');
  });

  it('published=0 → draft', () => {
    expect(mapModxRecord(rec({ published: '0', deleted: '0' })).status).toBe('draft');
  });

  it('deleted=1 → draft regardless of published', () => {
    expect(mapModxRecord(rec({ published: '1', deleted: '1' })).status).toBe('draft');
  });
});

describe('mapModxRecord — shouldReview logic', () => {
  it('status_guess=candidate, deleted=0 → false', () => {
    expect(mapModxRecord(rec({ status_guess: 'candidate', deleted: '0' })).shouldReview).toBe(false);
  });

  it('status_guess=review → true', () => {
    expect(mapModxRecord(rec({ status_guess: 'review' })).shouldReview).toBe(true);
  });

  it('deleted=1 → true (regardless of status_guess)', () => {
    expect(mapModxRecord(rec({ status_guess: 'candidate', deleted: '1' })).shouldReview).toBe(true);
  });
});

describe('mapModxRecord — canonicalPath via shared normalizer', () => {
  it('/index → empty (homepage)', () => {
    expect(mapModxRecord(rec({ uri: '/index' })).canonicalPath).toBe('');
  });

  it('/about → about', () => {
    expect(mapModxRecord(rec({ uri: '/about' })).canonicalPath).toBe('about');
  });

  it('/services/surgery → services/surgery', () => {
    expect(mapModxRecord(rec({ uri: '/services/surgery' })).canonicalPath).toBe('services/surgery');
  });
});

describe('mapModxRecord — parent_id is optional (Q5d)', () => {
  it('accepts a record without parent_id', () => {
    const r: ModxRecord = {
      id: '10',
      locale: 'el',
      uri: '/about',
      pagetitle: 'About',
      template: '8',
      published: '1',
      deleted: '0',
      status_guess: 'candidate',
    };
    expect(() => mapModxRecord(r)).not.toThrow();
  });
});
