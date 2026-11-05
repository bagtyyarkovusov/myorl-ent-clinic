/**
 * Phase 6.5 MODX extractor — row classification + field derivation.
 *
 * Pure functions only — no IO, no DB. Tested in isolation via
 * `extract-modx.row.test.ts`. The main extractor (`extract-modx.ts`) wires
 * SQL rows through {@link classifyRow} one-at-a-time and feeds the result
 * array to {@link assembleEnvelope}.
 *
 * Spec: plans/gh-issue-6_5-content-hydration.md, locked by the Q1/Q4/Q5/Q6/Q7
 * row-shape grill on 2026-04-21.
 */

import { normalizeCanonicalPath } from '../src/lib/canonical-path';
import type {
  ClassifiedRow,
  ExtractRow,
  Locale,
  NeedsReviewReason,
  SkipReason,
  SkippedRow,
  TargetType,
} from './extract-modx.types';

/** Raw columns the SQL query yields for each `modx_site_content` row. */
export type RawModxRow = {
  id: number;
  context_key: string;
  template: number;
  uri: string | null;
  pagetitle: string | null;
  content: string | null;
  properties: string | null;
  published: number;
  deleted: number;
  parent: number;
  status_guess: string | null;
  seo_meta_title: string | null;
  seo_meta_description: string | null;
};

/** Locked MODX-template → Strapi-target mapping (Q1). */
export const TEMPLATE_TO_TARGET: Readonly<Record<number, TargetType>> = {
  7: 'page',
  8: 'page',
  18: 'page',
  20: 'page',
  10: 'disease-category',
  11: 'disease',
  12: 'service-category',
  13: 'service',
};

/** MODX context_key → Strapi locale. Any other value is a non-content context. */
export function classifyContextKey(ctx: string): Locale | null {
  if (ctx === 'web') return 'el';
  if (ctx === 'rus') return 'ru';
  return null;
}

export type LegacyPathsParse =
  | { ok: true; paths: string[] }
  | { ok: false };

/**
 * Q7: parse `autoredirector.old_uri` from the `properties` JSON blob and
 * discard everything else. Missing/empty properties is treated as "no legacy
 * paths" (not an error). Malformed JSON or a non-string `old_uri` with a
 * present value is reported as unparseable so the importer can flag the row.
 */
export function parseLegacyPaths(properties: string | null | undefined): LegacyPathsParse {
  if (properties === null || properties === undefined || properties === '') {
    return { ok: true, paths: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(properties);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: true, paths: [] };
  const redir = (parsed as Record<string, unknown>).autoredirector;
  if (redir === undefined || redir === null) return { ok: true, paths: [] };
  if (typeof redir !== 'object') return { ok: false };
  const raw = (redir as Record<string, unknown>).old_uri;
  if (raw === undefined || raw === null || raw === '') return { ok: true, paths: [] };
  if (typeof raw !== 'string') return { ok: false };
  return { ok: true, paths: [raw] };
}

/** Unicode replacement character — indicator of a prior decoding mishap. */
const REPLACEMENT_CHAR = '�';

export function containsReplacementChar(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes(REPLACEMENT_CHAR);
}

/** Produce a skipped row with the locked minimal-audit shape (Q3 + Q5). */
function makeSkipped(raw: RawModxRow, reason: SkipReason): SkippedRow {
  return {
    modx_id: raw.id,
    skip_reason: reason,
    modx_raw: {
      uri: raw.uri ?? '',
      template: raw.template,
      context_key: raw.context_key,
      pagetitle: raw.pagetitle ?? '',
    },
  };
}

/**
 * Classify a raw MODX row into either a {@link ClassifiedRow} (to be merged)
 * or a {@link SkippedRow} (documented for audit). Pure.
 */
export function classifyRow(raw: RawModxRow): ExtractRow {
  const locale = classifyContextKey(raw.context_key);
  if (locale === null) return makeSkipped(raw, 'non_content_context');

  if (raw.uri === null || raw.uri === undefined || raw.uri.trim() === '') {
    return makeSkipped(raw, 'empty_uri');
  }

  const target = TEMPLATE_TO_TARGET[raw.template];
  if (target === undefined) return makeSkipped(raw, 'unknown_template');

  const canonical_path = normalizeCanonicalPath(raw.uri);
  const status: 'published' | 'draft' =
    raw.published === 1 && raw.deleted === 0 ? 'published' : 'draft';

  const reasons: NeedsReviewReason[] = [];
  if (raw.deleted === 1) reasons.push('deleted_flag');
  if (raw.status_guess === 'review') reasons.push('status_guess_review');

  const parsed = parseLegacyPaths(raw.properties);
  if (!parsed.ok) reasons.push('properties_column_unparseable');
  const legacy_paths = parsed.ok ? parsed.paths : [];

  // Q6: parent_modx_id vs category_modx_id are derived separately based on target type.
  //   page             → parent_modx_id = hierarchy parent if any;  category_modx_id = null
  //   disease          → parent_modx_id = null;                     category_modx_id = MODX parent
  //   service          → parent_modx_id = null;                     category_modx_id = MODX parent
  //   disease-category → parent_modx_id = null;                     category_modx_id = null
  //   service-category → parent_modx_id = null;                     category_modx_id = null
  let parent_modx_id: number | null = null;
  let category_modx_id: number | null = null;
  const modxParent: number | null = raw.parent > 0 ? raw.parent : null;
  if (target === 'page') {
    parent_modx_id = modxParent;
  } else if (target === 'disease' || target === 'service') {
    category_modx_id = modxParent;
  }

  return {
    modx_id: raw.id,
    target_type: target,
    locale,
    canonical_path,
    status,
    title: raw.pagetitle ?? '',
    body_html: raw.content ?? '',
    seo_meta_title: raw.seo_meta_title ?? '',
    seo_meta_description: raw.seo_meta_description ?? '',
    parent_modx_id,
    category_modx_id,
    legacy_paths,
    needs_review_seed: reasons.length > 0,
    needs_review_reasons: reasons,
    modx_raw: {
      uri: raw.uri,
      template: raw.template,
      context_key: raw.context_key,
      published: raw.published,
      deleted: raw.deleted,
      status_guess: raw.status_guess,
      parent: raw.parent,
    },
  };
}
