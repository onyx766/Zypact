#!/usr/bin/env tsx
/**
 * Buyer Question Intelligence Q1 — offline selection rules
 * (Q1_SCOPE_AND_TEST_PLAN.md section 6.2, cases S-01 to S-18).
 *
 * Pure function calls over invented, non-confidential fixtures. The
 * property and determinism cases use a fixed-seed generator defined
 * here; nothing reads a clock, the network or a database.
 */

import { findDuplicates } from "@/lib/buyer-questions/duplicates";
import { compareRank, recommend, type Recommendation } from "@/lib/buyer-questions/select";
import { sha256Utf8Hex } from "@/lib/buyer-questions/validate-source";
import { contentTokens } from "@/lib/buyer-questions/normalize";
import { duplicateKey } from "@/lib/buyer-questions/brand-match";
import type {
  BuyerStage,
  Candidate,
  CandidateSourceLink,
  EvidenceGrade,
  LinkRelation,
  QuestionKind,
  QuestionSource,
  RelevanceRatings,
  ResearchSet,
  SiteContext,
  SourceKind,
} from "@/lib/buyer-questions/types";

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

const SITE: SiteContext = {
  brandNames: [{ name: "Acme" }],
  productNames: [{ name: "Acme Pay" }],
  siteCopy: "Acme helps growing teams automate invoice approvals in minutes.",
};

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

function ratings(br: number, icp: number, ci: number, pr: number): RelevanceRatings {
  return {
    buyerRelevance: { value: br, reason: "buyer relevance reason" },
    icpFit: { value: icp, reason: "icp reason" },
    commercialIntent: { value: ci, reason: "intent reason" },
    productRelevance: { value: pr, reason: "product reason" },
  };
}

function link(candidateId: string, sourceId: string, relation: LinkRelation): CandidateSourceLink {
  return { candidateId, sourceId, relation, quotedSpan: null };
}

interface Spec {
  id: string;
  text: string;
  grade: EvidenceGrade;
  kind?: QuestionKind;
  stage?: BuyerStage;
  r?: RelevanceRatings;
  rank?: number;
}

/** Builds a research set where every observed candidate has a matching verbatim source and every adapted one a basis. */
function buildSet(specs: Spec[], site: SiteContext = SITE): ResearchSet {
  const sources: QuestionSource[] = [];
  const links: CandidateSourceLink[] = [];
  const candidates: Candidate[] = specs.map((s) => {
    if (s.grade === "observed") {
      sources.push(source(`src-${s.id}`, s.text));
      links.push(link(s.id, `src-${s.id}`, "verbatim"));
    } else if (s.grade === "adapted") {
      sources.push(source(`src-${s.id}`, "We keep struggling with this and nothing we tried fits our firm."));
      links.push(link(s.id, `src-${s.id}`, "paraphrase_basis"));
    }
    return {
      id: s.id,
      text: s.text,
      grade: s.grade,
      kind: s.kind ?? "unbranded",
      buyerStage: s.stage ?? "solution",
      adaptationNote: s.grade === "adapted" ? "reworded the poster's complaint as a question" : null,
      ratings: s.r ?? ratings(3, 3, 2, 3),
      curatorRank: s.rank ?? 1,
    };
  });
  return { siteContext: site, sources, candidates, links };
}

const Q = {
  a: "Which invoicing tool suits a two-person bookkeeping firm?",
  b: "How do small agencies chase late client payments?",
  c: "What do freelancers use to send invoices from a phone?",
  d: "When should a firm move invoicing out of spreadsheets?",
  e: "How are approval limits handled for invoices over budget?",
  f: "Which payroll add-ons do small clinics rely on?",
  brand: "Does Acme handle multi-currency invoices correctly?",
};

function explanation(rec: Recommendation, id: string) {
  return rec.candidates.find((c) => c.candidateId === id)!;
}

// ---------------------------------------------------------------- cases

