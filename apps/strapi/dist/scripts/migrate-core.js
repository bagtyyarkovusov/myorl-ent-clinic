"use strict";
/**
 * Pure merge logic extracted from migrate-cli.ts for unit testing and reuse.
 * Side-effectful I/O stays in migrate-cli.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.reconcileWritingRowDecision = exports.selectUrlMappingMergeAction = exports.applyNeedsReviewSetOnlyOnTrue = exports.selectContentMergeAction = exports.resolveExistingDocumentForMerge = exports.sortPagesByDepth = exports.sortRowsForPass = exports.buildCanonicalUsageIndex = void 0;
function buildCanonicalUsageIndex(contentSnapshots) {
    var _a;
    const byCanonical = new Map();
    const byModx = new Map();
    const byUidAndDocument = new Map();
    for (const snapshot of contentSnapshots.values()) {
        const canonicalKey = `${snapshot.uid}:${snapshot.locale}:${snapshot.canonicalPath}`;
        const current = (_a = byCanonical.get(canonicalKey)) !== null && _a !== void 0 ? _a : [];
        current.push(snapshot);
        byCanonical.set(canonicalKey, current);
        if (snapshot.modxId !== null) {
            byModx.set(`${snapshot.uid}:${snapshot.locale}:${snapshot.modxId}`, snapshot);
        }
        byUidAndDocument.set(`${snapshot.uid}:${snapshot.documentId}:${snapshot.locale}`, snapshot);
    }
    return { byCanonical, byModx, byUidAndDocument };
}
exports.buildCanonicalUsageIndex = buildCanonicalUsageIndex;
function sortRowsForPass(rows, targetTypes) {
    return [...rows.values()]
        .filter((row) => targetTypes.includes(row.target_type))
        .sort((a, b) => a.modx_id - b.modx_id);
}
exports.sortRowsForPass = sortRowsForPass;
function sortPagesByDepth(rows) {
    const pages = [...rows.values()].filter((row) => row.target_type === 'page');
    const depthCache = new Map();
    const getDepth = (row, stack = new Set()) => {
        if (depthCache.has(row.modx_id))
            return depthCache.get(row.modx_id);
        if (row.parent_modx_id == null)
            return 0;
        if (stack.has(row.modx_id))
            return 1000;
        const parent = rows.get(row.parent_modx_id);
        if (!parent || parent.target_type !== 'page')
            return 1;
        stack.add(row.modx_id);
        const depth = getDepth(parent, stack) + 1;
        stack.delete(row.modx_id);
        depthCache.set(row.modx_id, depth);
        return depth;
    };
    return pages.sort((a, b) => {
        const depthDelta = getDepth(a) - getDepth(b);
        return depthDelta !== 0 ? depthDelta : a.modx_id - b.modx_id;
    });
}
exports.sortPagesByDepth = sortPagesByDepth;
/**
 * Backfill pass 0 + collision guard: resolve which Strapi document (if any) receives the merge.
 */
function resolveExistingDocumentForMerge(args) {
    var _a, _b;
    const { uid, locale, modxId, canonicalPath, indexes } = args;
    const canonicalKey = `${uid}:${locale}:${canonicalPath}`;
    const canonicalCandidates = (_a = indexes.byCanonical.get(canonicalKey)) !== null && _a !== void 0 ? _a : [];
    let existing = (_b = indexes.byModx.get(`${uid}:${locale}:${modxId}`)) !== null && _b !== void 0 ? _b : null;
    if (!existing && canonicalCandidates.length > 1) {
        return { ok: false, code: 'ambiguous_backfill_match', detail: `${canonicalCandidates.length} candidates` };
    }
    if (!existing && canonicalCandidates.length === 1) {
        existing = canonicalCandidates[0];
    }
    const collisionOwner = canonicalCandidates.find((candidate) => !existing || candidate.documentId !== existing.documentId);
    if (collisionOwner && !existing) {
        return { ok: false, code: 'canonical_path_collision', detail: collisionOwner.documentId };
    }
    return { ok: true, existing };
}
exports.resolveExistingDocumentForMerge = resolveExistingDocumentForMerge;
/**
 * Hash-gated create / update / no-op (AC-merge-2).
 */
function selectContentMergeAction(args) {
    const { existing, desiredContentHash, desiredPublished, desiredNeedsReview, relationBlocked } = args;
    const statusMatches = Boolean(existing === null || existing === void 0 ? void 0 : existing.publishedAt) === desiredPublished;
    const needsReviewUpdate = desiredNeedsReview && !(existing === null || existing === void 0 ? void 0 : existing.needs_review);
    const hashMatches = !relationBlocked &&
        (existing === null || existing === void 0 ? void 0 : existing._migrationContentHash) != null &&
        existing._migrationContentHash === desiredContentHash;
    if (!existing) {
        return 'create';
    }
    if (hashMatches && !needsReviewUpdate && statusMatches) {
        return 'no_change';
    }
    return 'update';
}
exports.selectContentMergeAction = selectContentMergeAction;
/**
 * Set-only-on-true: never send `needs_review: false` on update — omit field so editor-cleared false survives (AC-merge-6).
 */
function applyNeedsReviewSetOnlyOnTrue(data, desiredNeedsReview, hasExisting) {
    if (!desiredNeedsReview && hasExisting) {
        delete data.needs_review;
    }
}
exports.applyNeedsReviewSetOnlyOnTrue = applyNeedsReviewSetOnlyOnTrue;
/**
 * Equality-gated UrlMapping writes; legacyPaths compared sorted (AC-merge-5).
 */
function selectUrlMappingMergeAction(existing, desired) {
    const desiredLegacySorted = [...desired.legacyPaths].sort();
    if (!existing) {
        return 'create';
    }
    const existingLegacySorted = [...existing.legacyPaths].sort();
    const equal = existing.path === desired.path &&
        existing.type === desired.type &&
        existing.isAutoGenerated === desired.isAutoGenerated &&
        JSON.stringify(existingLegacySorted) === JSON.stringify(desiredLegacySorted);
    return equal ? 'no_change' : 'update';
}
exports.selectUrlMappingMergeAction = selectUrlMappingMergeAction;
/**
 * Crash recovery: prior run left row in `writing` (AC-merge-14).
 */
function reconcileWritingRowDecision(args) {
    const { existingDoc, ledgerContentHash } = args;
    const ok = existingDoc != null &&
        existingDoc._migrationContentHash != null &&
        existingDoc._migrationContentHash === ledgerContentHash;
    if (ok) {
        return { nextState: 'succeeded', reasonCode: 'reconciled_after_crash' };
    }
    return { nextState: 'failed', reasonCode: 'crashed_before_write' };
}
exports.reconcileWritingRowDecision = reconcileWritingRowDecision;
