import type { Metadata } from "next";

import { loadWorkspace } from "@/lib/workspace/load";

import { LaterSection, WorkspaceShell } from "../workspace-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sources", robots: { index: false, follow: false } };

export default async function WorkspaceSourcesPage() {
  const { state, account } = await loadWorkspace();
  return (
    <WorkspaceShell active="sources" workspaceName={state.workspace.name} email={account.email}>
      <LaterSection
        title="Sources"
        lede="Where the information in measured AI answers comes from. This section fills from measured answers to your approved questions, so it is empty until measurement opens for your workspace."
        points={[
          "Source URLs an answer cites, with a numbered reference",
          "Retrieved-only URLs, shown separately: returned by the provider but not cited in the answer",
          "Known source categories; anything not on the reviewed list stays unclassified rather than guessed",
          "How often a source is cited, always as “k of n” measured runs",
          "The buyer question and the original answer behind every source",
          "A cited page is not shown to have shaped the answer, and a retrieved page is never presented as cited",
        ]}
      />
    </WorkspaceShell>
  );
}
