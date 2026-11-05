"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapModxRecord = void 0;
const canonical_path_1 = require("./canonical-path");
function mapModxRecord(record) {
    const canonicalPath = (0, canonical_path_1.normalizeCanonicalPath)(record.uri);
    const locale = record.locale === '0' || record.locale === 'el' ? 'el' : 'ru';
    const status = record.published === '1' && record.deleted === '0' ? 'published' : 'draft';
    const shouldReview = record.status_guess === 'review' || record.deleted === '1';
    let type = 'unknown';
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
exports.mapModxRecord = mapModxRecord;
