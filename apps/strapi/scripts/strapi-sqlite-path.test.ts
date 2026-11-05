import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStrapiSqliteFilePath } from './strapi-sqlite-path';

describe('resolveStrapiSqliteFilePath', () => {
  const strapiAppRoot = '/x/y/apps/strapi';

  it('resolves .tmp/data.db under the Strapi app root', () => {
    const resolved = resolveStrapiSqliteFilePath(strapiAppRoot, '.tmp/data.db');
    expect(resolved).toBe(path.resolve(strapiAppRoot, '.tmp/data.db'));
  });

  it('resolves a bare data.db in the app root', () => {
    const resolved = resolveStrapiSqliteFilePath(strapiAppRoot, 'data.db');
    expect(resolved).toBe(path.resolve(strapiAppRoot, 'data.db'));
  });
});
