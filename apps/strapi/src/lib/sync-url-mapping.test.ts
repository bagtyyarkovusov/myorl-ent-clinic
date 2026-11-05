import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterDocumentAction } from './sync-url-mapping';

// Minimal Document Service fake. Each UID gets its own handler set.
type DocHandlers = {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function makeHandlers(): DocHandlers {
  return {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    findOne: vi.fn(async () => null),
    create: vi.fn(async (args: any) => ({ documentId: 'created-' + Math.random().toString(36).slice(2), ...args?.data })),
    update: vi.fn(async (args: any) => ({ documentId: args.documentId, ...args?.data })),
    delete: vi.fn(async () => ({ documentId: 'deleted' })),
  };
}

function makeFakeStrapi() {
  const byUid = new Map<string, DocHandlers>();
  const getHandlers = (uid: string): DocHandlers => {
    let h = byUid.get(uid);
    if (!h) {
      h = makeHandlers();
      byUid.set(uid, h);
    }
    return h;
  };
  return {
    strapi: {
      documents: (uid: string) => getHandlers(uid),
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    } as any,
    getHandlers,
  };
}

const URL_MAPPING_UID = 'api::url-mapping.url-mapping';
const PAGE_UID = 'api::page.page';

describe('afterDocumentAction — middleware suppression (Q1)', () => {
  beforeEach(() => {
    delete process.env.MIGRATION_IN_PROGRESS;
  });
  afterEach(() => {
    delete process.env.MIGRATION_IN_PROGRESS;
  });

  it('early-returns when MIGRATION_IN_PROGRESS=true; no document-service calls', async () => {
    process.env.MIGRATION_IN_PROGRESS = 'true';
    const { strapi, getHandlers } = makeFakeStrapi();

    await afterDocumentAction(
      strapi,
      {
        action: 'publish',
        uid: PAGE_UID,
        params: { documentId: 'doc-1', locale: 'el' },
      },
      { entries: [{ documentId: 'doc-1', locale: 'el', canonicalPath: 'about', publishedAt: '2026-04-19T00:00:00Z' }] }
    );

    // No calls to UrlMapping or Page under suppression
    const urlMapping = getHandlers(URL_MAPPING_UID);
    expect(urlMapping.findFirst).not.toHaveBeenCalled();
    expect(urlMapping.create).not.toHaveBeenCalled();
    expect(urlMapping.update).not.toHaveBeenCalled();
    expect(urlMapping.delete).not.toHaveBeenCalled();
  });

  it('runs normally when flag is unset', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();

    await afterDocumentAction(
      strapi,
      { action: 'publish', uid: PAGE_UID, params: { documentId: 'doc-1' } },
      { entries: [{ documentId: 'doc-1', locale: 'el', canonicalPath: 'about', publishedAt: '2026-04-19T00:00:00Z' }] }
    );

    const urlMapping = getHandlers(URL_MAPPING_UID);
    // findFirst probes for existing canonical + collision; create fires when no collision
    expect(urlMapping.findFirst).toHaveBeenCalled();
    expect(urlMapping.create).toHaveBeenCalled();
  });
});

