"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sync_url_mapping_1 = require("./lib/sync-url-mapping");
const ROUTABLE_UIDS = [
    'api::page.page',
    'api::disease.disease',
    'api::disease-category.disease-category',
    'api::service.service',
    'api::service-category.service-category',
];
const MYORL_LOCALES = [
    { code: 'el', name: 'Greek (el)' },
    { code: 'ru', name: 'Russian (ru)' },
];
exports.default = {
    async bootstrap({ strapi }) {
        try {
            if (process.env.IMPORT_MODX) {
                strapi.log.error('IMPORT_MODX is removed. Use `pnpm migrate:extract && pnpm migrate:modx --mode=merge` (Phase 6.5, #14).');
                throw new Error('Removed: IMPORT_MODX bootstrap hook');
            }
            const localesService = strapi.plugin('i18n').service('locales');
            for (const { code, name } of MYORL_LOCALES) {
                const existing = await localesService.findByCode(code);
                if (!existing) {
                    await localesService.create({ code, name });
                    strapi.log.info(`[i18n] Seeded locale "${code}" (${name})`);
                }
            }
            const pageCount = await strapi.documents('api::page.page').count({
                status: 'published',
            });
            if (pageCount === 0) {
                strapi.log.info('Seeding homepages...');
                await strapi.documents('api::page.page').create({
                    locale: 'el',
                    data: { title: 'Αρχική', body: 'Καλώς ήρθατε στο myorl.gr', canonicalPath: '' },
                    status: 'published',
                });
                await strapi.documents('api::page.page').create({
                    locale: 'ru',
                    data: { title: 'Главная', body: 'Добро пожаловать на myorl.gr', canonicalPath: '' },
                    status: 'published',
                });
                strapi.log.info('Homepages seeded (UrlMapping rows auto-created by sync-url-mapping middleware).');
            }
        }
        catch (err) {
            strapi.log.error('Bootstrap failed', err);
        }
    },
    register({ strapi }) {
        strapi.documents.use(async (context, next) => {
            const result = await next();
            try {
                if (ROUTABLE_UIDS.includes(context.uid)) {
                    await (0, sync_url_mapping_1.afterDocumentAction)(strapi, context, result);
                }
            }
            catch (err) {
                strapi.log.error(`sync-url-mapping failed for ${context.uid}`, err);
                throw err;
            }
            return result;
        });
    },
};
