import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import { isValidLocale } from "../../lib/normalize-path";
import { fetchNavigation, fetchSiteSettings, type NavItem } from "../../lib/strapi";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isValidLocale(locale)) return {};

  const settings = await fetchSiteSettings(locale);
  if (!settings) return {};

  return {
    title: {
      template: `%s | ${settings.siteName}`,
      default: settings.siteName,
    },
    description: settings.defaultSeo?.metaDescription || undefined,
    openGraph: {
      title: settings.siteName,
      description: settings.defaultSeo?.metaDescription || undefined,
      siteName: settings.siteName,
      locale: locale === "el" ? "el_GR" : "ru_RU",
      type: "website",
    },
  };
}

function resolveNavLink(item: NavItem, locale: string): string {
  if (item.external && item.path) return item.path;
  
  let path = "";
  if (item.page) path = item.page.canonicalPath;
  else if (item.disease_category) path = item.disease_category.canonicalPath;
  else if (item.service_category) path = item.service_category.canonicalPath;
  else if (item.path) path = item.path;

  // normalize-path might have a better version of this, but for now:
  return `/${locale}${path ? `/${path}` : ""}`;
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!isValidLocale(locale)) {
    notFound();
  }

  const [nav, settings] = await Promise.all([
    fetchNavigation(locale),
    fetchSiteSettings(locale),
  ]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header style={{ borderBottom: "1px solid #eee", padding: "1rem" }}>
        <nav style={{ maxWidth: 1024, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href={`/${locale}`} style={{ fontWeight: "bold", fontSize: "1.2rem", textDecoration: "none", color: "black" }}>
            {settings?.siteName || "myorl.gr"}
          </Link>
          
          <ul style={{ display: "flex", gap: "1.5rem", listStyle: "none", margin: 0, padding: 0 }}>
            {nav?.items?.map((item) => (
              <li key={item.id}>
                <Link href={resolveNavLink(item, locale)} style={{ textDecoration: "none", color: "#333" }}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <div style={{ flex: 1 }}>
        {children}
      </div>

      <footer style={{ borderTop: "1px solid #eee", padding: "2rem 1rem", marginTop: "2rem" }}>
        <div style={{ maxWidth: 1024, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "2rem" }}>
          <div>
            <h3>{settings?.siteName || "myorl.gr"}</h3>
            {settings?.address && <p>{settings.address}</p>}
          </div>
          <div>
            <h4>Contact</h4>
            {settings?.contactEmail && <p><a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail}</a></p>}
            {settings?.contactPhone && <p><a href={`tel:${settings.contactPhone}`}>{settings.contactPhone}</a></p>}
          </div>
          <div>
            <h4>Language</h4>
            <Link href="/el">Ελληνικά</Link> | <Link href="/ru">Русский</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