describe('afterDocumentAction — publish path (characterization)', () => {
  it('publish with no existing canonical creates a canonical UrlMapping', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();

    await afterDocumentAction(
      strapi,
      { action: 'publish', uid: PAGE_UID, params: { documentId: 'doc-1' } },
      { entries: [{ documentId: 'doc-1', locale: 'el', canonicalPath: 'about', publishedAt: 't' }] }
    );

    const urlMapping = getHandlers(URL_MAPPING_UID);
    expect(urlMapping.create).toHaveBeenCalledOnce();
    const createArgs = urlMapping.create.mock.calls[0][0];
    expect(createArgs.locale).toBe('el');
    expect(createArgs.data).toMatchObject({ path: 'about', type: 'canonical', page: 'doc-1' });
  });

  it('publish with existing canonical at different path converts it to redirect_301 (slug drift)', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();
    const urlMapping = getHandlers(URL_MAPPING_UID);

    // First findFirst (existing canonical probe) returns an old row.
    // Second findFirst (collision probe on new path) returns null.
    urlMapping.findFirst
      .mockResolvedValueOnce({ documentId: 'old-map', path: 'old-slug' })
      .mockResolvedValueOnce(null);

    await afterDocumentAction(
      strapi,
      { action: 'publish', uid: PAGE_UID, params: { documentId: 'doc-1' } },
      { entries: [{ documentId: 'doc-1', locale: 'el', canonicalPath: 'new-slug', publishedAt: 't' }] }
    );

    expect(urlMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'old-map',
        data: expect.objectContaining({ type: 'redirect_301' }),
      })
    );
    expect(urlMapping.create).toHaveBeenCalledOnce();
  });

  it('publish where new path already maps to a different doc warns and skips (collision)', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();
    const urlMapping = getHandlers(URL_MAPPING_UID);

    urlMapping.findFirst
      .mockResolvedValueOnce(null) // no existing canonical for this doc
      .mockResolvedValueOnce({
        // collision row — path taken by a DIFFERENT page
        documentId: 'other-mapping',
        path: 'taken-slug',
        page: { documentId: 'other-doc' },
      });

    await afterDocumentAction(
      strapi,
      { action: 'publish', uid: PAGE_UID, params: { documentId: 'doc-1' } },
      { entries: [{ documentId: 'doc-1', locale: 'el', canonicalPath: 'taken-slug', publishedAt: 't' }] }
    );

    expect(strapi.log.warn).toHaveBeenCalled();
    expect(urlMapping.create).not.toHaveBeenCalled();
    expect(urlMapping.update).not.toHaveBeenCalled();
  });
});

describe('afterDocumentAction — unpublish / delete path (characterization)', () => {
  it('unpublish deletes the canonical UrlMapping for the given locale', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();
    const urlMapping = getHandlers(URL_MAPPING_UID);
    urlMapping.findMany.mockResolvedValueOnce([{ documentId: 'map-el', locale: 'el' }]);

    await afterDocumentAction(
      strapi,
      { action: 'unpublish', uid: PAGE_UID, params: { documentId: 'doc-1', locale: 'el' } },
      null
    );

    expect(urlMapping.delete).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'map-el', locale: 'el' })
    );
  });

  it("delete with locale='*' cascades across both routing locales", async () => {
    const { strapi, getHandlers } = makeFakeStrapi();
    const urlMapping = getHandlers(URL_MAPPING_UID);
    urlMapping.findMany
      .mockResolvedValueOnce([{ documentId: 'map-el', locale: 'el' }])
      .mockResolvedValueOnce([{ documentId: 'map-ru', locale: 'ru' }]);

    await afterDocumentAction(
      strapi,
      { action: 'delete', uid: PAGE_UID, params: { documentId: 'doc-1', locale: '*' } },
      null
    );

    expect(urlMapping.findMany).toHaveBeenCalledTimes(2);
    expect(urlMapping.delete).toHaveBeenCalledTimes(2);
    const deletedLocales = urlMapping.delete.mock.calls.map((c: any[]) => c[0].locale).sort();
    expect(deletedLocales).toEqual(['el', 'ru']);
  });
});

describe('afterDocumentAction — non-routable UID', () => {
  it('returns early for unknown UID', async () => {
    const { strapi, getHandlers } = makeFakeStrapi();

    await afterDocumentAction(
      strapi,
      { action: 'publish', uid: 'api::navigation.navigation', params: { documentId: 'nav-1' } },
      { entries: [{ documentId: 'nav-1', locale: 'el', publishedAt: 't' }] }
    );

    const urlMapping = getHandlers(URL_MAPPING_UID);
    expect(urlMapping.create).not.toHaveBeenCalled();
  });
});