function s01(): void {
  console.log("\nS-01 zero buyer sources: only hypotheses");
  const rec = recommend(buildSet([
    { id: "h1", text: Q.a, grade: "hypothesis" },
    { id: "h2", text: Q.b, grade: "hypothesis" },
    { id: "h3", text: Q.brand, grade: "hypothesis", kind: "branded_accuracy" },
  ]));
  check("S-01 nothing preselected", rec.preselected.length === 0);
  check("S-01 summary names the missing evidence", rec.summary.some((s) => s.includes("no supporting buyer-authored source")), rec.summary.join(" | "));
  check("S-01 every hypothesis explained", rec.candidates.every((c) => c.rule === "hypothesis_never_preselected"));
}

function s02(): void {
  console.log("\nS-02 research sets with 0 to 6 valid candidates");
  const texts = [Q.a, Q.b, Q.c, Q.d, Q.e, Q.f];
  for (let n = 0; n <= 6; n += 1) {
    const rec = recommend(buildSet(texts.slice(0, n).map((text, i) => ({ id: `c${i}`, text, grade: "observed" as const }))));
    check(`S-02 ${n} valid candidates: ${n} returned, none refused`, rec.candidates.length === n && rec.candidates.every((c) => c.refusals.length === 0));
  }
}

function s03(): void {
  console.log("\nS-03 low ratings at each grade");
  const lows: Array<[string, RelevanceRatings]> = [
    ["buyer relevance 1", ratings(1, 3, 3, 3)],
    ["ICP fit 1", ratings(3, 1, 3, 3)],
    ["product relevance 1", ratings(3, 3, 3, 1)],
    ["commercial intent 0", ratings(3, 3, 0, 3)],
  ];
  for (const grade of ["observed", "adapted", "hypothesis"] as EvidenceGrade[]) {
    for (const [label, r] of lows) {
      const rec = recommend(buildSet([{ id: "c1", text: Q.a, grade, r }]));
      check(`S-03 ${grade}, ${label}: never preselected`, rec.preselected.length === 0);
    }
  }
  const ok = recommend(buildSet([{ id: "c1", text: Q.a, grade: "observed", r: ratings(2, 2, 1, 2) }]));
  check("S-03 thresholds exactly met: preselected", ok.preselected.join() === "c1");
}

function s04(): void {
  console.log("\nS-04 relevance sum beats evidence grade");
  const rec = recommend(buildSet([
    { id: "obs", text: Q.a, grade: "observed", r: ratings(3, 2, 1, 3) },
    { id: "ada", text: Q.b, grade: "adapted", r: ratings(3, 3, 1, 3) },
  ]));
  check("S-04 adapted (10) ranks before observed (9)", rec.candidates[0].candidateId === "ada" && rec.preselected[0] === "ada");
}

function s05(): void {
  console.log("\nS-05 equal sums: observed first");
  const rec = recommend(buildSet([
    { id: "a-ada", text: Q.a, grade: "adapted", rank: 1 },
    { id: "z-obs", text: Q.b, grade: "observed", rank: 2 },
  ]));
  check("S-05 observed ranks first despite curator rank and id", rec.candidates[0].candidateId === "z-obs");
}

function s06(): void {
  console.log("\nS-06 ICP fit 0");
  const rec = recommend(buildSet([{ id: "c1", text: Q.a, grade: "observed", r: ratings(3, 0, 3, 3) }]));
  check("S-06 never preselected", rec.preselected.length === 0 && explanation(rec, "c1").rule === "rating_below_threshold");
}

function s07(): void {
  console.log("\nS-07 stage diversity with a different-stage candidate available");
  const rec = recommend(buildSet([
    { id: "c1", text: Q.a, grade: "observed", stage: "solution", rank: 1 },
    { id: "c2", text: Q.b, grade: "observed", stage: "solution", rank: 2 },
    { id: "c3", text: Q.c, grade: "observed", stage: "problem", rank: 3 },
  ]));
  check("S-07 first and different-stage candidate preselected", rec.preselected.join() === "c1,c3", rec.preselected.join());
  check("S-07 same-stage candidate explained", explanation(rec, "c2").rule === "stage_diversity");
  check("S-07 second slot rule", explanation(rec, "c3").rule === "preselected_unbranded_second_different_stage");
}

