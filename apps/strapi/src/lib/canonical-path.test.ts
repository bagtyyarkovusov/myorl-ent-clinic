import { describe, expect, it } from 'vitest';
import { normalizeCanonicalPath } from './canonical-path';

describe('normalizeCanonicalPath', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeCanonicalPath('')).toBe('');
  });

  it('returns empty string for bare slash', () => {
    expect(normalizeCanonicalPath('/')).toBe('');
  });

  it('collapses /index alias to empty', () => {
    expect(normalizeCanonicalPath('/index')).toBe('');
  });

  it('collapses /home alias to empty', () => {
    expect(normalizeCanonicalPath('/home')).toBe('');
  });

  it('collapses /index.html alias to empty', () => {
    expect(normalizeCanonicalPath('/index.html')).toBe('');
  });

  it('collapses index without slash to empty', () => {
    expect(normalizeCanonicalPath('index')).toBe('');
  });

  it('strips leading slash from single segment', () => {
    expect(normalizeCanonicalPath('/about')).toBe('about');
  });

  it('strips leading slash from nested segments', () => {
    expect(normalizeCanonicalPath('/services/surgery')).toBe('services/surgery');
  });

  it('leaves no-leading-slash input untouched', () => {
    expect(normalizeCanonicalPath('services/surgery')).toBe('services/surgery');
  });

  it('collapses repeated leading slashes', () => {
    expect(normalizeCanonicalPath('///foo')).toBe('foo');
  });

  it('preserves trailing segments; no trailing-slash normalization', () => {
    expect(normalizeCanonicalPath('/about/')).toBe('about/');
  });

  it('preserves embedded double slashes (lenient)', () => {
    expect(normalizeCanonicalPath('/a//b')).toBe('a//b');
  });
});
