export const DEFAULT_REASON_CODE_THRESHOLDS: Record<string, number | null> = {
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

export type DeltaThreshold =
  | { kind: 'absolute'; limit: number }
  | { kind: 'relative'; limit: number };

export function selectSucceededDeltaThreshold(expectedCount: number): DeltaThreshold {
  if (expectedCount < 20) {
    return { kind: 'absolute', limit: 1 };
  }
  if (expectedCount <= 100) {
    return { kind: 'absolute', limit: 3 };
  }
  return { kind: 'relative', limit: 0.1 };
}

export function exceedsSucceededDelta(expectedCount: number, actualCount: number): boolean {
  const threshold = selectSucceededDeltaThreshold(expectedCount);
  const delta = Math.abs(actualCount - expectedCount);
  if (threshold.kind === 'absolute') {
    return delta > threshold.limit;
  }
  return expectedCount > 0 && delta / expectedCount > threshold.limit;
}

export function parseReasonCodeThresholdOverrides(
  rawValue?: string,
): Record<string, number | null> {
  if (!rawValue) {
    return { ...DEFAULT_REASON_CODE_THRESHOLDS };
  }

  const overrides = { ...DEFAULT_REASON_CODE_THRESHOLDS };
  for (const token of rawValue.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const [reasonCode, value] = trimmed.split(':');
    if (!reasonCode || value === undefined) continue;
    overrides[reasonCode] = value === 'allow' ? null : Number(value);
  }
  return overrides;
}

export function shouldPromoteReasonCode(
  reasonCode: string,
  count: number,
  totalRows: number,
  thresholds: Record<string, number | null> = DEFAULT_REASON_CODE_THRESHOLDS,
): boolean {
  const threshold = thresholds[reasonCode];
  if (threshold == null) {
    return false;
  }
  if (totalRows <= 0) {
    return count > 0;
  }
  return count / totalRows > threshold;
}
