"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCanonicalPath = void 0;
const HOMEPAGE_ALIASES = new Set(['', 'index', 'home', 'index.html']);
function normalizeCanonicalPath(uri) {
    const stripped = uri.replace(/^\/+/, '');
    return HOMEPAGE_ALIASES.has(stripped) ? '' : stripped;
}
exports.normalizeCanonicalPath = normalizeCanonicalPath;
