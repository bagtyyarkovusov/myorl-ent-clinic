export const LOCALES = ["el", "ru"] as const;
export type Locale = (typeof LOCALES)[number];

export function isValidLocale(s: string): s is Locale {
  return (LOCALES as readonly string[]).includes(s);
}

/**
 * Canonical path for UrlMapping: no leading slash, no locale segment.
 * Empty string means homepage for that locale.
 */
export function pathFromSegments(segments: string[] | undefined): string {
  if (!segments?.length) return "";
  return segments.map((s) => s.trim()).filter(Boolean).join("/");
}
