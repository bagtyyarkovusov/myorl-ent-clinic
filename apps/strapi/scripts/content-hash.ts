import { createHash } from 'node:crypto';

export type ContentHashSeo = {
  metaTitle: string;
  metaDescription: string;
};

export type ContentHashInput = {
  title: string;
  body: string;
  canonicalPath: string;
  seo: ContentHashSeo | null;
  parent_modx_id: number | null;
  category_modx_id: number | null;
};

export function buildContentHashPayload(input: ContentHashInput) {
  return {
    title: input.title,
    body: input.body,
    canonicalPath: input.canonicalPath,
    seo: input.seo
      ? {
          metaTitle: input.seo.metaTitle,
          metaDescription: input.seo.metaDescription,
        }
      : null,
    parent_modx_id: input.parent_modx_id ?? null,
    category_modx_id: input.category_modx_id ?? null,
  };
}

export function hashContentPayload(input: ContentHashInput): string {
  const payload = JSON.stringify(buildContentHashPayload(input));
  return createHash('sha256').update(payload).digest('hex');
}
