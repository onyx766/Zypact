/**
 * D-057 — suggested actions in a pilot (D-053 item 4): the fields an action
 * version must carry, the wording lint, and which version a report may show.
 *
 * Actions are written by the Zypact team, never generated. Each version
 * states what METHODOLOGY §12 needs at this stage: what was observed, the
 * suggested action, why it might matter (worded as a hypothesis), what else
 * could explain it, and what is not known yet, and it links to at least one
 * stored answer. Target, owner, observation window and what would count as
 * a change are captured only when the customer chooses to test an action as
 * a registered intervention (M7).
 *
 * Pure: no database, network, provider or model.
 */
import {
  MAX_ACTION_EVIDENCE,
  MIN_ACTION_EVIDENCE,
  PILOT_ACTION_TEXT_FIELDS,
} from "@/lib/pilots/action-copy";
import { UUID_PATTERN, type Issues, type Parsed } from "@/lib/pilots/validate";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";

export {
  EDIT_PILOT_ACTION_NOTE,
  MAX_ACTION_EVIDENCE,
  MIN_ACTION_EVIDENCE,
  PILOT_ACTION_STATUS_WORDS,
  PILOT_ACTION_TEXT_FIELDS,
  REVIEW_PILOT_ACTION_PROMPT,
  REVIEW_PILOT_ACTION_REFUSAL,
  SAVE_PILOT_ACTION_REFUSAL,
  STALE_REVISION_WORDS,
  WITHDRAW_PILOT_ACTION_PROMPT,
  WITHDRAW_PILOT_ACTION_REFUSAL,
} from "@/lib/pilots/action-copy";

export type PilotActionTextKey = (typeof PILOT_ACTION_TEXT_FIELDS)[number]["key"];
export type PilotActionText = Record<PilotActionTextKey, string>;

export const MAX_SOURCE_URL_LENGTH = 2048;

export interface PilotActionEvidenceLink {
  attemptId: string;
  /** One source of that answer, picked from its extracted sources; null for the answer alone. */
  sourceUrl: string | null;
}

export interface SavePilotActionFields extends PilotActionText {
  /** Null for a new action; set, with the expected version, for an edit. */
  actionId: string | null;
  expectedVersion: number | null;
  evidence: PilotActionEvidenceLink[];
  idempotencyKey: string;
}

/** METHODOLOGY §19's prohibited statements, and close variants. */
export const METHODOLOGY_19_PHRASES: readonly string[] = [
  "you lost the sale",
  "lost the sale",
  "cannot find you",
  "can't find you",
  "overall ai visibility",
  "your overall visibility",
  "caused the lift",
  "fix caused",
  "we control what",
  "we guarantee",
  "no competitor offers",
];

/**
 * Causal or promise wording an action may not use: it is a hypothesis to
 * test, not a prediction. Matched as whole phrases; the patterns below catch
 * the hedged and inflected forms ("will likely improve", "is expected to
 * increase", "guaranteed", "causes").
 */
export const PILOT_ACTION_PROMISE_PHRASES: readonly string[] = [
  "will improve",
  "will increase",
  "will boost",
  "will raise",
  "will grow",
  "will get you",
  "will make ai",
  "will make chatgpt",
  "will make perplexity",
  "will appear",
  "will be recommended",
  "will be cited",
  "will be named",
  "will be mentioned",
  "guarantee",
  "caused",
  "because of this page",
  "ensure",
  "boost your ranking",
  "boost your visibility",
  "rank higher",
  "rank first",
];

/** D-057 (engineer) — a modal or hedge, then up to three words, then a change verb. */
const MODALS = [
  "will", "would", "should", "could", "likely to", "expected to", "going to", "set to", "bound to", "sure to",
  "certain to", "proven to", "is likely", "is expected",
];
const CHANGE_VERBS = [
  "improve", "increase", "boost", "raise", "grow", "lift", "get", "make", "appear", "rank", "be cited",
  "be recommended", "be mentioned", "show up", "win",
];
const CAUSAL = [
  "cause", "causes", "caused", "causing", "led to", "leads to", "lead to", "result in", "results in", "resulted in",
  "resulting in", "because of", "due to", "drives", "drove", "driven by",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (list: readonly string[]) => list.map((w) => escape(w).replace(/ /g, " ")).join("|");
const B = "(?<![a-z0-9])";
const E = "(?![a-z0-9])";

/** Named patterns: the label shown to the writer, and the expression on the normalised text. */
const LINT_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: "a prediction (a modal followed by a change)", re: new RegExp(`${B}(?:${words(MODALS)})(?: [a-z0-9'-]+){0,3}? (?:${words(CHANGE_VERBS)})${E}`, "g") },
  { label: "a claim of cause", re: new RegExp(`${B}(?:${words(CAUSAL)})${E}`, "g") },
  { label: "a statement that buyers cannot find you", re: new RegExp(`${B}(?:cannot|can not|can't|cant) find you${E}`, "g") },
  { label: "a guarantee", re: new RegExp(`${B}guarante[a-z]*`, "g") },
  { label: "a promise to ensure", re: new RegExp(`${B}ensur(?:e|es|ed|ing)${E}`, "g") },
];

