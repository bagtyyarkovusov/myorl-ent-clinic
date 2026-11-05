const HOMEPAGE_ALIASES = new Set(['', 'index', 'home', 'index.html']);

export function normalizeCanonicalPath(uri: string): string {
  const stripped = uri.replace(/^\/+/, '');
  return HOMEPAGE_ALIASES.has(stripped) ? '' : stripped;
}
