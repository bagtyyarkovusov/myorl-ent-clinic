"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TARGET_UID_BY_TYPE = exports.EXTRACT_JSON_PATH = exports.EXPECTED_EXTRACT_JSON_VERSION = void 0;
exports.loadExtractEnvelope = loadExtractEnvelope;
exports.isClassifiedRow = isClassifiedRow;
exports.normalizeLegacyPath = normalizeLegacyPath;
exports.routePathFor = routePathFor;
exports.buildRouteLookups = buildRouteLookups;
exports.buildAssetPathSet = buildAssetPathSet;
exports.rewriteBodyHtml = rewriteBodyHtml;
exports.normalizeLegacyPaths = normalizeLegacyPaths;
exports.buildDesiredContentPayload = buildDesiredContentPayload;
exports.buildDesiredUrlMapping = buildDesiredUrlMapping;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const content_hash_1 = require("../../scripts/content-hash");
const canonical_path_1 = require("./canonical-path");
exports.EXPECTED_EXTRACT_JSON_VERSION = 1;
exports.EXTRACT_JSON_PATH = node_path_1.default.resolve(__dirname, '..', '..', '..', '..', 'plans', 'modx-extract.json');
exports.TARGET_UID_BY_TYPE = {
    page: 'api::page.page',
    disease: 'api::disease.disease',
    'disease-category': 'api::disease-category.disease-category',
    service: 'api::service.service',
    'service-category': 'api::service-category.service-category',
};
async function loadExtractEnvelope(extractPath = exports.EXTRACT_JSON_PATH) {
    const parsed = JSON.parse(await node_fs_1.promises.readFile(extractPath, 'utf8'));
    if (parsed.schema_version !== exports.EXPECTED_EXTRACT_JSON_VERSION) {
        throw new Error('extract_json_schema_version_mismatch');
    }
    return parsed;
}
function isClassifiedRow(row) {
    return 'target_type' in row;
}
function normalizeLegacyPath(input) {
    let value = input.trim();
    value = value.replace(/^https?:\/\/(?:www\.)?myorl\.gr\/?/i, '');
    value = value.replace(/^\/+/, '');
    if (value === 'el' || value === 'ru') {
        return '';
    }
    if (value.startsWith('el/')) {
        value = value.slice(3);
    }
    else if (value.startsWith('ru/')) {
        value = value.slice(3);
    }
    return (0, canonical_path_1.normalizeCanonicalPath)(value);
}
function routePathFor(locale, canonicalPath) {
    return canonicalPath ? `/${locale}/${canonicalPath}` : `/${locale}`;
}
function lookupKey(locale, canonicalPath) {
    return `${locale}:${canonicalPath}`;
}
function buildRouteLookups(rows) {
    const byModxId = new Map();
    const byPath = new Map();
    const canonicalKeys = new Set();
    for (const row of rows) {
        if (!isClassifiedRow(row))
            continue;
        byModxId.set(row.modx_id, row);
        const canonicalKey = lookupKey(row.locale, row.canonical_path);
        canonicalKeys.add(canonicalKey);
        byPath.set(canonicalKey, row);
        for (const legacyPath of row.legacy_paths) {
            byPath.set(lookupKey(row.locale, normalizeLegacyPath(legacyPath)), row);
        }
    }
    return {
        by_modx_id: byModxId,
        by_path: byPath,
        canonical_keys: canonicalKeys,
    };
}
function buildAssetPathSet(envelope) {
    return new Set(envelope.asset_inventory.map((entry) => entry.path));
}
function parseInternalPath(rawHref, currentLocale) {
    let value = rawHref.trim();
    value = value.replace(/^https?:\/\/(?:www\.)?myorl\.gr/i, '');
    if (!value.startsWith('/')) {
        return null;
    }
    value = value.replace(/^\/+/, '');
    let locale = currentLocale;
    if (value === 'el' || value.startsWith('el/')) {
        locale = 'el';
        value = value.slice(2).replace(/^\/+/, '');
    }
    else if (value === 'ru' || value.startsWith('ru/')) {
        locale = 'ru';
        value = value.slice(2).replace(/^\/+/, '');
    }
    return {
        locale,
        canonicalPath: (0, canonical_path_1.normalizeCanonicalPath)(value),
    };
}
function maybeAssetPath(rawHref) {
    let value = rawHref.trim();
    value = value.replace(/^https?:\/\/(?:www\.)?myorl\.gr\/?/i, '');
    value = value.replace(/^\/+/, '');
    if (value.startsWith('assets/') ||
        value.startsWith('files/') ||
        value.startsWith('uploads/') ||
        value.startsWith('webp/') ||
        value.startsWith('template/') ||
        value.startsWith('ru/assets/') ||
        value.startsWith('ru/files/') ||
        value.startsWith('ru/template/') ||
        value.startsWith('ru/webp/')) {
        return value;
    }
    return null;
}
function replaceAnchorHrefs(html, context) {
    const annotations = [];
    const next = html.replace(/(<a\b[^>]*?\bhref=)(['"])(.*?)(\2)([^>]*>)/gi, (match, prefix, quote, href, suffixQuote, tail) => {
        const assetPath = maybeAssetPath(href);
        if (assetPath) {
            if (!context.asset_paths.has(assetPath)) {
                annotations.push({ reason_code: 'missing_asset', detail: assetPath });
                return `${prefix}${quote}/${assetPath}${suffixQuote} data-migration-missing-asset="true"${tail}`;
            }
            return `${prefix}${quote}/${assetPath}${suffixQuote}${tail}`;
        }
        const parsed = parseInternalPath(href, context.locale);
        if (!parsed) {
            return match;
        }
        const target = context.lookups.by_path.get(lookupKey(parsed.locale, parsed.canonicalPath));
        if (!target) {
            annotations.push({ reason_code: 'unresolved_legacy_url', detail: href });
            return `${prefix}${quote}${href}${suffixQuote} data-migration-unresolved="true"${tail}`;
        }
        return `${prefix}${quote}${routePathFor(target.locale, target.canonical_path)}${suffixQuote}${tail}`;
    });
    return { html: next, annotations };
}
function replaceImgSrcs(html, context) {
    const annotations = [];
    const next = html.replace(/(<img\b[^>]*?\bsrc=)(['"])(.*?)(\2)([^>]*>)/gi, (match, prefix, quote, src, suffixQuote, tail) => {
        const assetPath = maybeAssetPath(src);
        if (!assetPath) {
            return match;
        }
        if (!context.asset_paths.has(assetPath)) {
            annotations.push({ reason_code: 'missing_asset', detail: assetPath });
            return `${prefix}${quote}/${assetPath}${suffixQuote} data-migration-missing-asset="true"${tail}`;
        }
        return `${prefix}${quote}/${assetPath}${suffixQuote}${tail}`;
    });
    return { html: next, annotations };
}
function replaceShortcodes(html, context) {
    const annotations = [];
    const resolvedLinks = html.replace(/\[\[~(\d+)\]\]/g, (token, rawId) => {
        const modxId = Number(rawId);
        const target = context.lookups.by_modx_id.get(modxId);
        if (!target) {
            annotations.push({ reason_code: 'unresolved_modx_shortcode', detail: token });
            return `<!-- MODX:unresolved:${token} -->`;
        }
        return routePathFor(target.locale, target.canonical_path);
    });
    const replaced = resolvedLinks.replace(/\[\[[^[\]]+\]\]/g, (token) => {
        annotations.push({ reason_code: 'unresolved_modx_shortcode', detail: token });
        return `<!-- MODX:unresolved:${token} -->`;
    });
    return { html: replaced, annotations };
}
function rewriteBodyHtml(bodyHtml, context) {
    const shortcodeResult = replaceShortcodes(bodyHtml, context);
    const anchorResult = replaceAnchorHrefs(shortcodeResult.html, context);
    const imageResult = replaceImgSrcs(anchorResult.html, context);
    return {
        html: imageResult.html,
        annotations: [
            ...shortcodeResult.annotations,
            ...anchorResult.annotations,
            ...imageResult.annotations,
        ],
    };
}
function normalizeLegacyPaths(paths) {
    return [...new Set(paths.map((pathValue) => normalizeLegacyPath(pathValue)).filter(Boolean))].sort();
}
function buildDesiredContentPayload(row, context) {
    var _a, _b, _c;
    const rewritten = rewriteBodyHtml(row.body_html, context);
    const needsReviewAnnotations = [...rewritten.annotations];
    const seo = row.seo_meta_title || row.seo_meta_description
        ? {
            metaTitle: row.seo_meta_title || row.title,
            metaDescription: (_a = row.seo_meta_description) !== null && _a !== void 0 ? _a : '',
        }
        : null;
    const hashInput = {
        title: row.title,
        body: rewritten.html,
        canonicalPath: row.canonical_path,
        seo,
        parent_modx_id: (_b = row.parent_modx_id) !== null && _b !== void 0 ? _b : null,
        category_modx_id: (_c = row.category_modx_id) !== null && _c !== void 0 ? _c : null,
    };
    const data = {
        title: row.title,
        canonicalPath: row.canonical_path,
        modxId: row.modx_id,
        _migrationContentHash: (0, content_hash_1.hashContentPayload)(hashInput),
        needs_review: row.needs_review_seed || needsReviewAnnotations.length > 0,
        seo,
    };
    if (row.target_type === 'page' || row.target_type === 'disease' || row.target_type === 'service') {
        data.body = rewritten.html;
    }
    else {
        data.description = rewritten.html;
    }
    return {
        uid: exports.TARGET_UID_BY_TYPE[row.target_type],
        content_hash: data._migrationContentHash,
        data,
        annotations: needsReviewAnnotations,
    };
}
function buildDesiredUrlMapping(row, lookups, existingLegacyOwners) {
    const annotations = [];
    const filteredLegacyPaths = [];
    for (const legacyPath of normalizeLegacyPaths(row.legacy_paths)) {
        const key = lookupKey(row.locale, legacyPath);
        const canonicalOwner = lookups.by_path.get(key);
        if (canonicalOwner && canonicalOwner.modx_id !== row.modx_id) {
            annotations.push({
                reason_code: 'legacy_path_collides_with_canonical',
                detail: legacyPath,
            });
            continue;
        }
        const owner = existingLegacyOwners.get(key);
        if (owner !== undefined && owner !== row.modx_id) {
            annotations.push({
                reason_code: 'legacy_path_ambiguous',
                detail: legacyPath,
            });
            continue;
        }
        existingLegacyOwners.set(key, row.modx_id);
        filteredLegacyPaths.push(legacyPath);
    }
    return {
        desired: {
            path: row.canonical_path,
            type: 'canonical',
            isAutoGenerated: false,
            legacyPaths: filteredLegacyPaths,
        },
        annotations,
    };
}
