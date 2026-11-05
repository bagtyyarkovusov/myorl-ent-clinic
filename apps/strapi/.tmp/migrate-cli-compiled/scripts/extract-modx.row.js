"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMPLATE_TO_TARGET = void 0;
exports.classifyContextKey = classifyContextKey;
exports.parseLegacyPaths = parseLegacyPaths;
exports.containsReplacementChar = containsReplacementChar;
exports.classifyRow = classifyRow;
const canonical_path_1 = require("../src/lib/canonical-path");
/** Locked MODX-template → Strapi-target mapping (Q1). */
exports.TEMPLATE_TO_TARGET = {
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
function classifyContextKey(ctx) {
    if (ctx === 'web')
        return 'el';
    if (ctx === 'rus')
        return 'ru';
    return null;
}
/**
 * Q7: parse `autoredirector.old_uri` from the `properties` JSON blob and
 * discard everything else. Missing/empty properties is treated as "no legacy
 * paths" (not an error). Malformed JSON or a non-string `old_uri` with a
 * present value is reported as unparseable so the importer can flag the row.
 */
function parseLegacyPaths(properties) {
    if (properties === null || properties === undefined || properties === '') {
        return { ok: true, paths: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(properties);
    }
    catch {
        return { ok: false };
    }
    if (parsed === null || typeof parsed !== 'object')
        return { ok: true, paths: [] };
    const redir = parsed.autoredirector;
    if (redir === undefined || redir === null)
        return { ok: true, paths: [] };
    if (typeof redir !== 'object')
        return { ok: false };
    const raw = redir.old_uri;
    if (raw === undefined || raw === null || raw === '')
        return { ok: true, paths: [] };
    if (typeof raw !== 'string')
        return { ok: false };
    return { ok: true, paths: [raw] };
}
/** Unicode replacement character — indicator of a prior decoding mishap. */
const REPLACEMENT_CHAR = '�';
function containsReplacementChar(value) {
    return typeof value === 'string' && value.includes(REPLACEMENT_CHAR);
}
/** Produce a skipped row with the locked minimal-audit shape (Q3 + Q5). */
function makeSkipped(raw, reason) {
    var _a, _b;
    return {
        modx_id: raw.id,
        skip_reason: reason,
        modx_raw: {
            uri: (_a = raw.uri) !== null && _a !== void 0 ? _a : '',
            template: raw.template,
            context_key: raw.context_key,
            pagetitle: (_b = raw.pagetitle) !== null && _b !== void 0 ? _b : '',
        },
    };
}
/**
 * Classify a raw MODX row into either a {@link ClassifiedRow} (to be merged)
 * or a {@link SkippedRow} (documented for audit). Pure.
 */
function classifyRow(raw) {
    var _a, _b, _c, _d;
    const locale = classifyContextKey(raw.context_key);
    if (locale === null)
        return makeSkipped(raw, 'non_content_context');
    if (raw.uri === null || raw.uri === undefined || raw.uri.trim() === '') {
        return makeSkipped(raw, 'empty_uri');
    }
    const target = exports.TEMPLATE_TO_TARGET[raw.template];
    if (target === undefined)
        return makeSkipped(raw, 'unknown_template');
    const canonical_path = (0, canonical_path_1.normalizeCanonicalPath)(raw.uri);
    const status = raw.published === 1 && raw.deleted === 0 ? 'published' : 'draft';
    const reasons = [];
    if (raw.deleted === 1)
        reasons.push('deleted_flag');
    if (raw.status_guess === 'review')
        reasons.push('status_guess_review');
    const parsed = parseLegacyPaths(raw.properties);
    if (!parsed.ok)
        reasons.push('properties_column_unparseable');
    const legacy_paths = parsed.ok ? parsed.paths : [];
    // Q6: parent_modx_id vs category_modx_id are derived separately based on target type.
    //   page             → parent_modx_id = hierarchy parent if any;  category_modx_id = null
    //   disease          → parent_modx_id = null;                     category_modx_id = MODX parent
    //   service          → parent_modx_id = null;                     category_modx_id = MODX parent
    //   disease-category → parent_modx_id = null;                     category_modx_id = null
    //   service-category → parent_modx_id = null;                     category_modx_id = null
    let parent_modx_id = null;
    let category_modx_id = null;
    const modxParent = raw.parent > 0 ? raw.parent : null;
    if (target === 'page') {
        parent_modx_id = modxParent;
    }
    else if (target === 'disease' || target === 'service') {
        category_modx_id = modxParent;
    }
    return {
        modx_id: raw.id,
        target_type: target,
        locale,
        canonical_path,
        status,
        title: (_a = raw.pagetitle) !== null && _a !== void 0 ? _a : '',
        body_html: (_b = raw.content) !== null && _b !== void 0 ? _b : '',
        seo_meta_title: (_c = raw.seo_meta_title) !== null && _c !== void 0 ? _c : '',
        seo_meta_description: (_d = raw.seo_meta_description) !== null && _d !== void 0 ? _d : '',
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