function s08(): void {
  console.log("\nS-08 no eligible different-stage candidate");
  const rec = recommend(buildSet([
    { id: "c1", text: Q.a, grade: "observed", stage: "solution", rank: 1 },
    { id: "c2", text: Q.b, grade: "observed", stage: "solution", rank: 2 },
    { id: "c3", text: Q.c, grade: "observed", stage: "problem", rank: 3, r: ratings(1, 3, 3, 3) },
  ]));
  check("S-08 same-stage candidate preselected", rec.preselected.join() === "c1,c2", rec.preselected.join());
  check("S-08 rule", explanation(rec, "c2").rule === "preselected_unbranded_second_same_stage");
}

function s09(): void {
  console.log("\nS-09 two eligible unbranded and one eligible branded");
  const rec = recommend(buildSet([
    { id: "u1", text: Q.a, grade: "observed", stage: "solution" },
    { id: "u2", text: Q.b, grade: "observed", stage: "problem" },
    { id: "b1", text: Q.brand, grade: "observed", kind: "branded_accuracy" },
  ]));
  check("S-09 exactly those three", [...rec.preselected].sort().join() === "b1,u1,u2" && rec.slots.branded.candidateId === "b1");
}

function s10(): void {
  console.log("\nS-10 ineligible branded");
  const rec = recommend(buildSet([
    { id: "u1", text: Q.a, grade: "observed", stage: "solution" },
    { id: "u2", text: Q.b, grade: "observed", stage: "problem" },
    { id: "b1", text: Q.brand, grade: "hypothesis", kind: "branded_accuracy" },
  ]));
  check("S-10 two preselected", [...rec.preselected].sort().join() === "u1,u2");
  check("S-10 branded slot empty and explained", rec.slots.branded.candidateId === null && rec.slots.branded.explanation.includes("b1"), rec.slots.branded.explanation);
}

function s11(): void {
  console.log("\nS-11 unresolved marketing flag on the top candidate");
  const flagged = "Which all-in-one invoicing tool suits a two-person firm?";
  const set = buildSet([
    { id: "top", text: flagged, grade: "observed", r: ratings(3, 3, 3, 3) },
    { id: "next", text: Q.b, grade: "observed", r: ratings(2, 2, 2, 2) },
  ]);
  const before = recommend(set);
  check("S-11 flagged top candidate not preselected", !before.preselected.includes("top") && explanation(before, "top").rule === "marketing_flag_unresolved");
  const reasonOnly = recommend({ ...set, candidates: set.candidates.map((c) => (c.id === "top" ? { ...c, marketingFlagResolution: { reason: "poster's own words", sourceId: "missing" } } : c)) });
  check("S-11 resolution without a linked buyer-authored source: still blocked", !reasonOnly.preselected.includes("top"));
  const resolved = recommend({ ...set, candidates: set.candidates.map((c) => (c.id === "top" ? { ...c, marketingFlagResolution: { reason: "the poster's own words", sourceId: "src-top" } } : c)) });
  check("S-11 resolved with reason and buyer-authored source: preselected", resolved.preselected[0] === "top");
  check("S-11 grade unchanged throughout", explanation(resolved, "top").grade === "observed" && explanation(before, "top").grade === "observed");
}

