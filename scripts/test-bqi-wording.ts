#!/usr/bin/env tsx
/**
 * Buyer Question Intelligence Q1 — wording classification, version
 * mapping, labels, and purity/boundary checks
 * (Q1_SCOPE_AND_TEST_PLAN.md sections 6.3 and 6.4, cases W-01 to W-11
 * and P-01 to P-04).
 *
 * The W cases are pure function calls over invented fixtures. The P cases
 * read source files under lib/buyer-questions/ and run local, read-only
 * git commands (P-04) in this repository; no network, database or clock.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyApprovedWording, validateFounderClassification } from "@/lib/buyer-questions/classify-wording";
import {
  FORBIDDEN_CUSTOMER_PROVIDED_PHRASES,
  FORBIDDEN_LABEL_PHRASES,
  allLabels,
} from "@/lib/buyer-questions/labels";
import {
  EVIDENCE_GRADES,
  WORDING_CLASSIFICATIONS,
  isEvidenceGrade,
  isWordingClassification,
  type Candidate,
  type CandidateSourceLink,
  type EvidenceGrade,
  type QuestionSource,
  type RelevanceRatings,
  type ResearchSet,
  type SourceKind,
} from "@/lib/buyer-questions/types";
import { sha256Utf8Hex } from "@/lib/buyer-questions/validate-source";
import { AWAITING_REVIEW_RATIONALE, customerWrittenVersionFields, mapVersionFields } from "@/lib/buyer-questions/version-fields";
import { validateBuyerQuestionVersionNumericFields } from "@/lib/db/validate-buyer-question-version-fields";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fixtures

function source(id: string, excerpt: string, kind: SourceKind = "public_community"): QuestionSource {
  return kind === "customer_material"
    ? {
        id,
        kind,
        buyerAuthored: true,
        customerReference: `ticket-${id}`,
        customerAttestedAt: "2026-10-01",
        retrievedAt: "2026-09-30",
        excerpt,
        excerptSha256: sha256Utf8Hex(excerpt),
        personalDataRemoved: true,
      }
    : {
        id,
        kind,
        buyerAuthored: kind !== "site_copy",
        url: `https://forum.example.org/${id}`,
        retrievedAt: "2026-10-02",
        excerpt,
        excerptSha256: sha256Utf8Hex(excerpt),
        personalDataRemoved: true,
      };
}

function ratings(br: number, icp: number, ci: number, pr: number, reason = "fits the stated need"): RelevanceRatings {
  return {
    buyerRelevance: { value: br, reason },
    icpFit: { value: icp, reason },
    commercialIntent: { value: ci, reason },
    productRelevance: { value: pr, reason },
  };
}

const OBS_TEXT = "Which invoicing tool works best for a small accounting firm?";
const NFC_TEXT = "Which café booking app handles group orders?";
const NFD_TEXT = "Which café booking app handles group orders?";
const BASIS_TEXT = "Reconciling invoices takes our firm forever and nothing fits.";

function cand(id: string, text: string, grade: EvidenceGrade): Candidate {
  return {
    id,
    text,
    grade,
    kind: "unbranded",
    buyerStage: "solution",
    adaptationNote: grade === "adapted" ? "reworded the complaint as a question" : null,
    ratings: ratings(3, 3, 2, 3),
    curatorRank: 1,
  };
}

function link(candidateId: string, sourceId: string, relation: CandidateSourceLink["relation"]): CandidateSourceLink {
  return { candidateId, sourceId, relation, quotedSpan: null };
}

function researchSet(): ResearchSet {
  return {
    siteContext: { brandNames: [{ name: "Acme" }], productNames: [], siteCopy: "" },
    sources: [
      source("pub", OBS_TEXT),
      source("cust", "How do we route invoice approvals to two managers?", "customer_material"),
      source("nfc", NFC_TEXT),
      source("basis", BASIS_TEXT),
      source("site", "Which invoicing tool is best? Acme.", "site_copy"),
    ],
    candidates: [
      cand("obs-pub", OBS_TEXT, "observed"),
      cand("obs-cust", "How do we route invoice approvals to two managers?", "observed"),
      cand("obs-nfc", NFC_TEXT, "observed"),
      cand("ada", "How can a small firm reconcile invoices faster?", "adapted"),
      cand("hyp", "Which tools do clinics use for invoice approvals?", "hypothesis"),
    ],
    links: [
      link("obs-pub", "pub", "verbatim"),
      link("obs-cust", "cust", "verbatim"),
      link("obs-nfc", "nfc", "verbatim"),
      link("ada", "basis", "paraphrase_basis"),
    ],
  };
}

// ---------------------------------------------------------------- W cases

function w01(): void {
  console.log("\nW-01 unchanged candidate of each grade and verification");
  const set = researchSet();
  const expected: Array<[string, EvidenceGrade, string | null]> = [
    ["obs-pub", "observed", "public_verifiable"],
    ["obs-cust", "observed", "customer_provided"],
    ["ada", "adapted", "public_verifiable"],
    ["hyp", "hypothesis", null],
  ];
  for (const origin of ["recommended_unchanged", "replaced_with_candidate"] as const) {
    for (const [id, grade, verification] of expected) {
      const c = set.candidates.find((x) => x.id === id)!;
      const r = classifyApprovedWording({ origin, approvedText: c.text, candidateId: id, researchSet: set });
      check(
        `W-01 ${origin} ${id}: inherited_unchanged, ${grade}, ${verification}`,
        r.rule === "inherited_unchanged" && r.classification === grade && r.verification === verification && r.provenance === "founder_supplied"
      );
    }
  }
  const edited = classifyApprovedWording({ origin: "recommended_unchanged", approvedText: `${OBS_TEXT} `, candidateId: "obs-pub", researchSet: set });
  check("W-01 'unchanged' origin with different text: refused", edited.refusals.some((r) => r.code === "unchanged_text_differs"));
}

function w02(): void {
  console.log("\nW-02 edited observed candidate still matching; NFC versus NFD");
  const set = researchSet();
  const still = classifyApprovedWording({ origin: "recommended_edited", approvedText: `  ${OBS_TEXT.replace("?", "")}  `, candidateId: "obs-pub", researchSet: set });
  check("W-02 whitespace/terminal edit: observed by exact_source_match, public_verifiable", still.classification === "observed" && still.rule === "exact_source_match" && still.verification === "public_verifiable" && still.matchedSourceIds.join() === "pub");
  const cust = classifyApprovedWording({ origin: "recommended_edited", approvedText: "How do we route invoice approvals to two managers", candidateId: "obs-cust", researchSet: set });
  check("W-02 customer-material source keeps customer_provided", cust.classification === "observed" && cust.verification === "customer_provided");
  const nfd = classifyApprovedWording({ origin: "recommended_edited", approvedText: NFD_TEXT, candidateId: "obs-nfc", researchSet: set });
  check("W-02 NFD edit of NFC source: pending_review", nfd.classification === "pending_review" && nfd.rule === null);
  check("W-02 NFD edit: unicode_normalization_differs", nfd.signals.some((s) => s.code === "unicode_normalization_differs"));
}

function w03(): void {
  console.log("\nW-03 edited observed candidate that no longer matches");
  const set = researchSet();
  for (const text of [OBS_TEXT.toLowerCase(), OBS_TEXT.replace("small", "tiny"), OBS_TEXT.replace("?", "？")]) {
    const r = classifyApprovedWording({ origin: "recommended_edited", approvedText: text, candidateId: "obs-pub", researchSet: set });
    check(`W-03 ${JSON.stringify(text.slice(-24))}: pending_review, never observed`, r.classification === "pending_review" && r.verification === null);
  }
  const ctxOnly = classifyApprovedWording({ origin: "recommended_edited", approvedText: "Which invoicing tool is best? Acme.", candidateId: "hyp", researchSet: { ...researchSet(), links: [link("hyp", "site", "context")] } });
  check("W-03 match to seller site copy never classifies observed", ctxOnly.classification === "pending_review");
}

function w04(): void {
  console.log("\nW-04 customer-written text matching a buyer-authored source");
  const set = researchSet();
  const r = classifyApprovedWording({ origin: "customer_written", approvedText: "how do we route invoice approvals to two managers?".replace("how", "How"), researchSet: set });
  check("W-04 observed by exact_source_match", r.classification === "observed" && r.rule === "exact_source_match" && r.verification === "customer_provided");
  check("W-04 provenance customer_supplied", r.provenance === "customer_supplied");
  const site = classifyApprovedWording({ origin: "customer_written", approvedText: "Which invoicing tool is best? Acme.", researchSet: set });
  check("W-04 matching only site copy: not observed", site.classification === "pending_review");
}

function w05(): void {
  console.log("\nW-05 customer-written text matching nothing");
  const r = classifyApprovedWording({ origin: "customer_written", approvedText: "Which invoicing app do dentists prefer?", researchSet: researchSet() });
  check("W-05 pending_review, customer_supplied", r.classification === "pending_review" && r.provenance === "customer_supplied" && r.verification === null);
}

function w06(): void {
  console.log("\nW-06 founder review adapted");
  const set = researchSet();
  const text = "Which invoicing app do dentists prefer?";
  const noBasis = validateFounderClassification({ classification: "adapted", approvedText: text, sourceIds: [], note: "reworded", researchSet: set });
  check("W-06 adapted without basis: refused", !noBasis.accepted && noBasis.refusals.some((r) => r.code === "adapted_requires_paraphrase_basis"));
  const noNote = validateFounderClassification({ classification: "adapted", approvedText: text, sourceIds: ["basis"], note: " ", researchSet: set });
  check("W-06 adapted without note: refused", !noNote.accepted && noNote.refusals.some((r) => r.code === "adapted_requires_note"));
  const seller = validateFounderClassification({ classification: "adapted", approvedText: text, sourceIds: ["site"], note: "reworded", researchSet: set });
  check("W-06 adapted citing site copy: refused", !seller.accepted);
  const ok = validateFounderClassification({ classification: "adapted", approvedText: text, sourceIds: ["basis"], note: "narrowed to dentists", researchSet: set });
  check("W-06 adapted with basis and note: accepted", ok.accepted && ok.classification === "adapted" && ok.verification === "public_verifiable");
  const hyp = validateFounderClassification({ classification: "hypothesis", approvedText: text, sourceIds: [], researchSet: set });
  check("W-06 hypothesis: accepted", hyp.accepted && hyp.classification === "hypothesis");
  const badObs = validateFounderClassification({ classification: "observed", approvedText: text, sourceIds: ["pub"], researchSet: set });
  check("W-06 founder observed without an exact match: refused", !badObs.accepted);
}

function w07(): void {
  console.log("\nW-07 customer_edited is not a grade or classification");
  check("W-07 not an evidence grade", !isEvidenceGrade("customer_edited") && !(EVIDENCE_GRADES as readonly string[]).includes("customer_edited"));
  check("W-07 not a wording classification", !isWordingClassification("customer_edited") && !(WORDING_CLASSIFICATIONS as readonly string[]).includes("customer_edited"));
  const founder = validateFounderClassification({ classification: "customer_edited", approvedText: "x?", sourceIds: [], researchSet: researchSet() });
  check("W-07 founder review entry refused", !founder.accepted && founder.refusals.some((r) => r.code === "unknown_grade"));
  const origin = classifyApprovedWording({ origin: "customer_edited", approvedText: OBS_TEXT, researchSet: researchSet() });
  check("W-07 as an origin: refused", origin.classification === null && origin.refusals.some((r) => r.code === "unknown_origin"));
  const pending = validateFounderClassification({ classification: "pending_review", approvedText: "x?", sourceIds: [], researchSet: researchSet() });
  check("W-07 pending_review is not a founder review outcome", !pending.accepted && pending.refusals.some((r) => r.code === "classification_not_allowed"));
}

function w08(): void {
  console.log("\nW-08 version mapping over every combination");
  let combos = 0;
  let inRange = 0;
  let validated = 0;
  for (let ci = 0; ci <= 3; ci += 1) {
    for (let icp = 0; icp <= 3; icp += 1) {
      for (let pr = 0; pr <= 3; pr += 1) {
        for (let br = 0; br <= 3; br += 1) {
          for (const grade of EVIDENCE_GRADES) {
            combos += 1;
            const f = mapVersionFields(ratings(br, icp, ci, pr), grade);
            const cv = 1 + ci + (icp === 3 ? 1 : 0);
            const w = 1 + pr + (grade === "observed" ? 1 : 0);
            if (f.commercialValue === cv && f.winnability === w && f.priority === Math.min(25, cv * w) && f.commercialValue >= 1 && f.commercialValue <= 5 && f.winnability >= 1 && f.winnability <= 5 && f.priority >= 1 && f.priority <= 25) inRange += 1;
            try {
              validateBuyerQuestionVersionNumericFields(f);
              validated += 1;
            } catch {
              // counted as a failure below
            }
          }
        }
      }
    }
  }
  check(`W-08 all ${combos} combinations follow the formula within 1-5, 1-5, 1-25`, inRange === combos);
  check(`W-08 all ${combos} pass the 0048 validator`, validated === combos);
  const f = mapVersionFields(ratings(2, 3, 3, 2), "observed");
  check("W-08 intent 3, ICP 3, product 2, observed gives 5, 4, 20", f.commercialValue === 5 && f.winnability === 4 && f.priority === 20);
  let threw = 0;
  for (const bad of [ratings(3, 3, 4, 2), ratings(3, 3, 1.5, 2), ratings(3, 3, 2, 2, " ")]) {
    try {
      mapVersionFields(bad, "observed");
    } catch {
      threw += 1;
    }
  }
  check("W-08 invalid ratings throw instead of mapping", threw === 3);
}

function w09(): void {
  console.log("\nW-09 customer-written question before review");
  const f = customerWrittenVersionFields();
  check("W-09 1, 1, 1 and \"awaiting review\"", f.commercialValue === 1 && f.winnability === 1 && f.priority === 1 && f.rationale === "awaiting review" && AWAITING_REVIEW_RATIONALE === "awaiting review");
}

function w10(): void {
  console.log("\nW-10 labels contain no forbidden phrase");
  const labels = allLabels();
  check("W-10 labels enumerated", labels.length > 20, `${labels.length} labels`);
  const forbidden = labels.filter(({ label, customerProvided }) => {
    const lower = label.toLowerCase();
    return (
      FORBIDDEN_LABEL_PHRASES.some((p) => lower.includes(p)) ||
      (customerProvided && FORBIDDEN_CUSTOMER_PROVIDED_PHRASES.some((p) => lower.includes(p)))
    );
  });
  check("W-10 no forbidden phrase", forbidden.length === 0, forbidden.map((l) => l.label).join(" | "));
  const required = ["buyers ask", "real buyer question", "probability", "win rate", "likelihood"];
  check("W-10 the forbidden list covers the plan's phrases", required.every((p) => FORBIDDEN_LABEL_PHRASES.includes(p)) && FORBIDDEN_CUSTOMER_PROVIDED_PHRASES.includes("verified"));
  check("W-10 observed customer-provided label exact", labels.some((l) => l.label === "Observed — customer-provided" && l.customerProvided));
}

function w11(): void {
  console.log("\nW-11 rationales never present values as probability, win rate or value estimate");
  const banned = /probab|win rate|winning|likelihood|chance|estimat|forecast|predict|expected value|commercial value|revenue|%/i;
  const offending: string[] = [];
  for (let ci = 0; ci <= 3; ci += 1)
    for (let icp = 0; icp <= 3; icp += 1)
      for (let pr = 0; pr <= 3; pr += 1)
        for (const grade of EVIDENCE_GRADES) {
          const { rationale } = mapVersionFields(ratings(2, icp, ci, pr, "neutral reason"), grade);
          if (banned.test(rationale)) offending.push(rationale);
        }
  if (banned.test(customerWrittenVersionFields().rationale)) offending.push("awaiting review");
  check("W-11 every rationale template is free of banned framing", offending.length === 0, offending[0] ?? "");
}

// ---------------------------------------------------------------- P cases

const LIB_DIR = join(process.cwd(), "lib", "buyer-questions");
const LIB_FILES = readdirSync(LIB_DIR).filter((f) => f.endsWith(".ts")).sort();

function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) specifiers.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return specifiers;
}

function p01(): void {
  console.log("\nP-01 imports limited to the allowed modules");
  const allowed = (spec: string) =>
    spec === "node:crypto" ||
    spec === "@/lib/evidence/normalize-entity-text" ||
    spec === "@/lib/db/validate-buyer-question-version-fields" ||
    /^\.\/[a-z-]+$/.test(spec);
  const expectedFiles = [
    "brand-match.ts", "classify-wording.ts", "duplicates.ts", "labels.ts", "marketing-signal.ts", "normalize.ts",
    "select.ts", "types.ts", "validate-candidate.ts", "validate-source.ts", "version-fields.ts",
  ];
  check("P-01 exactly the eleven planned files", LIB_FILES.join() === expectedFiles.join(), LIB_FILES.join(","));
  for (const f of LIB_FILES) {
    const specs = importsOf(readFileSync(join(LIB_DIR, f), "utf8"));
    const bad = specs.filter((s) => !allowed(s) || (s.startsWith("./") && !expectedFiles.includes(`${s.slice(2)}.ts`)));
    check(`P-01 ${f}: imports allowed`, bad.length === 0, bad.join(",") || specs.join(","));
  }
}

function p02(): void {
  console.log("\nP-02 the D-019 normaliser is used only by brand-match.ts");
  for (const f of LIB_FILES) {
    const text = readFileSync(join(LIB_DIR, f), "utf8");
    const uses = /normalize-entity-text|normalizeEntityTextV1|NORMALIZER_V1_LEGAL_SUFFIXES/.test(text);
    check(`P-02 ${f}: ${f === "brand-match.ts" ? "uses" : "does not use"} D-019`, f === "brand-match.ts" ? uses : !uses);
  }
}

function p03(): void {
  console.log("\nP-03 no I/O, clock, randomness or provider in the source");
  const banned = ["fetch(", "process.env", "Date.now", "new Date(", "Math.random", "supabase", "createClient", "callModel", "openai", "anthropic", "perplexity", "node:fs", "node:http", "node:net", "child_process", "crypto.random", "randomUUID", "randomBytes"];
  for (const f of LIB_FILES) {
    const text = readFileSync(join(LIB_DIR, f), "utf8").toLowerCase();
    const found = banned.filter((b) => text.includes(b.toLowerCase()));
    check(`P-03 ${f}: none of the banned tokens`, found.length === 0, found.join(","));
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function p04(): void {
  console.log("\nP-04 changed paths against the base");
  const allowedPaths = new Set([
    ...LIB_FILES.map((f) => `lib/buyer-questions/${f}`),
    "scripts/test-bqi-candidates.ts",
    "scripts/test-bqi-selection.ts",
    "scripts/test-bqi-wording.ts",
    "package.json",
    "docs/CURRENT_STATUS.md",
  ]);
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"]);
  } catch {
    check("P-04 merge base with origin/main found", false, "git merge-base failed");
    return;
  }
  const committed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n");
  const working = git(["diff", "--name-only", "HEAD"]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  const changed = [...new Set([...committed, ...working, ...untracked])].filter((p) => p.length > 0).sort();
  const outside = changed.filter((p) => !allowedPaths.has(p));
  check(`P-04 base ${base.slice(0, 12)}: every changed path is a planned path`, outside.length === 0, outside.join(", ") || `${changed.length} paths`);
}

function main(): void {
  const cases = [w01, w02, w03, w04, w05, w06, w07, w08, w09, w10, w11, p01, p02, p03, p04];
  for (const c of cases) c();
  console.log(
    `\n${checks - failures}/${checks} checks passed (${cases.length} cases). ` +
      (failures === 0 ? "BQI wording, labels and purity PASSED." : "BQI wording, labels and purity FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