/**
 * Common Cyrillic and Greek letters that look like Latin ones, lower case
 * (the text is lower-cased first), folded so a look-alike cannot hide a
 * phrase ("cаused" with a Cyrillic "а").
 */
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ϲ": "c", "ϳ": "j", "ѵ": "v",
};

/**
 * The text the lint reads, D-057 (engineer): Unicode NFKC, lower case,
 * format characters (category Cf: soft hyphen, zero-width characters, the
 * byte-order mark) removed or, in the second reading, turned into spaces,
 * look-alike letters folded to Latin, typographic quotes made plain, and
 * whitespace collapsed. Both readings are linted, so "guar­antee"
 * (removed) and "will​improve" (spaced) are both caught.
 */
export function normaliseForLint(text: string, formatCharacters: "remove" | "space"): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, formatCharacters === "remove" ? "" : " ")
    .replace(/[Ͱ-ϿЀ-ԯ]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The wording an action text uses that it may not: METHODOLOGY §19, the
 * causal and promise wording above, the repository's claim-language list
 * (FORBIDDEN_W1_PHRASES), and the patterns. Phrases match as whole words on
 * both sides, so "censured" is not "ensure", "Make sure to keep" is not a
 * prediction and "Use proven tools" is not "proven to". Returns each hit
 * once: the phrase, or the words a pattern matched.
 */
export function lintPilotActionText(text: string): string[] {
  const hits = new Set<string>();
  const phrases = [...new Set([...METHODOLOGY_19_PHRASES, ...PILOT_ACTION_PROMISE_PHRASES, ...FORBIDDEN_W1_PHRASES])];
  for (const reading of [normaliseForLint(text, "remove"), normaliseForLint(text, "space")]) {
    for (const phrase of phrases) {
      if (new RegExp(`${B}${escape(phrase)}${E}`).test(reading)) hits.add(phrase);
    }
    for (const pattern of LINT_PATTERNS) {
      for (const m of reading.matchAll(pattern.re)) hits.add(m[0]);
    }
  }
  return [...hits];
}

/** Every field's lint hits, by field. Empty when the action may be saved. */
export function lintPilotAction(text: PilotActionText): Issues {
  const issues: Issues = {};
  for (const field of PILOT_ACTION_TEXT_FIELDS) {
    const hits = lintPilotActionText(text[field.key]);
    if (hits.length > 0) {
      issues[field.key] = [
        `Reword without ${hits.map((h) => `"${h}"`).join(", ")}: a suggested action is a hypothesis to test, never a prediction or a claim of cause.`,
      ];
    }
  }
  return issues;
}

const str = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

export function parseSavePilotAction(raw: unknown): Parsed<SavePilotActionFields> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const issues: Issues = {};
  const add = (k: string, m: string) => {
    (issues[k] ??= []).push(m);
  };

  const text = {} as PilotActionText;
  for (const field of PILOT_ACTION_TEXT_FIELDS) {
    const value = str(body, field.key);
    if (value.length < field.min || value.length > field.max) {
      add(field.key, `${field.label}: ${field.min}-${field.max} characters.`);
    }
    text[field.key] = value;
  }

  const actionIdRaw = body.actionId;
  const expectedRaw = body.expectedVersion;
  let actionId: string | null = null;
  let expectedVersion: number | null = null;
  if (actionIdRaw === null || actionIdRaw === undefined || actionIdRaw === "") {
    if (expectedRaw !== null && expectedRaw !== undefined && expectedRaw !== "") add("actionId", "Reload the page and try again.");
  } else if (typeof actionIdRaw !== "string" || !UUID_PATTERN.test(actionIdRaw)) {
    add("actionId", "Reload the page and try again.");
  } else {
    actionId = actionIdRaw;
    const n = typeof expectedRaw === "string" ? Number(expectedRaw) : expectedRaw;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) add("expectedVersion", "Reload the page and try again.");
    else expectedVersion = n;
  }

  const evidence: PilotActionEvidenceLink[] = [];
  const list = Array.isArray(body.evidence) ? body.evidence : null;
  if (!list || list.length < MIN_ACTION_EVIDENCE) {
    add("evidence", "Link at least one stored answer the action rests on.");
  } else if (list.length > MAX_ACTION_EVIDENCE) {
    add("evidence", `Link at most ${MAX_ACTION_EVIDENCE} answers.`);
  } else {
    const seen = new Set<string>();
    for (const item of list) {
      const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const attemptId = typeof o.attemptId === "string" ? o.attemptId : "";
      const sourceUrl = o.sourceUrl === null || o.sourceUrl === undefined || o.sourceUrl === "" ? null : o.sourceUrl;
      if (!UUID_PATTERN.test(attemptId)) {
        add("evidence", "Pick each answer from the list.");
        continue;
      }
      if (
        sourceUrl !== null &&
        (typeof sourceUrl !== "string" || !/^https?:\/\//.test(sourceUrl) || sourceUrl.length < 10 || sourceUrl.length > MAX_SOURCE_URL_LENGTH)
      ) {
        add("evidence", "Pick each source from the answer's own sources.");
        continue;
      }
      const key = `${attemptId}|${sourceUrl ?? ""}`;
      if (seen.has(key)) {
        add("evidence", "The same answer and source is linked twice.");
        continue;
      }
      seen.add(key);
      evidence.push({ attemptId, sourceUrl: sourceUrl as string | null });
    }
  }

  const idempotencyKey = str(body, "idempotencyKey");
  if (!UUID_PATTERN.test(idempotencyKey)) add("idempotencyKey", "Reload the page and try again.");

  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const lint = lintPilotAction(text);
  if (Object.keys(lint).length > 0) return { ok: false, issues: lint };
  return { ok: true, value: { ...text, actionId, expectedVersion, evidence, idempotencyKey } };
}

