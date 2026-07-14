import type { ReactNode } from "react";
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
  return <>{children}</>;
}
