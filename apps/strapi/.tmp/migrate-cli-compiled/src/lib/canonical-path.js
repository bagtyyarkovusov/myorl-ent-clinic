"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCanonicalPath = normalizeCanonicalPath;
const HOMEPAGE_ALIASES = new Set(['', 'index', 'home', 'index.html']);
function normalizeCanonicalPath(uri) {
    const stripped = uri.replace(/^\/+/, '');
    return HOMEPAGE_ALIASES.has(stripped) ? '' : stripped;
}
