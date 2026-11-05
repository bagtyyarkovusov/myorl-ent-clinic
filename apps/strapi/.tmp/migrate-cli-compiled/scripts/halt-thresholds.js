"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_REASON_CODE_THRESHOLDS = void 0;
exports.selectSucceededDeltaThreshold = selectSucceededDeltaThreshold;
exports.exceedsSucceededDelta = exceedsSucceededDelta;
exports.parseReasonCodeThresholdOverrides = parseReasonCodeThresholdOverrides;
exports.shouldPromoteReasonCode = shouldPromoteReasonCode;
exports.DEFAULT_REASON_CODE_THRESHOLDS = {
    unresolved_legacy_url: null,
    unresolved_modx_shortcode: null,
    missing_asset: 0.2,
    orphan_parent: 0.05,
    cross_locale_parent: 0.05,
    relation_type_mismatch: 0.05,
    circular_parent: 0.05,
    ambiguous_backfill_match: 0.05,
    legacy_path_collides_with_canonical: 0.1,
    legacy_path_ambiguous: 0.1,
};
function selectSucceededDeltaThreshold(expectedCount) {
    if (expectedCount < 20) {
        return { kind: 'absolute', limit: 1 };
    }
    if (expectedCount <= 100) {
        return { kind: 'absolute', limit: 3 };
    }
    return { kind: 'relative', limit: 0.1 };
}
function exceedsSucceededDelta(expectedCount, actualCount) {
    const threshold = selectSucceededDeltaThreshold(expectedCount);
    const delta = Math.abs(actualCount - expectedCount);
    if (threshold.kind === 'absolute') {
        return delta > threshold.limit;
    }
    return expectedCount > 0 && delta / expectedCount > threshold.limit;
}
function parseReasonCodeThresholdOverrides(rawValue) {
    if (!rawValue) {
        return { ...exports.DEFAULT_REASON_CODE_THRESHOLDS };
    }
    const overrides = { ...exports.DEFAULT_REASON_CODE_THRESHOLDS };
    for (const token of rawValue.split(',')) {
        const trimmed = token.trim();
        if (!trimmed)
            continue;
        const [reasonCode, value] = trimmed.split(':');
        if (!reasonCode || value === undefined)
            continue;
        overrides[reasonCode] = value === 'allow' ? null : Number(value);
    }
    return overrides;
}
function shouldPromoteReasonCode(reasonCode, count, totalRows, thresholds = exports.DEFAULT_REASON_CODE_THRESHOLDS) {
    const threshold = thresholds[reasonCode];
    if (threshold == null) {
        return false;
    }
    if (totalRows <= 0) {
        return count > 0;
    }
    return count / totalRows > threshold;
}
