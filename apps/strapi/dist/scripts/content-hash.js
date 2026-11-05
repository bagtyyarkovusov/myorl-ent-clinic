"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContentPayload = exports.buildContentHashPayload = void 0;
const node_crypto_1 = require("node:crypto");
function buildContentHashPayload(input) {
    var _a, _b;
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
        parent_modx_id: (_a = input.parent_modx_id) !== null && _a !== void 0 ? _a : null,
        category_modx_id: (_b = input.category_modx_id) !== null && _b !== void 0 ? _b : null,
    };
}
exports.buildContentHashPayload = buildContentHashPayload;
function hashContentPayload(input) {
    const payload = JSON.stringify(buildContentHashPayload(input));
    return (0, node_crypto_1.createHash)('sha256').update(payload).digest('hex');
}
exports.hashContentPayload = hashContentPayload;
