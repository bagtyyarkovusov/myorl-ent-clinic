
export default async ({ strapi }: { strapi: any }) => {
  console.log('Seeding initial content...');
  
  // 1. Homepages
  const elHome = await strapi.documents('api::page.page').create({
    locale: 'el',
    data: {
      title: 'Αρχική',
      body: 'Καλώς ήρθατε στο myorl.gr',
      canonicalPath: '',
    },
    status: 'published',
  });
  console.log('Greek Home created');

  const ruHome = await strapi.documents('api::page.page').create({
    locale: 'ru',
    data: {
      title: 'Главная',
      body: 'Добро пожаловать на myorl.gr',
      canonicalPath: '',
    },
    status: 'published',
  });
  console.log('Russian Home created');

  // Manual UrlMapping for homepages (since they have empty path which might need careful handling in some environments)
  await strapi.documents('api::url-mapping.url-mapping').create({
    locale: 'el',
    data: { path: '', type: 'canonical', page: elHome.documentId },
  });
  await strapi.documents('api::url-mapping.url-mapping').create({
    locale: 'ru',
    data: { path: '', type: 'canonical', page: ruHome.documentId },
  });

  // 2. Disease Categories
  const elCat = await strapi.documents('api::disease-category.disease-category').create({
    locale: 'el',
    data: {
      title: 'Παθήσεις Αυτιού',
      description: 'Πληροφορίες για παθήσεις των αυτιών.',
      canonicalPath: 'pathiseis-aftiou',
    },
    status: 'published',
  });

  const ruCat = await strapi.documents('api::disease-category.disease-category').create({
    locale: 'ru',
    data: {
      title: 'Болезни уха',
      description: 'Информация о заболеваниях ушей.',
      canonicalPath: 'bolezni-uha',
    },
    status: 'published',
  });

  const elThyroidCat = await strapi.documents('api::disease-category.disease-category').create({
    locale: 'el',
    data: {
      title: 'Θυρεοειδής αδένας',
      description: 'Παθήσεις θυρεοειδούς.',
      canonicalPath: 'thyreoeidis-adenas',
    },
    status: 'published',
  });

  const ruThyroidCat = await strapi.documents('api::disease-category.disease-category').create({
    locale: 'ru',
    data: {
      title: 'Щитовидная железа',
      description: 'Заболевания щитовидной железы.',
      canonicalPath: 'shchitovidnaya-zheleza',
    },
    status: 'published',
  });
  console.log('Disease Categories created');

  // 3. Diseases
  await strapi.documents('api::disease.disease').create({
    locale: 'el',
    data: {
      title: 'Ωτίτιδα',
      body: 'Η ωτίτιδα είναι μια φλεγμονή του αυτιού.',
      canonicalPath: 'otitida',
      category: elCat.documentId,
    },
    status: 'published',
  });

  await strapi.documents('api::disease.disease').create({
    locale: 'ru',
    data: {
      title: 'Отит',
      body: 'Отит — это воспаление уха.',
      canonicalPath: 'otit',
      category: ruCat.documentId,
    },
    status: 'published',
  });
  console.log('Diseases created');

  // 4. Service Categories
  const elServiceCat = await strapi.documents('api::service-category.service-category').create({
    locale: 'el',
    data: {
      title: 'Χειρουργικές Επεμβάσεις',
      description: 'Εξειδικευμένες χειρουργικές επεμβάσεις.',
      canonicalPath: 'xeirourgikes-epemvaseis',
    },
    status: 'published',
  });

  const ruServiceCat = await strapi.documents('api::service-category.service-category').create({
    locale: 'ru',
    data: {
      title: 'Хирургические операции',
      description: 'Специаλιзированные хирургические операции.',
      canonicalPath: 'khirurgicheskie-operatsii',
    },
    status: 'published',
  });
  console.log('Service Categories created');

  // 5. Services
  await strapi.documents('api::service.service').create({
    locale: 'el',
    data: {
      title: 'Ενδοσκοπική Θυρεοειδεκτομή',
      body: 'Σύγχρονη μέθοδος αφαίρεσης θυρεοειδούς.',
      canonicalPath: 'endoskopiki-thyreoeidektomi',
      category: elServiceCat.documentId,
      disease_categories: [elThyroidCat.documentId],
    },
    status: 'published',
  });

  await strapi.documents('api::service.service').create({
    locale: 'ru',
    data: {
      title: 'Эндоскопическая тиреоидэктомия',
      body: 'Современный метод удаления щитовидной железы.',
      canonicalPath: 'endoskopicheskaya-tireoidektomiya',
      category: ruServiceCat.documentId,
      disease_categories: [ruThyroidCat.documentId],
    },
    status: 'published',
  });
  console.log('Services created');
  
  console.log('Seeding complete.');
};
