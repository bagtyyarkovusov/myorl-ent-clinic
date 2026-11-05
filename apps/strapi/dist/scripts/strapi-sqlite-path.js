"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveStrapiSqliteFilePath = void 0;
const node_path_1 = __importDefault(require("node:path"));
/**
 * Resolves the sqlite `connection.filename` the same way `config/database.ts` does
 * for the usual `__dirname` = `…/strapi/config`: one level up to the app root, then
 * `DATABASE_FILENAME` (default `.tmp/data.db`).
 * After `bootStrapi()`, prefer `getStrapiSqlitePathFromStrapi()` in migrate-cli
 * (authoritative, matches whatever Strapi actually resolved, including any dist/ paths).
 */
function resolveStrapiSqliteFilePath(strapiAppRoot, databaseFilename) {
    var _a;
    if (databaseFilename === void 0) { databaseFilename = (_a = process.env.DATABASE_FILENAME) !== null && _a !== void 0 ? _a : '.tmp/data.db'; }
    return node_path_1.default.resolve(node_path_1.default.join(strapiAppRoot, databaseFilename));
}
exports.resolveStrapiSqliteFilePath = resolveStrapiSqliteFilePath;
