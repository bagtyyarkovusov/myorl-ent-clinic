import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASON_CODE_THRESHOLDS,
  exceedsSucceededDelta,
  parseReasonCodeThresholdOverrides,
  selectSucceededDeltaThreshold,
  shouldPromoteReasonCode,
} from './halt-thresholds';

describe('halt-thresholds', () => {
  it('selects absolute threshold 1 for small expected counts', () => {
    expect(selectSucceededDeltaThreshold(10)).toEqual({ kind: 'absolute', limit: 1 });
  });

  it('selects absolute threshold 3 for medium expected counts', () => {
    expect(selectSucceededDeltaThreshold(20)).toEqual({ kind: 'absolute', limit: 3 });
    expect(selectSucceededDeltaThreshold(100)).toEqual({ kind: 'absolute', limit: 3 });
  });

  it('selects relative 10% threshold for large expected counts', () => {
    expect(selectSucceededDeltaThreshold(101)).toEqual({ kind: 'relative', limit: 0.1 });
  });

  it('detects succeeded-count drift against the banded thresholds', () => {
    expect(exceedsSucceededDelta(10, 12)).toBe(true);
    expect(exceedsSucceededDelta(50, 53)).toBe(false);
    expect(exceedsSucceededDelta(50, 54)).toBe(true);
    expect(exceedsSucceededDelta(200, 219)).toBe(false);
    expect(exceedsSucceededDelta(200, 221)).toBe(true);
  });

  it('parses reason-code threshold overrides', () => {
    expect(parseReasonCodeThresholdOverrides('missing_asset:0.5,unresolved_legacy_url:allow')).toEqual({
      ...DEFAULT_REASON_CODE_THRESHOLDS,
      missing_asset: 0.5,
      unresolved_legacy_url: null,
    });
  });

  it('promotes reason codes when their frequency exceeds the configured threshold', () => {
    expect(shouldPromoteReasonCode('missing_asset', 21, 100)).toBe(true);
    expect(shouldPromoteReasonCode('missing_asset', 20, 100)).toBe(false);
    expect(shouldPromoteReasonCode('unresolved_legacy_url', 99, 100)).toBe(false);
  });
});
