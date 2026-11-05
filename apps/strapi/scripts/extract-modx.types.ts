/**
 * Phase 6.5 MODX extractor — shared row/envelope types.
 *
 * Locked by the 2026-04-21 Q11 row-shape grill. The row and envelope shapes
 * below are the committed contract between `extract-modx.ts` and the future
 * merge importer; changes require a new grill and a bump of `schema_version`.
 *
 * See plans/gh-issue-6_5-content-hydration.md → "Extract JSON format".
 */

export type TargetType =
  | 'page'
  | 'disease'
  | 'disease-category'
  | 'service'
  | 'service-category';

export type Locale = 'el' | 'ru';

export type RowStatus = 'published' | 'draft';

export type NeedsReviewReason =
  | 'deleted_flag'
  | 'status_guess_review'
  | 'malformed_autoredirector'
  | 'properties_column_unparseable';

export type SkipReason =
  | 'non_content_context'
  | 'unknown_template'
  | 'empty_uri';

/** Minimal raw-column audit snapshot for a classified row. */
export type ClassifiedModxRaw = {
  uri: string;
  template: number;
  context_key: string;
  published: number;
  deleted: number;
  status_guess: string | null;
  parent: number;
};

/** Minimal raw-column audit snapshot for a skipped row. */
export type SkippedModxRaw = {
  uri: string;
  template: number;
  context_key: string;
  pagetitle: string;
};

export type ClassifiedRow = {
  modx_id: number;
  target_type: TargetType;
  locale: Locale;
  canonical_path: string;
  status: RowStatus;
  title: string;
  body_html: string;
  seo_meta_title: string;
  seo_meta_description: string;
  parent_modx_id: number | null;
  category_modx_id: number | null;
  legacy_paths: string[];
  needs_review_seed: boolean;
  needs_review_reasons: NeedsReviewReason[];
  modx_raw: ClassifiedModxRaw;
};

export type SkippedRow = {
  modx_id: number;
  skip_reason: SkipReason;
  modx_raw: SkippedModxRaw;
};

export type ExtractRow = ClassifiedRow | SkippedRow;

export function isClassifiedRow(row: ExtractRow): row is ClassifiedRow {
  return (row as ClassifiedRow).target_type !== undefined;
}

/** Single asset-inventory entry, recorded relative to `public_html/`. */
export type AssetInventoryEntry = {
  path: string;
  size_bytes: number;
  sha256: string;
};

/** Walked-asset summary counters. */
export type AssetInventoryStats = {
  total_count: number;
  size_zero_count: number;
  walked_dirs: string[];
};

export type AssetAnomaly = {
  path: string;
  reason: 'size_zero' | 'unreadable' | 'non_utf8_name';
  detail?: string;
};

/** Per-template-variable audit bucket (TV coverage diagnostics). */
export type TvAuditEntry = {
  tmplvar_id: number;
  name: string;
  rows_with_value: number;
};

export type Utf8Scan = {
  rows_scanned: number;
  rows_with_replacement_char: number;
  sample_modx_ids: number[];
};

export type ExtractCounts = {
  classified: number;
  skipped: number;
  by_target_type: Record<TargetType, number>;
  by_locale: Record<Locale, number>;
  by_skip_reason: Record<SkipReason, number>;
};

/** Envelope of `plans/modx-extract.json`. `schema_version` bumps on shape change. */
export type ExtractEnvelope = {
  schema_version: 1;
  run_id: string;
  git_sha: string;
  source_row_count: number;
  source_dump_sha256: string;
  counts: ExtractCounts;
  tv_audit: TvAuditEntry[];
  utf8_scan: Utf8Scan;
  asset_inventory_relative_to: 'public_html';
  asset_inventory_stats: AssetInventoryStats;
  asset_anomalies: AssetAnomaly[];
  asset_inventory: AssetInventoryEntry[];
  rows: ExtractRow[];
};

/** Nine subtrees the asset walker descends (under `public_html/`). */
export const ASSET_WALK_SUBDIRS: readonly string[] = [
  'files',
  'uploads',
  'webp',
  'template',
  'assets',
  'ru/files',
  'ru/assets',
  'ru/template',
  'ru/webp',
] as const;
