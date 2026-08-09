import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NewProjectPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/projects/new")}`);
  }
  return (
    <main className="product-page product-new-page">
      <header className="product-topbar">
        <div className="product-topbar-inner">
          <a href="/" className="product-brand">
            <span className="product-brand-mark" aria-hidden="true" />
            <span>Zypact</span>
          </a>
          <span className="product-topbar-kicker">AI visibility workspace</span>
        </div>
      </header>

      <section className="product-shell product-shell-narrow">
        <p className="product-eyebrow">New project</p>
        <h1>New Mirror Scan</h1>
        <p className="muted">
          Enter a SaaS website URL. We crawl up to 5 pages on Free limits, run
          the Site Reader Agent, and store the Mirror Profile.
        </p>
        <NewProjectForm />
      </section>
    </main>
  );
}
