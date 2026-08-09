import type { ReactNode } from "react";
import Link from "next/link";
import { requireProjectOwnerForPage } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Ownership gate for every `/projects/[id]/*` page.
 *
 * Server Components under this layout can freely call the DB adapter
 * for `params.id` — the layout has already verified ownership. On
 * missing session we bounce to `/login?next=…`; on any other deny we
 * render `not-found` (see `requireProjectOwnerForPage` for the exact
 * reason logging).
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { id: string };
}) {
  await requireProjectOwnerForPage(params.id, `/projects/${params.id}`);
  return (
    <main className="product-page">
      <header className="product-topbar">
        <div className="product-topbar-inner">
          <Link href="/" className="product-brand">
            <span className="product-brand-mark" aria-hidden="true" />
            <span>Zypact</span>
          </Link>

          <div className="product-topbar-meta">
            <span>AI visibility workspace</span>
            <Link href="/projects/new" className="product-new-scan">
              New scan
            </Link>
          </div>
        </div>
      </header>

      <div className="product-layout">
        <aside className="product-sidebar" aria-label="Project navigation">
          <p className="product-nav-label">Workspace</p>
          <nav className="product-nav">
            <Link href={`/projects/${params.id}/mirror`}>Mirror profile</Link>
            <Link href={`/projects/${params.id}/prompts`}>Buyer prompts</Link>
            <Link href={`/projects/${params.id}/probe`}>AI probes</Link>
            <Link href={`/projects/${params.id}/lost-prompts`}>Lost / partial</Link>
            <Link href={`/projects/${params.id}/competitors`}>Competitors</Link>
            <Link href={`/projects/${params.id}/gap-map`}>Gap map</Link>
            <Link href={`/projects/${params.id}/evidence-bank`}>Evidence bank</Link>
            <Link href={`/projects/${params.id}/fix-briefs`}>Fix briefs</Link>
            <Link href={`/projects/${params.id}/assets`}>Assets</Link>
            <Link href={`/projects/${params.id}/qa`}>QA</Link>
          </nav>

          <div className="product-nav-note">
            <span>Live scope</span>
            <strong>Perplexity Sonar</strong>
          </div>
        </aside>

        <section className="product-shell">{children}</section>
      </div>
    </main>
  );
}