function s12(): void {
  console.log("\nS-12 provisional signals versus brand_alias_unresolved");
  const noisy = "Has @ledgerfan99 used an invoicing tool\nfor firms";
  const nfdSource = "Which café invoicing tool suits a small firm?";
  const nfcCandidate = "Which café invoicing tool suits a small firm?";
  const set = buildSet([
    { id: "noisy", text: noisy, grade: "observed" },
    { id: "short", text: "Acme tiers?", grade: "observed", kind: "branded_accuracy" },
  ]);
  const adapted: Candidate = {
    id: "nfc",
    text: nfcCandidate,
    grade: "adapted",
    kind: "unbranded",
    buyerStage: "problem",
    adaptationNote: "composed accent form",
    ratings: ratings(3, 3, 2, 3),
    curatorRank: 2,
  };
  const withNfc: ResearchSet = { ...set, sources: [...set.sources, source("nfd", nfdSource)], candidates: [...set.candidates, adapted], links: [...set.links, link("nfc", "nfd", "paraphrase_basis")] };
  const rec = recommend(withNfc);
  const e = explanation(rec, "noisy");
  const codes = e.signals.map((s) => s.code);
  check("S-12 C-19 signals present", ["not_phrased_as_question", "contains_line_break", "possible_personal_data"].every((c) => codes.includes(c as never)), codes.join(","));
  check("S-12 unicode_normalization_differs present on the adapted candidate", explanation(rec, "nfc").signals.some((s) => s.code === "unicode_normalization_differs"));
  check("S-12 length_unusual present on the short candidate", explanation(rec, "short").signals.some((s) => s.code === "length_unusual"));
  check("S-12 those signals never block: all three preselected", ["noisy", "nfc", "short"].every((id) => rec.preselected.includes(id)), rec.preselected.join());

  const aliasSite = (resolution: "accept" | "reject" | null): SiteContext => ({ brandNames: [{ name: "Day Spa", aliasResolution: resolution }], productNames: [], siteCopy: "" });
  const aliasSet = (resolution: "accept" | "reject" | null) =>
    buildSet([{ id: "al", text: "What are typical day rates for a bookkeeper?", grade: "observed" }], aliasSite(resolution));
  const unresolved = recommend(aliasSet(null));
  check("S-12 brand_alias_unresolved: not preselected", unresolved.preselected.length === 0 && explanation(unresolved, "al").rule === "brand_alias_unresolved");
  const rejected = recommend(aliasSet("reject"));
  check("S-12 after reject: eligible and preselected", rejected.preselected.join() === "al");
}

function s13(): void {
  console.log("\nS-13 exact duplicates");
  const set = buildSet([
    { id: "d1", text: "Is Acme Pay safe for client invoices?", grade: "observed", rank: 1 },
    { id: "d2", text: "is  acme pay SAFE for client invoices", grade: "observed", rank: 2 },
    { id: "d3", text: "Is Acme, safe for client invoices?!", grade: "observed", rank: 3 },
  ]);
  const site: SiteContext = SITE;
  check("S-13 keys identical", new Set(set.candidates.map((c) => duplicateKey(c.text, site))).size === 1, duplicateKey(set.candidates[2].text, site));
  const branded: ResearchSet = { ...set, candidates: set.candidates.map((c) => ({ ...c, kind: "branded_accuracy" as const })) };
  const rec = recommend(branded);
  const rep = explanation(rec, "d1");
  check("S-13 merged into one representative", rep.mergedFrom.join() === "d2,d3" && explanation(rec, "d2").mergedInto === "d1" && explanation(rec, "d3").mergedInto === "d1");
  check("S-13 every source link kept", ["src-d1", "src-d2", "src-d3"].every((s) => rep.links.some((l) => l.sourceId === s)));
  check("S-13 only the representative preselected", rec.preselected.join() === "d1");
}