/* ---------------------------------------------------------------- which version a report shows */

export interface PilotActionVersionRow {
  id: string;
  actionId: string;
  versionNumber: number;
}

export interface PilotActionEventRow {
  actionId: string;
  actionVersionId: string | null;
  event: "reviewed" | "withdrawn";
  createdAt: string;
}

export type { PilotActionStatus } from "@/lib/pilots/action-copy";
import type { PilotActionStatus } from "@/lib/pilots/action-copy";

/**
 * An action's status from its stored rows: withdrawn once withdrawn;
 * otherwise reviewed only when its latest version has a review. An edit
 * after a review is a new draft version, so the action is a draft again.
 */
export function pilotActionStatus(
  actionId: string,
  versions: PilotActionVersionRow[],
  events: PilotActionEventRow[]
): { status: PilotActionStatus; latest: PilotActionVersionRow | null; reviewedAt: string | null } {
  const own = versions.filter((v) => v.actionId === actionId).sort((a, b) => b.versionNumber - a.versionNumber);
  const latest = own[0] ?? null;
  if (events.some((e) => e.actionId === actionId && e.event === "withdrawn")) return { status: "withdrawn", latest, reviewedAt: null };
  const review = latest ? events.find((e) => e.event === "reviewed" && e.actionVersionId === latest.id) : undefined;
  return review ? { status: "reviewed", latest, reviewedAt: review.createdAt } : { status: "draft", latest, reviewedAt: null };
}

/** The version a report shows for each action: its latest, when reviewed and not withdrawn. */
export function reportableActionVersions(
  actionIds: string[],
  versions: PilotActionVersionRow[],
  events: PilotActionEventRow[]
): { actionId: string; versionId: string; reviewedAt: string }[] {
  const out: { actionId: string; versionId: string; reviewedAt: string }[] = [];
  for (const actionId of actionIds) {
    const s = pilotActionStatus(actionId, versions, events);
    if (s.status === "reviewed" && s.latest && s.reviewedAt) out.push({ actionId, versionId: s.latest.id, reviewedAt: s.reviewedAt });
  }
  return out;
}

/**
 * Whether a saved revision's listed action versions are still exactly the
 * pilot's reviewed, current ones (D-057). False once an action listed in it
 * was edited or withdrawn, or another action was reviewed since the build:
 * such a revision cannot be shared (share_pilot_report_artifact refuses it as
 * ACTIONS_STALE), and the console says so.
 */
export function revisionActionsCurrent(listedVersionIds: readonly string[], currentVersionIds: readonly string[]): boolean {
  const listed = new Set(listedVersionIds);
  const current = new Set(currentVersionIds);
  return listed.size === current.size && [...listed].every((id) => current.has(id));
}
