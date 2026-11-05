import type { Schema, Struct } from '@strapi/strapi';

export interface NavigationNavItem extends Struct.ComponentSchema {
  collectionName: 'components_navigation_nav_items';
  info: {
    description: '';
    displayName: 'NavItem';
    icon: 'link';
  };
  attributes: {
    children: Schema.Attribute.Component<'navigation.nav-item', true>;
    disease_category: Schema.Attribute.Relation<
      'oneToOne',
      'api::disease-category.disease-category'
    >;
    external: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    page: Schema.Attribute.Relation<'oneToOne', 'api::page.page'>;
    path: Schema.Attribute.String;
    service_category: Schema.Attribute.Relation<
      'oneToOne',
      'api::service-category.service-category'
    >;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'search';
  };
  attributes: {
    metaDescription: Schema.Attribute.Text;
    metaTitle: Schema.Attribute.String & Schema.Attribute.Required;
    shareImage: Schema.Attribute.Media;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'navigation.nav-item': NavigationNavItem;
      'shared.seo': SharedSeo;
    }
  }
}
