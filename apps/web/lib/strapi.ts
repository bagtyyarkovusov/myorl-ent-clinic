const STRAPI_URL =
  process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://127.0.0.1:1337";

export type StrapiPage = {
  type: "page";
  documentId: string;
  title: string;
  body: string | null;
  canonicalPath: string;
};

export type StrapiDisease = {
  type: "disease";
  documentId: string;
  title: string;
  body: string | null;
  canonicalPath: string;
};

export type StrapiDiseaseCategory = {
  type: "disease-category";
  documentId: string;
  title: string;
  description: string | null;
  canonicalPath: string;
};

export type StrapiService = {
  type: "service";
  documentId: string;
  title: string;
  body: string | null;
  canonicalPath: string;
};

export type StrapiServiceCategory = {
  type: "service-category";
  documentId: string;
  title: string;
  description: string | null;
  canonicalPath: string;
};

export type NavItem = {
  id: number;
  label: string;
  path: string | null;
  external: boolean;
  page?: { canonicalPath: string };
  disease_category?: { canonicalPath: string };
  service_category?: { canonicalPath: string };
  children?: NavItem[];
};

export type StrapiNavigation = {
  items: NavItem[];
};

export type StrapiSiteSettings = {
  siteName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  defaultSeo?: {
    metaTitle: string;
    metaDescription: string;
  };
};

export type ResolvedContent =
  | StrapiPage
  | StrapiDisease
  | StrapiDiseaseCategory
  | StrapiService
  | StrapiServiceCategory;

/**
 * Fetch localized navigation with nested items and relations
 */
export async function fetchNavigation(
  locale: string
): Promise<StrapiNavigation | null> {
  const u = new URL("/api/navigation", STRAPI_URL);
  u.searchParams.set("locale", locale);
  u.searchParams.set("populate[items][populate][0]", "children");
  u.searchParams.set("populate[items][populate][1]", "page");
  u.searchParams.set("populate[items][populate][2]", "disease_category");
  u.searchParams.set("populate[items][populate][3]", "service_category");

  const res = await strapiFetch(u.toString());
  if (!res.ok) return null;

  const json = await res.json();
  return json.data || null;
}

/**
 * Fetch localized site settings
 */
export async function fetchSiteSettings(
  locale: string
): Promise<StrapiSiteSettings | null> {
  const u = new URL("/api/site-settings", STRAPI_URL);
  u.searchParams.set("locale", locale);
  u.searchParams.set("populate", "defaultSeo");

  const res = await strapiFetch(u.toString());
  if (!res.ok) return null;

  const json = await res.json();
  return json.data || null;
}

async function strapiFetch(url: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.STRAPI_API_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return fetch(url, {
    headers,
    next: { revalidate: 60 },
  });
}

/**
 * Strapi v5 REST returns flattened `data` entries (no `attributes` wrapper).
 * Resolve UrlMapping by locale + canonical path with populated relations.
 */
export async function fetchContentByPath(
  locale: string,
  path: string
): Promise<ResolvedContent | null> {
  const u = new URL("/api/url-mappings", STRAPI_URL);
  u.searchParams.set("filters[path][$eq]", path);
  u.searchParams.set("filters[type][$eq]", "canonical");
  u.searchParams.set("locale", locale);
  u.searchParams.set("populate[0]", "page");
  u.searchParams.set("populate[1]", "disease");
  u.searchParams.set("populate[2]", "disease_category");
  u.searchParams.set("populate[3]", "service");
  u.searchParams.set("populate[4]", "service_category");

  const res = await strapiFetch(u.toString());

  if (!res.ok) {
    console.error("Strapi fetch failed", res.status, await res.text());
    return null;
  }
...

  const json = (await res.json()) as {
    data?: Array<
      Record<string, unknown> & {
        page?: Record<string, unknown>;
        disease?: Record<string, unknown>;
        disease_category?: Record<string, unknown>;
        service?: Record<string, unknown>;
        service_category?: Record<string, unknown>;
      }
    >;
  };

  const row = json.data?.[0];
  if (!row) return null;

  if (row.page && typeof row.page === "object") {
    return {
      type: "page",
      documentId: (row.page.documentId as string) || String(row.page.id),
      title: (row.page.title as string) || "",
      body: (row.page.body as string) || null,
      canonicalPath: (row.page.canonicalPath as string) || "",
    };
  }

  if (row.disease && typeof row.disease === "object") {
    return {
      type: "disease",
      documentId: (row.disease.documentId as string) || String(row.disease.id),
      title: (row.disease.title as string) || "",
      body: (row.disease.body as string) || null,
      canonicalPath: (row.disease.canonicalPath as string) || "",
    };
  }

  if (row.disease_category && typeof row.disease_category === "object") {
    return {
      type: "disease-category",
      documentId:
        (row.disease_category.documentId as string) ||
        String(row.disease_category.id),
      title: (row.disease_category.title as string) || "",
      description: (row.disease_category.description as string) || null,
      canonicalPath: (row.disease_category.canonicalPath as string) || "",
    };
  }

  if (row.service && typeof row.service === "object") {
    return {
      type: "service",
      documentId: (row.service.documentId as string) || String(row.service.id),
      title: (row.service.title as string) || "",
      body: (row.service.body as string) || null,
      canonicalPath: (row.service.canonicalPath as string) || "",
    };
  }

  if (row.service_category && typeof row.service_category === "object") {
    return {
      type: "service-category",
      documentId:
        (row.service_category.documentId as string) ||
        String(row.service_category.id),
      title: (row.service_category.title as string) || "",
      description: (row.service_category.description as string) || null,
      canonicalPath: (row.service_category.canonicalPath as string) || "",
    };
  }

  return null;
}
