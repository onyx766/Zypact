/**
 * The Team Brief (D-047): what the workspace holds, in the nine sections the
 * pricing and workspace direction lists, as text a customer can copy into an
 * email or a deck. Pure.
 *
 * Every line comes from a stored row — the Brand Profile, the latest website
 * diagnostic, the draft questions and the action log — and names its source.
 * Sections that need measured AI answers (competitor observations, cited
 * sources, retest outcomes) say plainly that none exist yet; they are never
 * filled with placeholders or estimates.
 */
import { evidenceLine } from "@/lib/workspace/actions";
import { ACTION_STATUS_LABELS } from "@/lib/workspace/actions";
import { DRAFT_STATUS_NOTE, SUGGESTION_DISCLAIMER } from "@/lib/workspace/questions";
import type { QuestionDraft, WorkspaceAction, WorkspaceState } from "@/lib/workspace/store";
import { OBJECTIVE_LABELS, type DiagnosticView } from "@/lib/workspace/view";

export const NOT_MEASURED =
  "No AI answers have been measured for this workspace yet, so this brief contains no observation about what AI systems say.";

export interface BriefSection {
  id: string;
  heading: string;
  lines: string[];
}

export interface TeamBrief {
  title: string;
  preparedAt: string;
  sections: BriefSection[];
}

export interface BriefInput {
  state: WorkspaceState;
  view: DiagnosticView | null;
  drafts: readonly QuestionDraft[];
  actions: readonly WorkspaceAction[];
  now: Date;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function buildTeamBrief({ state, view, drafts, actions, now }: BriefInput): TeamBrief {
  const company = state.profile?.companyName ?? state.workspace.name;
  const live = actions.filter((a) => a.status === "open" || a.status === "in_progress");
  const closed = actions.filter((a) => a.status === "done" || a.status === "dismissed");
  const liveDrafts = drafts.filter((d) => d.status === "draft");

  const summary: string[] = [];
  if (state.website) summary.push(`Website: ${state.website.domain}.`);
  if (state.profile?.objective) summary.push(`Current goal: ${OBJECTIVE_LABELS[state.profile.objective]}.`);
  if (view) {
    summary.push(
      `The website diagnostic of ${view.completedAt.slice(0, 10)} checked ${plural(view.pagesFetched, "page")} and recorded ${plural(view.counts.issue, "issue")}, ${view.counts.pass} passed, ${view.counts.info} for information and ${view.counts.unknown} that could not be checked.`
    );
  } else {
    summary.push("The website diagnostic has not been run yet.");
  }
  summary.push(`The team is tracking ${plural(live.length, "open action")} and has closed ${closed.length}.`);
  summary.push(`${plural(liveDrafts.length, "draft buyer question")} ${liveDrafts.length === 1 ? "is" : "are"} in review.`);
  summary.push(NOT_MEASURED);

  const observations = view
    ? view.fixList.slice(0, 5).map((f) => `${f.title} (${f.priority} priority). Evidence: ${evidenceLine(f.title, f.pageUrl, view.completedAt)}.`)
    : [];

  const competitors = state.profile?.competitors ?? [];
  const competitorLines = [
    competitors.length > 0 ? `Competitors named in the Brand Profile: ${competitors.join(", ")}.` : "No competitors are named in the Brand Profile yet.",
    "There are no competitor observations: they come from measured AI answers, and none have been measured.",
  ];

  const investigations = live.map((a) => `${a.title}. Next step: ${a.nextStep}`);
  const owners = actions.map(
    (a) => `${a.title} — ${ACTION_STATUS_LABELS[a.status]}${a.ownerName ? `, owner ${a.ownerName}` : ", no owner yet"}${a.decisionNote ? `. Decision: ${a.decisionNote}` : ""}`
  );

  const limitations = [...(view?.notices ?? [])];
  limitations.push(NOT_MEASURED);
  if (liveDrafts.some((d) => d.origin !== "customer_written")) limitations.push(SUGGESTION_DISCLAIMER);
  if (liveDrafts.length > 0) limitations.push(DRAFT_STATUS_NOTE);
  limitations.push("Actions are the team's own log. No change in any result is attributed to them.");

  const next = nextReview(state, view, live);

  return {
    title: `${company} — team brief`,
    preparedAt: now.toISOString(),
    sections: [
      { id: "summary", heading: "1. Executive summary", lines: summary },
      { id: "observations", heading: "2. Important observations", lines: orNone(observations, "No website issues were recorded.") },
      { id: "competitors", heading: "3. Competitor findings", lines: competitorLines },
      { id: "sources", heading: "4. Important cited sources", lines: ["None yet: cited sources come from measured AI answers, and none have been measured."] },
      { id: "investigations", heading: "5. Suggested investigations", lines: orNone(investigations, "No open investigations.") },
      { id: "actions", heading: "6. Registered actions and owners", lines: orNone(owners, "No actions recorded yet.") },
      { id: "retests", heading: "7. Retest outcomes", lines: ["None: no retest has run for this workspace."] },
      { id: "evidence", heading: "8. Evidence references and limitations", lines: limitations },
      { id: "next", heading: "9. Recommended next review", lines: [next] },
    ],
  };
}

function orNone(lines: string[], none: string): string[] {
  return lines.length > 0 ? lines : [none];
}

function nextReview(state: WorkspaceState, view: DiagnosticView | null, live: readonly WorkspaceAction[]): string {
  if (!view) return "Run the website diagnostic, then review its issues together.";
  if (live.some((a) => !a.ownerName)) return "Assign an owner to each open action, then review progress on them.";
  if (live.length > 0) return "Review progress on the open actions; when pages change, re-run the website diagnostic.";
  if (!state.profile) return "Review and correct the Brand Profile.";
  return "Review the draft buyer questions and remove any that overlap.";
}

/** Plain text for the clipboard: headings, then one line per item. */
export function briefAsText(brief: TeamBrief): string {
  const parts = [brief.title, `Prepared ${brief.preparedAt.slice(0, 16).replace("T", " ")} UTC`, ""];
  for (const s of brief.sections) {
    parts.push(s.heading);
    for (const line of s.lines) parts.push(`- ${line}`);
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}
