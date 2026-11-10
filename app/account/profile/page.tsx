import type { Metadata } from "next";

import { loadWorkspace } from "@/lib/workspace/load";
import { OBJECTIVES } from "@/lib/workspace/store";
import { OBJECTIVE_LABELS, draftProfile } from "@/lib/workspace/view";

import { ProfileForm } from "../workspace-forms";
import { WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Brand profile", robots: { index: false, follow: false } };

export default async function WorkspaceProfilePage() {
  const { state, account, diagnostic } = await loadWorkspace();
  const profile = state.profile;
  const draft = profile ? null : draftProfile(state, diagnostic);

  const initial = {
    expectedVersion: profile?.version ?? 0,
    companyName: profile?.companyName ?? draft?.companyName ?? state.workspace.name,
    description: profile?.description ?? draft?.description ?? "",
    category: profile?.category ?? "",
    audience: profile?.audience ?? "",
    competitors: (profile?.competitors ?? []).join("\n"),
    objective: profile?.objective ?? "",
    basedOnRunId: profile?.basedOnRunId ?? diagnostic?.run.id ?? "",
  };

  return (
    <WorkspaceShell active="profile" workspaceName={state.workspace.name} email={account.email}>
      <h1 className="zw-h1">Brand profile</h1>
      <p className="zw-lede">
        How you describe your company, who you sell to and who you compete with. Zypact uses it to suggest draft buyer questions; you can correct it at any
        time, and earlier versions are kept.
      </p>

      {!state.website ? (
        <section className="zw-card">
          <h2>Add your website first</h2>
          <p>
            The Brand Profile belongs to your workspace&apos;s website. <a href="/account/website">Add your website</a>.
          </p>
        </section>
      ) : (
        <section className="zw-card">
          {profile ? (
            <p className="zw-small">
              Version {profile.version}, saved {profile.savedAt.slice(0, 16).replace("T", " ")} UTC.
            </p>
          ) : draft && draft.sources.length > 0 ? (
            <p className="zw-notice">The description below was copied from {draft.sources.join(" and ")}. Check it and change anything that is not right.</p>
          ) : (
            <p className="zw-notice">Nothing here was filled in for you. Describe your company in your own words.</p>
          )}
          <ProfileForm initial={initial} objectives={OBJECTIVES.map((id) => ({ id, label: OBJECTIVE_LABELS[id] }))} />
        </section>
      )}
    </WorkspaceShell>
  );
}
