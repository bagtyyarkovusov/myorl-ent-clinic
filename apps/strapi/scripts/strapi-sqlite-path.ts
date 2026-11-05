import path from 'node:path';

/**
 * Resolves the sqlite `connection.filename` the same way `config/database.ts` does
 * for the usual `__dirname` = `…/strapi/config`: one level up to the app root, then
 * `DATABASE_FILENAME` (default `.tmp/data.db`).
 * After `bootStrapi()`, prefer `getStrapiSqlitePathFromStrapi()` in migrate-cli
 * (authoritative, matches whatever Strapi actually resolved, including any dist/ paths).
 */
export function resolveStrapiSqliteFilePath(
  strapiAppRoot: string,
  databaseFilename: string = process.env.DATABASE_FILENAME ?? '.tmp/data.db',
): string {
  return path.resolve(path.join(strapiAppRoot, databaseFilename));
}
