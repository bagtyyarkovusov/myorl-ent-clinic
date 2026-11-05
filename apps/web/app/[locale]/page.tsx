import { notFound } from "next/navigation";

import { fetchContentByPath } from "../../lib/strapi";
import { isValidLocale } from "../../lib/normalize-path";

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isValidLocale(locale)) {
    notFound();
  }

  const page = await fetchContentByPath(locale, "");
  if (!page || page.type !== "page") {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>{page.title}</h1>
      {page.body ? (
        <p style={{ whiteSpace: "pre-wrap" }}>{page.body}</p>
      ) : null}
    </main>
  );
}
