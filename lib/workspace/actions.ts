/**
 * P2 actions: the customer's investigation log (D-047). Pure.
 *
 * A suggested investigation is built only from a stored website-diagnostic
 * finding and the W1 catalogue's own text for that check: what was found,
 * what the check establishes, where (page and date), and the catalogue's fix
 * text as the next step. Nothing is generated, and nothing claims an effect
 * on AI answers — the diagnostic does not observe AI answers at all.
 *
 * An action is not a registered intervention: it never feeds a retest or an
 * Outcome Card.
 */
import { W1_CATALOG } from "@/lib/site-diagnostic/catalog";
import { SCOPE_STATEMENT } from "@/lib/site-diagnostic/copy";
import type { DiagnosticView, ViewFinding } from "@/lib/workspace/view";
import {
  ACTION_STATUSES,
  type ActionFields,
  type ActionStatus,
  type FindingRef,
  type WorkspaceAction,
} from "@/lib/workspace/store";

export const LIVE_ACTION_LIMIT = 100;

export const ACTION_STATUS_LABELS: Readonly<Record<ActionStatus, string>> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  dismissed: "Dismissed",
};

export const ACTIONS_NOTE =
  "Actions are your team's own log of what to look into and what was decided. They are not registered interventions: they do not start a retest, and no result is attributed to them.";

export interface SuggestedInvestigation {
  ref: FindingRef;
  fields: ActionFields;
  evidenceLine: string;
  priority: ViewFinding["priority"];
}

/**
 * One suggested investigation per diagnostic issue that has fix text and is
 * not already tracked by a live action, highest priority first.
 */
export function suggestedInvestigations(view: DiagnosticView | null, actions: readonly WorkspaceAction[]): SuggestedInvestigation[] {
  if (!view) return [];
  const tracked = new Set(
    actions
      .filter((a) => a.status === "open" || a.status === "in_progress")
      .map((a) => (a.evidence.kind === "site_diagnostic_finding" ? `${a.evidence.runId}|${a.evidence.checkId}|${a.evidence.pageUrl ?? ""}` : ""))
  );
  return view.fixList
    .filter((f) => !tracked.has(`${view.runId}|${f.checkId}|${f.pageUrl ?? ""}`))
    .map((f) => ({
      ref: { runId: view.runId, checkId: f.checkId, pageUrl: f.pageUrl },
      priority: f.priority,
      evidenceLine: evidenceLine(f.title, f.pageUrl, view.completedAt),
      fields: {
        title: truncate(f.title, 160),
        observation: truncate(f.excerpt ? `${f.title}: “${f.excerpt}”` : `${f.title}: the website diagnostic recorded an issue.`, 1000),
        whyItMatters: truncate(`${f.establishes} ${SCOPE_STATEMENT}`, 1000),
        nextStep: truncate(f.fix ?? "Review this finding with the page owner.", 1000),
        ownerName: null,
      },
    }));
}

export function evidenceLine(title: string, pageUrl: string | null, completedAt: string | null): string {
  const when = completedAt ? ` on ${completedAt.slice(0, 10)}` : "";
  return `Website diagnostic${when}: ${title}${pageUrl ? ` — ${pageUrl}` : ""}`;
}

export function findingTitle(checkId: string): string {
  return W1_CATALOG.find((d) => d.checkId === checkId)?.title ?? checkId;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECK_ID_RE = /^[a-z][a-z0-9_.]{2,63}$/;

type Parsed<T> = ({ ok: true } & T) | { ok: false; field: string; message: string };

function oneLine(value: unknown, min: number, max: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length >= min && text.length <= max ? text : null;
}

function parseFields(input: Record<string, unknown>): Parsed<{ fields: ActionFields }> {
  const title = oneLine(input.title, 3, 160);
  if (!title) return { ok: false, field: "title", message: "Give the action a title (3 to 160 characters)." };
  const observation = oneLine(input.observation, 1, 1000);
  if (!observation) return { ok: false, field: "observation", message: "Say what was observed (up to 1,000 characters)." };
  const why = oneLine(input.whyItMatters, 1, 1000);
  if (why === null) return { ok: false, field: "whyItMatters", message: "Keep this under 1,000 characters." };
  const nextStep = oneLine(input.nextStep, 1, 1000);
  if (!nextStep) return { ok: false, field: "nextStep", message: "Say what the team should look into next (up to 1,000 characters)." };
  const owner = oneLine(input.ownerName, 1, 120);
  if (owner === null) return { ok: false, field: "ownerName", message: "Keep the owner under 120 characters." };
  return { ok: true, fields: { title, observation, whyItMatters: why ?? null, nextStep, ownerName: owner ?? null } };
}

export function parseNewAction(input: Record<string, unknown>): Parsed<{ evidence: FindingRef | { note: string }; fields: ActionFields }> {
  const fields = parseFields(input);
  if (!fields.ok) return fields;
  const ev = (input.evidence ?? {}) as Record<string, unknown>;
  if (ev.kind === "site_diagnostic_finding") {
    if (typeof ev.runId !== "string" || !UUID_RE.test(ev.runId) || typeof ev.checkId !== "string" || !CHECK_ID_RE.test(ev.checkId)) {
      return { ok: false, field: "evidence", message: "Reload the page and try again." };
    }
    const pageUrl = ev.pageUrl === null || ev.pageUrl === undefined ? null : ev.pageUrl;
    if (pageUrl !== null && (typeof pageUrl !== "string" || pageUrl.length > 2048)) return { ok: false, field: "evidence", message: "Reload the page and try again." };
    return { ok: true, evidence: { runId: ev.runId, checkId: ev.checkId, pageUrl: pageUrl as string | null }, fields: fields.fields };
  }
  if (ev.kind === "customer_note") {
    const note = oneLine(ev.note, 1, 1000);
    if (!note) return { ok: false, field: "evidenceNote", message: "Describe the evidence: where you saw this and when (up to 1,000 characters)." };
    return { ok: true, evidence: { note }, fields: fields.fields };
  }
  return { ok: false, field: "evidence", message: "Reload the page and try again." };
}

export function parseActionRevision(
  input: Record<string, unknown>
): Parsed<{ actionId: string; expectedVersion: number; fields: ActionFields; status: ActionStatus; decisionNote: string | null }> {
  if (typeof input.actionId !== "string" || !UUID_RE.test(input.actionId)) return { ok: false, field: "actionId", message: "Reload the page and try again." };
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, field: "expectedVersion", message: "Reload the page and try again." };
  const fields = parseFields(input);
  if (!fields.ok) return fields;
  if (!ACTION_STATUSES.includes(input.status as ActionStatus)) return { ok: false, field: "status", message: "Choose a status." };
  const decision = oneLine(input.decisionNote, 1, 1000);
  if (decision === null) return { ok: false, field: "decisionNote", message: "Keep the decision note under 1,000 characters." };
  return {
    ok: true,
    actionId: input.actionId,
    expectedVersion,
    fields: fields.fields,
    status: input.status as ActionStatus,
    decisionNote: decision ?? null,
  };
}
