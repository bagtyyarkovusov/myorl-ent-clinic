import { notFound } from "next/navigation";

import {
  isValidLocale,
  pathFromSegments,
} from "../../../lib/normalize-path";
import { fetchContentByPath } from "../../../lib/strapi";

export default async function CatchAllPage({
  params,
}: {
  params: Promise<{ locale: string; slug?: string[] }>;
}) {
  const { locale, slug } = await params;
  if (!isValidLocale(locale)) {
    notFound();
  }

  const canonicalPath = pathFromSegments(slug);
  const content = await fetchContentByPath(locale, canonicalPath);
  if (!content) {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", padding: "0 1rem" }}>
      {content.type === "page" && (
        <article>
          <h1>{content.title}</h1>
          {content.body ? (
            <p style={{ whiteSpace: "pre-wrap" }}>{content.body}</p>
          ) : null}
        </article>
      )}

      {content.type === "disease" && (
        <article>
          <header>
            <span style={{ color: "#666", fontSize: "0.9rem" }}>Disease</span>
            <h1>{content.title}</h1>
          </header>
          {content.body ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{content.body}</div>
          ) : null}
        </article>
      )}

      {content.type === "disease-category" && (
        <section>
          <header>
            <span style={{ color: "#666", fontSize: "0.9rem" }}>Disease Category</span>
            <h1>{content.title}</h1>
          </header>
          {content.description ? (
            <div style={{ whiteSpace: "pre-wrap", marginBottom: "2rem" }}>
              {content.description}
            </div>
          ) : null}
          {/* Future: List diseases in this category */}
        </section>
      )}

      {content.type === "service" && (
        <article>
          <header>
            <span style={{ color: "#666", fontSize: "0.9rem" }}>Service</span>
            <h1>{content.title}</h1>
          </header>
          {content.body ? (
            <div style={{ whiteSpace: "pre-wrap" }}>{content.body}</div>
          ) : null}
        </article>
      )}

      {content.type === "service-category" && (
        <section>
          <header>
            <span style={{ color: "#666", fontSize: "0.9rem" }}>Service Category</span>
            <h1>{content.title}</h1>
          </header>
          {content.description ? (
            <div style={{ whiteSpace: "pre-wrap", marginBottom: "2rem" }}>
              {content.description}
            </div>
          ) : null}
          {/* Future: List services in this category */}
        </section>
      )}
    </main>
  );
}
