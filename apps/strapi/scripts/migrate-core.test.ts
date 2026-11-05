import { describe, expect, it } from 'vitest';
import type { ClassifiedRow } from './extract-modx.types';
import { buildRouteLookups } from '../src/lib/migration';
import {
  applyNeedsReviewSetOnlyOnTrue,
  buildCanonicalUsageIndex,
  reconcileWritingRowDecision,
  resolveExistingDocumentForMerge,
  selectContentMergeAction,
  selectUrlMappingMergeAction,
  sortPagesByDepth,
  sortRowsForPass,
  type DocumentSnapshot,
  type UrlMappingSnapshot,
} from './migrate-core';
import { shouldPromoteReasonCode, parseReasonCodeThresholdOverrides } from './halt-thresholds';

function snap(partial: Partial<DocumentSnapshot> & Pick<DocumentSnapshot, 'documentId' | 'uid' | 'locale'>): DocumentSnapshot {
  return {
    canonicalPath: '',
    modxId: null,
    _migrationContentHash: null,
    needs_review: false,
    publishedAt: null,
    parentDocumentId: null,
    categoryDocumentId: null,
    ...partial,
  };
}

describe('migrate-core', () => {
  describe('resolveExistingDocumentForMerge (AC-merge-2 backfill)', () => {
    it('returns null existing when no modx or canonical match → create path', () => {
      const indexes = buildCanonicalUsageIndex(new Map());
      const r = resolveExistingDocumentForMerge({
        uid: 'api::page.page',
        locale: 'el',
        modxId: 1,
        canonicalPath: 'about',
        indexes,
      });
      expect(r).toEqual({ ok: true, existing: null });
    });

    it('uses byModx hit when present', () => {
      const doc = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        modxId: 1,
        canonicalPath: 'about',
      });
      const map = new Map<string, DocumentSnapshot>([[`${doc.uid}:${doc.locale}:${doc.documentId}`, doc]]);
      const indexes = buildCanonicalUsageIndex(map);
      const r = resolveExistingDocumentForMerge({
        uid: 'api::page.page',
        locale: 'el',
        modxId: 1,
        canonicalPath: 'about',
        indexes,
      });
      expect(r).toEqual({ ok: true, existing: doc });
    });

    it('backfills from single canonical candidate when no modxId match', () => {
      const doc = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'skel',
        modxId: null,
        canonicalPath: 'about',
      });
      const map = new Map([[`${doc.uid}:${doc.locale}:${doc.documentId}`, doc]]);
      const indexes = buildCanonicalUsageIndex(map);
      const r = resolveExistingDocumentForMerge({
        uid: 'api::page.page',
        locale: 'el',
        modxId: 99,
        canonicalPath: 'about',
        indexes,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.existing).toBe(doc);
    });

    it('fails ambiguous_backfill_match when multiple canonical candidates', () => {
      const a = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'a',
        modxId: null,
        canonicalPath: 'dup',
      });
      const b = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'b',
        modxId: null,
        canonicalPath: 'dup',
      });
      const map = new Map([
        [`${a.uid}:${a.locale}:${a.documentId}`, a],
        [`${b.uid}:${b.locale}:${b.documentId}`, b],
      ]);
      const indexes = buildCanonicalUsageIndex(map);
      const r = resolveExistingDocumentForMerge({
        uid: 'api::page.page',
        locale: 'el',
        modxId: 1,
        canonicalPath: 'dup',
        indexes,
      });
      expect(r).toEqual({ ok: false, code: 'ambiguous_backfill_match', detail: '2 candidates' });
    });
  });

  describe('selectContentMergeAction (AC-merge-2)', () => {
    const hash = 'a'.repeat(64);

    it('create when no existing', () => {
      expect(
        selectContentMergeAction({
          existing: null,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: false,
          relationBlocked: false,
        }),
      ).toBe('create');
    });

    it('no_change when hash matches, status matches, no needs_review update', () => {
      const existing = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        _migrationContentHash: hash,
        needs_review: false,
        publishedAt: '2020-01-01',
      });
      expect(
        selectContentMergeAction({
          existing,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: false,
          relationBlocked: false,
        }),
      ).toBe('no_change');
    });

    it('update when hash differs', () => {
      const existing = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        _migrationContentHash: 'b'.repeat(64),
        needs_review: false,
        publishedAt: '2020-01-01',
      });
      expect(
        selectContentMergeAction({
          existing,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: false,
          relationBlocked: false,
        }),
      ).toBe('update');
    });

    it('update when needs_review flips false → true', () => {
      const existing = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        _migrationContentHash: hash,
        needs_review: false,
        publishedAt: '2020-01-01',
      });
      expect(
        selectContentMergeAction({
          existing,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: true,
          relationBlocked: false,
        }),
      ).toBe('update');
    });

    it('update when publish status differs', () => {
      const existing = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        _migrationContentHash: hash,
        needs_review: false,
        publishedAt: null,
      });
      expect(
        selectContentMergeAction({
          existing,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: false,
          relationBlocked: false,
        }),
      ).toBe('update');
    });

    it('forces update path when relationBlocked even if hash matches', () => {
      const existing = snap({
        uid: 'api::page.page',
        locale: 'el',
        documentId: 'd1',
        _migrationContentHash: hash,
        needs_review: false,
        publishedAt: '2020-01-01',
      });
      expect(
        selectContentMergeAction({
          existing,
          desiredContentHash: hash,
          desiredPublished: true,
          desiredNeedsReview: false,
          relationBlocked: true,
        }),
      ).toBe('update');
    });
  });

  describe('applyNeedsReviewSetOnlyOnTrue (AC-merge-6)', () => {
    it('omits needs_review on update when desired is false', () => {
      const data: Record<string, unknown> = { needs_review: false, title: 'x' };
      applyNeedsReviewSetOnlyOnTrue(data, false, true);
      expect(data.needs_review).toBeUndefined();
      expect(data.title).toBe('x');
    });

    it('keeps needs_review on create when desired is false', () => {
      const data: Record<string, unknown> = { needs_review: false };
      applyNeedsReviewSetOnlyOnTrue(data, false, false);
      expect(data.needs_review).toBe(false);
    });

    it('keeps needs_review true when desired', () => {
      const data: Record<string, unknown> = { needs_review: true };
      applyNeedsReviewSetOnlyOnTrue(data, true, true);
      expect(data.needs_review).toBe(true);
    });
  });

  describe('selectUrlMappingMergeAction (AC-merge-5)', () => {
    const desired = {
      path: 'about',
      type: 'canonical' as const,
      isAutoGenerated: false,
      legacyPaths: ['b', 'a'],
    };

    it('create when no existing', () => {
      expect(selectUrlMappingMergeAction(null, desired)).toBe('create');
    });

    it('no_change when equal after legacy sort', () => {
      const existing: UrlMappingSnapshot = {
        documentId: 'u1',
        locale: 'el',
        path: 'about',
        type: 'canonical',
        isAutoGenerated: false,
        legacyPaths: ['a', 'b'],
        relationField: 'page',
        relationDocumentId: 'd1',
      };
      expect(selectUrlMappingMergeAction(existing, desired)).toBe('no_change');
    });

    it('update when legacyPaths differ', () => {
      const existing: UrlMappingSnapshot = {
        documentId: 'u1',
        locale: 'el',
        path: 'about',
        type: 'canonical',
        isAutoGenerated: false,
        legacyPaths: ['x'],
        relationField: 'page',
        relationDocumentId: 'd1',
      };
      expect(selectUrlMappingMergeAction(existing, desired)).toBe('update');
    });
  });

  describe('reconcileWritingRowDecision (AC-merge-14)', () => {
    it('succeeded when doc hash matches ledger', () => {
      expect(
        reconcileWritingRowDecision({
          existingDoc: { _migrationContentHash: 'abc' },
          ledgerContentHash: 'abc',
        }),
      ).toEqual({ nextState: 'succeeded', reasonCode: 'reconciled_after_crash' });
    });

    it('failed when doc missing', () => {
      expect(
        reconcileWritingRowDecision({
          existingDoc: null,
          ledgerContentHash: 'abc',
        }),
      ).toEqual({ nextState: 'failed', reasonCode: 'crashed_before_write' });
    });

    it('failed when hash differs', () => {
      expect(
        reconcileWritingRowDecision({
          existingDoc: { _migrationContentHash: 'other' },
          ledgerContentHash: 'abc',
        }),
      ).toEqual({ nextState: 'failed', reasonCode: 'crashed_before_write' });
    });

    it('failed when stored hash null but ledger has hash', () => {
      expect(
        reconcileWritingRowDecision({
          existingDoc: { _migrationContentHash: null },
          ledgerContentHash: 'abc',
        }),
      ).toEqual({ nextState: 'failed', reasonCode: 'crashed_before_write' });
    });
  });

  describe('orphan_parent circuit breaker edge (baseline guard)', () => {
    const thresholds = parseReasonCodeThresholdOverrides(undefined);
    const total = 381;

    it('19 orphans does not promote at 5%', () => {
      expect(shouldPromoteReasonCode('orphan_parent', 19, total, thresholds)).toBe(false);
    });

    it('20 orphans promotes past 5%', () => {
      expect(shouldPromoteReasonCode('orphan_parent', 20, total, thresholds)).toBe(true);
    });
  });

  describe('sortRowsForPass / sortPagesByDepth', () => {
    const rows: ClassifiedRow[] = [
      {
        modx_id: 2,
        target_type: 'page',
        locale: 'el',
        canonical_path: 'child',
        status: 'published',
        title: 'C',
        body_html: '',
        seo_meta_title: 'C',
        seo_meta_description: '',
        parent_modx_id: 1,
        category_modx_id: null,
        legacy_paths: [],
        needs_review_seed: false,
        needs_review_reasons: [],
        modx_raw: {
          uri: 'c',
          template: 8,
          context_key: 'web',
          published: 1,
          deleted: 0,
          status_guess: null,
          parent: 1,
        },
      },
      {
        modx_id: 1,
        target_type: 'page',
        locale: 'el',
        canonical_path: 'parent',
        status: 'published',
        title: 'P',
        body_html: '',
        seo_meta_title: 'P',
        seo_meta_description: '',
        parent_modx_id: null,
        category_modx_id: null,
        legacy_paths: [],
        needs_review_seed: false,
        needs_review_reasons: [],
        modx_raw: {
          uri: 'p',
          template: 8,
          context_key: 'web',
          published: 1,
          deleted: 0,
          status_guess: null,
          parent: 0,
        },
      },
    ];
    const lookups = buildRouteLookups(rows);

    it('sortRowsForPass filters and sorts by modx_id', () => {
      const sorted = sortRowsForPass(lookups.by_modx_id, ['page']);
      expect(sorted.map((r) => r.modx_id)).toEqual([1, 2]);
    });

    it('sortPagesByDepth orders parent before child', () => {
      const sorted = sortPagesByDepth(lookups.by_modx_id);
      expect(sorted.map((r) => r.modx_id)).toEqual([1, 2]);
    });
  });
});
