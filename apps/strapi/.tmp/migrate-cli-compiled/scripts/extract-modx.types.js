"use strict";
/**
 * Phase 6.5 MODX extractor — shared row/envelope types.
 *
 * Locked by the 2026-04-21 Q11 row-shape grill. The row and envelope shapes
 * below are the committed contract between `extract-modx.ts` and the future
 * merge importer; changes require a new grill and a bump of `schema_version`.
 *
 * See plans/gh-issue-6_5-content-hydration.md → "Extract JSON format".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSET_WALK_SUBDIRS = void 0;
exports.isClassifiedRow = isClassifiedRow;
function isClassifiedRow(row) {
    return row.target_type !== undefined;
}
/** Nine subtrees the asset walker descends (under `public_html/`). */
exports.ASSET_WALK_SUBDIRS = [
    'files',
    'uploads',
    'webp',
    'template',
    'assets',
    'ru/files',
    'ru/assets',
    'ru/template',
    'ru/webp',
];