function s14(): void {
  console.log("\nS-14 near duplicates at 0.79, 0.80 and 1.00");
  const words = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + i)}`);
  const shared15 = words(15, "zq");
  const below1 = [...shared15, "xa", "xb"].join(" ") + "?";
  const below2 = [...shared15, "ya", "yb"].join(" ") + "?";
  const at1 = "invoices approvals payroll ledgers exports?";
  const at2 = "invoices approvals payroll ledgers?";
  const one1 = "What tool handles invoices approvals payroll?";
  const one2 = "Which tool handles the invoices approvals payroll?";
  const ratio = (a: string, b: string) => {
    const ta = contentTokens(duplicateKey(a, SITE));
    const tb = contentTokens(duplicateKey(b, SITE));
    const inter = [...ta].filter((t) => tb.has(t)).length;
    return [inter, ta.size + tb.size - inter];
  };
  check("S-14 fixture 15/19", ratio(below1, below2).join("/") === "15/19");
  check("S-14 fixture 4/5", ratio(at1, at2).join("/") === "4/5");
  check("S-14 fixture 1.00", (() => { const [i, u] = ratio(one1, one2); return i === u; })());
  const group = (a: string, b: string) => findDuplicates(buildSet([{ id: "p", text: a, grade: "observed" }, { id: "q", text: b, grade: "observed" }]).candidates, SITE);
  check("S-14 0.79 not grouped", group(below1, below2).nearGroups.length === 0);
  check("S-14 0.80 grouped", group(at1, at2).nearGroups.length === 1);
  check("S-14 1.00 grouped", group(one1, one2).nearGroups.length === 1);
  for (const [label, a, b] of [["0.80", at1, at2], ["1.00", one1, one2]]) {
    const rec = recommend(buildSet([
      { id: "p", text: a, grade: "observed", stage: "solution" },
      { id: "q", text: b, grade: "observed", stage: "problem" },
    ]));
    check(`S-14 ${label}: at most one preselected`, rec.preselected.length === 1 && explanation(rec, "q").rule === "near_duplicate");
  }
  const recBelow = recommend(buildSet([
    { id: "p", text: below1, grade: "observed", stage: "solution" },
    { id: "q", text: below2, grade: "observed", stage: "problem" },
  ]));
  check("S-14 0.79: both preselected", recBelow.preselected.length === 2);
}

function s15(): void {
  console.log("\nS-15 every candidate explained");
  const rec = recommend(buildSet([
    { id: "u1", text: Q.a, grade: "observed" },
    { id: "u2", text: Q.b, grade: "adapted", stage: "problem" },
    { id: "u3", text: Q.c, grade: "observed" },
    { id: "h1", text: Q.d, grade: "hypothesis" },
    { id: "lo", text: Q.e, grade: "observed", r: ratings(1, 1, 0, 1) },
    { id: "b1", text: Q.brand, grade: "observed", kind: "branded_accuracy" },
  ]));
  for (const e of rec.candidates) {
    const complete =
      e.grade !== undefined &&
      (e.grade === "hypothesis" ? e.verification === null : e.verification !== null) &&
      (["buyerRelevance", "icpFit", "commercialIntent", "productRelevance"] as const).every((k) => Number.isInteger(e.ratings[k].value) && e.ratings[k].reason.length > 0) &&
      Array.isArray(e.signals) &&
      typeof e.rule === "string" &&
      e.detail.length > 0;
    check(`S-15 ${e.candidateId}: grade, verification, ratings, signals, rule (${e.rule})`, complete);
  }
}

// ------------------------------------------------- seeded generator (S-16..S-18)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ["invoices", "payroll", "approvals", "ledger", "exports", "clinic", "agency", "budget", "receipts", "tax", "clients", "firm"];
const STAGES: BuyerStage[] = ["problem", "solution", "vendor_evaluation", "purchase"];
const GRADES: EvidenceGrade[] = ["observed", "adapted", "hypothesis"];

/** Mostly 2 or 3, so that many generated candidates are eligible; 0 and 1 still occur. */
function rating(rand: () => number): number {
  const x = rand();
  return x < 0.1 ? 0 : x < 0.2 ? 1 : x < 0.55 ? 2 : 3;
}

function generateSet(rand: () => number): ResearchSet {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const n = Math.floor(rand() * 7);
  const specs: Spec[] = [];
  const pool: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const branded = rand() < 0.3;
    let text: string;
    if (pool.length > 0 && rand() < 0.25) {
      const base = pick(pool);
      text = rand() < 0.5 ? base.toUpperCase() : base.replace("?", " now?");
    } else {
      const k = 3 + Math.floor(rand() * 4);
      text = `Which tool ${Array.from({ length: k }, () => pick(VOCAB)).join(" ")}${branded ? " with Acme" : ""}?`;
      if (rand() < 0.15) text = text.replace("Which tool", "Which seamless tool");
    }
    pool.push(text);
    specs.push({
      id: `g${String(i).padStart(2, "0")}`,
      text,
      grade: pick(GRADES),
      kind: branded ? "branded_accuracy" : "unbranded",
      stage: pick(STAGES),
      r: ratings(rating(rand), rating(rand), rating(rand), rating(rand)),
      rank: 1 + Math.floor(rand() * 6),
    });
  }
  return buildSet(specs);
}

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SETS = 2000;
const SHUFFLES = 20;

function s16(): void {
  console.log(`\nS-16 property test over ${SETS} seeded research sets`);
  const rand = mulberry32(0x5eed0001);
  let violations = 0;
  let preselectedTotal = 0;
  let nearPairsSeen = 0;
  for (let s = 0; s < SETS; s += 1) {
    const set = generateSet(rand);
    const rec = recommend(set);
    const byId = new Map(set.candidates.map((c) => [c.id, c]));
    const chosen = rec.preselected.map((id) => byId.get(id)!);
    preselectedTotal += chosen.length;
    const near = findDuplicates(set.candidates, SITE);
    nearPairsSeen += near.nearGroups.length;
    const ok =
      chosen.every((c) => c.grade !== "hypothesis") &&
      chosen.filter((c) => c.kind === "unbranded").length <= 2 &&
      chosen.filter((c) => c.kind === "branded_accuracy").length <= 1 &&
      chosen.length <= 3 &&
      rec.preselected.every((id) => rec.candidates.find((e) => e.candidateId === id)!.eligible) &&
      chosen.every((a, i) => chosen.every((b, j) => i === j || near.nearGroupOf.get(a.id) === undefined || near.nearGroupOf.get(a.id) !== near.nearGroupOf.get(b.id)));
    if (!ok) violations += 1;
  }
  check(`S-16 no invariant violated in ${SETS} sets`, violations === 0, `${preselectedTotal} preselections, ${nearPairsSeen} near-duplicate groups exercised`);
  check("S-16 generator exercises preselection and near duplicates", preselectedTotal > 500 && nearPairsSeen > 50);
}

function s17(): void {
  console.log(`\nS-17 determinism: each set shuffled ${SHUFFLES} ways`);
  const rand = mulberry32(0x5eed0001);
  const shuffleRand = mulberry32(0x5eed0002);
  let mismatches = 0;
  for (let s = 0; s < SETS; s += 1) {
    const set = generateSet(rand);
    const reference = JSON.stringify(recommend(set));
    for (let k = 0; k < SHUFFLES; k += 1) {
      const shuffled: ResearchSet = {
        siteContext: set.siteContext,
        sources: shuffle(set.sources, shuffleRand),
        candidates: shuffle(set.candidates, shuffleRand),
        links: shuffle(set.links, shuffleRand),
      };
      if (JSON.stringify(recommend(shuffled)) !== reference) mismatches += 1;
    }
  }
  check(`S-17 identical output for ${SETS * SHUFFLES} shuffled orders`, mismatches === 0, `${mismatches} mismatches`);
  check("S-17 ranking comparator is a total order on ids", compareRank(
    { id: "a", text: "", grade: "observed", kind: "unbranded", buyerStage: "problem", ratings: ratings(1, 1, 1, 1), curatorRank: 1 },
    { id: "b", text: "", grade: "observed", kind: "unbranded", buyerStage: "problem", ratings: ratings(1, 1, 1, 1), curatorRank: 1 }
  ) < 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

function s18(): void {
  console.log("\nS-18 no mutation of deep-frozen inputs");
  const rand = mulberry32(0x5eed0003);
  let thrown = 0;
  let changed = 0;
  let foreign = 0;
  for (let s = 0; s < 200; s += 1) {
    const set = generateSet(rand);
    const snapshot = JSON.stringify(set);
    deepFreeze(set);
    try {
      const rec = recommend(set);
      const candidateIds = new Set(set.candidates.map((c) => c.id));
      const sourceIds = new Set(set.sources.map((x) => x.id));
      for (const e of rec.candidates) {
        if (!candidateIds.has(e.candidateId)) foreign += 1;
        for (const l of e.links) if (!sourceIds.has(l.sourceId) || !candidateIds.has(l.candidateId)) foreign += 1;
      }
      for (const id of rec.preselected) if (!candidateIds.has(id)) foreign += 1;
    } catch {
      thrown += 1;
    }
    if (JSON.stringify(set) !== snapshot) changed += 1;
  }
  check("S-18 no exception on frozen inputs", thrown === 0);
  check("S-18 inputs unchanged", changed === 0);
  check("S-18 no candidate or source absent from the input", foreign === 0);
}

function main(): void {
  const cases = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s15, s16, s17, s18];
  for (const c of cases) c();
  console.log(
    `\n${checks - failures}/${checks} checks passed (${cases.length} cases). ` +
      (failures === 0 ? "BQI selection rules PASSED." : "BQI selection rules FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
