import { normalizeCanonicalPath } from './canonical-path';

export type ModxRecord = {
  id: string;
  locale: string;
  uri: string;
  pagetitle: string;
  template: string;
  published: string;
  deleted: string;
  status_guess: string;
  parent_id?: string;
};

export type MappingResult = {
  type: 'page' | 'disease' | 'disease-category' | 'service' | 'service-category' | 'unknown';
  locale: 'el' | 'ru';
  canonicalPath: string;
  status: 'published' | 'draft';
  shouldReview: boolean;
};

export function mapModxRecord(record: ModxRecord): MappingResult {
  const canonicalPath = normalizeCanonicalPath(record.uri);

  const locale: 'el' | 'ru' = record.locale === '0' || record.locale === 'el' ? 'el' : 'ru';

  const status: 'published' | 'draft' =
    record.published === '1' && record.deleted === '0' ? 'published' : 'draft';

  const shouldReview = record.status_guess === 'review' || record.deleted === '1';

  let type: MappingResult['type'] = 'unknown';
  switch (record.template) {
    case '8':
    case '18':
    case '20':
    case '7':
      type = 'page';
      break;
    case '11':
      type = 'disease';
      break;
    case '10':
      type = 'disease-category';
      break;
    case '13':
      type = 'service';
      break;
    case '12':
      type = 'service-category';
      break;
  }

  return {
    type,
    locale,
    canonicalPath,
    status,
    shouldReview,
  };
}
