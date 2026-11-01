#!/usr/bin/env tsx
/**
 * Buyer Question Intelligence Q1 — offline candidate and source rules
 * (Q1_SCOPE_AND_TEST_PLAN.md section 6.1, cases C-01 to C-28).
 *
 * Pure function calls over invented, non-confidential fixtures. No
 * database, network, provider, clock or filesystem access, except the
 * C-27 static read of lib/buyer-questions/ inside this repository.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brandPresence, findNameMatches } from "@/lib/buyer-questions/brand-match";
import { gradeLabel } from "@/lib/buyer-questions/labels";
import { marketingSignal } from "@/lib/buyer-questions/marketing-signal";
import { recommend } from "@/lib/buyer-questions/select";
import { validateCandidate, validateResearchSet } from "@/lib/buyer-questions/validate-candidate";
import { sha256Utf8Hex, validateSource } from "@/lib/buyer-questions/validate-source";
import type {
  AliasResolution,
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
  productNames: [{ name: "Ledgerly" }],
  siteCopy: "Acme helps growing teams automate invoice approvals in minutes. Ledgerly keeps every ledger in sync.",
};

function source(id: string, kind: SourceKind, excerpt: string, overrides: Partial<QuestionSource> = {}): QuestionSource {
  const base: QuestionSource =
    kind === "customer_material"
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
  return { ...base, ...overrides };
}

function ratings(br = 3, icp = 3, ci = 2, pr = 3): RelevanceRatings {
  return {
    buyerRelevance: { value: br, reason: "matches the buyer's stated problem" },
    icpFit: { value: icp, reason: "core segment" },
    commercialIntent: { value: ci, reason: "comparing tools" },
    productRelevance: { value: pr, reason: "central use case" },
  };
}

function candidate(
  id: string,
  text: string,
  grade: EvidenceGrade,
  overrides: Partial<Candidate> & { kind?: QuestionKind; buyerStage?: BuyerStage } = {}
): Candidate {
  return {
    id,
    text,
    grade,
    kind: "unbranded",
    buyerStage: "solution",
    adaptationNote: grade === "adapted" ? "shortened the poster's question" : null,
    ratings: ratings(),
    curatorRank: 1,
    ...overrides,
  };
}

function link(candidateId: string, sourceId: string, relation: LinkRelation, quotedSpan?: string): CandidateSourceLink {
  return { candidateId, sourceId, relation, quotedSpan: quotedSpan ?? null };
}

/**
 * Fixture convenience: when a test does not say otherwise (primarySourceId
 * undefined), the candidate's first supporting link names its primary
 * source explicitly, as a curator would. `null` means "not identified".
 */
function withPrimary(c: Candidate, links: CandidateSourceLink[]): Candidate {
  if (c.primarySourceId !== undefined) return c;
  const relation = c.grade === "observed" ? "verbatim" : c.grade === "adapted" ? "paraphrase_basis" : null;
  const first = links.find((l) => l.candidateId === c.id && l.relation === relation);
  return { ...c, primarySourceId: first ? first.sourceId : null };
}

function run(c0: Candidate, links: CandidateSourceLink[], sources: QuestionSource[], site: SiteContext = SITE) {
  const c = withPrimary(c0, links);
  const set: ResearchSet = { siteContext: site, sources, candidates: [c], links };
  const v = validateResearchSet(set).candidates.get(c.id)!;
  return { v, codes: v.refusals.map((r) => r.code), signals: v.signals.map((s) => s.code) };
}

const SRC_TEXT = "Which invoicing tool works best for a small accounting firm?";

// ---------------------------------------------------------------- cases

function c01(): void {
  console.log("\nC-01 observed linked only to a problem-describing review");
  const review = source("r1", "public_review", "Our team wastes hours reconciling invoices every month and it is painful.");
  const text = "How can we stop wasting hours reconciling invoices?";
  const a = run(candidate("c1", text, "observed"), [link("c1", "r1", "verbatim")], [review]);
  check("C-01 verbatim link to a problem review: refused", a.codes.includes("observed_text_does_not_match_source"), a.codes.join(","));
  const b = run(candidate("c1", text, "observed"), [link("c1", "r1", "paraphrase_basis")], [review]);
  check("C-01 basis link only: refused for missing verbatim source", b.codes.includes("observed_requires_verbatim_buyer_source"));
}

function c02(): void {
  console.log("\nC-02 observed linked only to seller-authored text");
  const site = source("s1", "site_copy", SRC_TEXT);
  const a = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "s1", "verbatim")], [site]);
  check("C-02 site_copy as verbatim: refused", a.codes.includes("seller_source_only_as_context") && a.codes.includes("observed_requires_verbatim_buyer_source"), a.codes.join(","));
  const vendor = source("p1", "public_analyst", SRC_TEXT, { buyerAuthored: false });
  const b = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "p1", "verbatim")], [vendor]);
  check("C-02 seller-authored public source as verbatim: refused", b.codes.includes("seller_source_only_as_context") && b.codes.includes("observed_requires_verbatim_buyer_source"), b.codes.join(","));
}

function c03(): void {
  console.log("\nC-03 observed text differing by case, inner punctuation or a word");
  const src = source("p1", "public_community", SRC_TEXT);
  const variants = [
    ["case", "which invoicing tool works best for a small accounting firm?"],
    ["inner punctuation", "Which invoicing tool works best, for a small accounting firm?"],
    ["one word", "Which invoicing tool works best for a small law firm?"],
  ];
  for (const [label, text] of variants) {
    const obs = run(candidate("c1", text, "observed"), [link("c1", "p1", "verbatim")], [src]);
    check(`C-03 ${label}: refused as observed`, obs.codes.includes("observed_text_does_not_match_source"));
    const adapted = run(candidate("c1", text, "adapted"), [link("c1", "p1", "paraphrase_basis")], [src]);
    check(`C-03 ${label}: accepted as adapted with note and basis`, adapted.codes.length === 0 && adapted.v.verification === "public_verifiable", adapted.codes.join(","));
  }
}

function c04(): void {
  console.log("\nC-04 whitespace, terminal punctuation, NFC/NFD and fullwidth question mark");
  const src = source("p1", "public_community", SRC_TEXT);
  const accepted = [
    ["surrounding whitespace", `  ${SRC_TEXT}  `],
    ["internal whitespace runs", "Which invoicing   tool works\tbest for a small accounting firm?"],
    ["no-break space", "Which invoicing tool works best for a small accounting firm?"],
    ["trailing ASCII run", "Which invoicing tool works best for a small accounting firm?!.. "],
    ["no trailing mark", "Which invoicing tool works best for a small accounting firm"],
  ];
  for (const [label, text] of accepted) {
    const r = run(candidate("c1", text, "observed"), [link("c1", "p1", "verbatim")], [src]);
    check(`C-04 ${label}: accepted as observed`, r.codes.length === 0 && r.v.verification === "public_verifiable", r.codes.join(","));
  }
  const composed = "Which café booking app handles group orders?";
  const decomposed = "Which café booking app handles group orders?";
  const nfcSrc = source("p2", "public_community", composed);
  const nfd = run(candidate("c1", decomposed, "observed"), [link("c1", "p2", "verbatim")], [nfcSrc]);
  check("C-04 NFD candidate vs NFC source: not observed", nfd.codes.includes("observed_text_does_not_match_source"));
  check("C-04 NFD vs NFC: unicode_normalization_differs raised", nfd.signals.includes("unicode_normalization_differs"));
  const full = run(candidate("c1", "Which invoicing tool works best for a small accounting firm？", "observed"), [link("c1", "p1", "verbatim")], [src]);
  check("C-04 fullwidth question mark: not observed", full.codes.includes("observed_text_does_not_match_source"));
  check("C-04 fullwidth: no unicode_normalization_differs (NFC keeps U+FF1F)", !full.signals.includes("unicode_normalization_differs"));
}

function c05(): void {
  console.log("\nC-05 adapted without basis link or note");
  const src = source("p1", "public_review", "Reconciling invoices takes our firm forever.");
  const text = "How can a small firm reconcile invoices faster?";
  const noBasis = run(candidate("c1", text, "adapted"), [link("c1", "p1", "context")], [src]);
  check("C-05 no paraphrase_basis link: refused", noBasis.codes.includes("adapted_requires_paraphrase_basis"));
  const noNote = run(candidate("c1", text, "adapted", { adaptationNote: "   " }), [link("c1", "p1", "paraphrase_basis")], [src]);
  check("C-05 blank adaptation note: refused", noNote.codes.includes("adapted_requires_note"));
  const nullNote = run(candidate("c1", text, "adapted", { adaptationNote: null }), [link("c1", "p1", "paraphrase_basis")], [src]);
  check("C-05 missing adaptation note: refused", nullNote.codes.includes("adapted_requires_note"));
}

function c06(): void {
  console.log("\nC-06 the same question from customer material and from a public source");
  const cust = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "m1", "verbatim")], [source("m1", "customer_material", SRC_TEXT)]);
  const pub = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "p1", "verbatim")], [source("p1", "public_community", SRC_TEXT)]);
  check("C-06 customer material: customer_provided", cust.codes.length === 0 && cust.v.verification === "customer_provided");
  check("C-06 public source: public_verifiable", pub.codes.length === 0 && pub.v.verification === "public_verifiable");
  check("C-06 labels", gradeLabel("observed", "customer_provided") === "Observed — customer-provided" && gradeLabel("observed", "public_verifiable") === "Observed — verified source");
  check("C-06 labels differ", gradeLabel("observed", "customer_provided") !== gradeLabel("observed", "public_verifiable"));
}

function c07(): void {
  console.log("\nC-07 customer statement with no documented material");
  const text = "Our buyers always want to know about invoice approval limits?";
  const obs = run(candidate("c1", text, "observed"), [], []);
  check("C-07 observed with no material: refused", obs.codes.includes("observed_requires_verbatim_buyer_source"));
  const hyp = run(candidate("c1", text, "hypothesis"), [], []);
  check("C-07 accepted only as hypothesis", hyp.codes.length === 0 && hyp.v.verification === null, hyp.codes.join(","));
}

function c08(): void {
  console.log("\nC-08 missing attestation or personal-data confirmation");
  const noAttest = validateSource(source("m1", "customer_material", SRC_TEXT, { customerAttestedAt: null }));
  check("C-08 customer material without attestation: refused", noAttest.refusals.some((r) => r.code === "customer_material_missing_attestation"));
  for (const kind of ["customer_material", "public_community", "public_review", "public_analyst", "site_copy"] as SourceKind[]) {
    const r = validateSource(source("x", kind, SRC_TEXT, { personalDataRemoved: false }));
    check(`C-08 ${kind} without personal_data_removed: refused`, r.refusals.some((f) => f.code === "personal_data_confirmation_missing"));
  }
  const linked = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "m1", "verbatim")], [source("m1", "customer_material", SRC_TEXT, { customerAttestedAt: null })]);
  check("C-08 candidate citing the refused source: refused", linked.codes.includes("linked_source_refused"));
}

function excerptCheck(label: string, excerpt: string, accepted: boolean): void {
  const r = validateSource(source("p1", "public_community", excerpt));
  const codes = r.refusals.map((f) => f.code);
  check(`${label}: ${accepted ? "accepted" : "refused"}`, accepted ? codes.length === 0 : codes.some((c) => c === "excerpt_empty" || c === "excerpt_too_long"), codes.join(","));
}

function c09(): void {
  console.log("\nC-09 excerpt lengths 0, 1, 300, 301 code points");
  excerptCheck("C-09 0", "", false);
  excerptCheck("C-09 1", "a", true);
  excerptCheck("C-09 300", "a".repeat(300), true);
  excerptCheck("C-09 301", "a".repeat(301), false);
}

function c10(): void {
  console.log("\nC-10 astral-plane characters");
  const astral = "\u{1D49C}";
  check("C-10 fixture: one code point, two UTF-16 units", [...astral].length === 1 && astral.length === 2);
  excerptCheck("C-10 300 astral (600 UTF-16 units)", astral.repeat(300), true);
  excerptCheck("C-10 301 astral", astral.repeat(301), false);
}

function c11(): void {
  console.log("\nC-11 combining sequences, counted as stored");
  const pair = "é";
  excerptCheck("C-11 150 x e+U+0301 (300 code points)", pair.repeat(150), true);
  excerptCheck("C-11 151 x e+U+0301 (302 code points)", pair.repeat(151), false);
  excerptCheck("C-11 NFC-composed 151 x U+00E9 (151 code points)", pair.repeat(151).normalize("NFC"), true);
}

function c12(): void {
  console.log("\nC-12 ZWJ sequences, CJK and right-to-left text");
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  check("C-12 ZWJ family is five code points", [...family].length === 5);
  excerptCheck("C-12 60 ZWJ families (300 code points)", family.repeat(60), true);
  excerptCheck("C-12 60 ZWJ families + 1 (301)", family.repeat(60) + "a", false);
  excerptCheck("C-12 CJK 300", "問".repeat(300), true);
  excerptCheck("C-12 CJK 301", "問".repeat(301), false);
  excerptCheck("C-12 Hebrew 300", "ש".repeat(300), true);
  excerptCheck("C-12 Hebrew 301", "ש".repeat(301), false);
  excerptCheck("C-12 Arabic 300", "س".repeat(300), true);
  excerptCheck("C-12 Arabic 301", "س".repeat(301), false);
}

function c13(): void {
  console.log("\nC-13 missing URL, retrieval date, reference or date received");
  const codes = (s: QuestionSource) => validateSource(s).refusals.map((r) => r.code);
  check("C-13 public without URL", codes(source("p", "public_review", SRC_TEXT, { url: null })).includes("public_source_missing_url"));
  check("C-13 public without retrieval date", codes(source("p", "public_review", SRC_TEXT, { retrievedAt: "" })).includes("public_source_missing_retrieved_at"));
  check("C-13 customer material without reference", codes(source("m", "customer_material", SRC_TEXT, { customerReference: " " })).includes("customer_material_missing_reference"));
  check("C-13 customer material without date received", codes(source("m", "customer_material", SRC_TEXT, { retrievedAt: null })).includes("customer_material_missing_date_received"));
  check("C-13 complete sources accepted", codes(source("p", "public_review", SRC_TEXT)).length === 0 && codes(source("m", "customer_material", SRC_TEXT)).length === 0);
}

function c14(): void {
  console.log("\nC-14 excerpt hash over UTF-8 bytes");
  const multi = "Wie viel kostet die Größe? 価格は？";
  const good = validateSource(source("p", "public_review", multi));
  check("C-14 multi-byte excerpt with matching hash: accepted", good.refusals.length === 0);
  const wrong = validateSource(source("p", "public_review", multi, { excerptSha256: sha256Utf8Hex(multi + " ") }));
  check("C-14 wrong hash: refused", wrong.refusals.some((r) => r.code === "excerpt_hash_mismatch"));
  const latin1 = validateSource(
    source("p", "public_review", multi, { excerptSha256: sha256Utf8Hex(Buffer.from(multi, "latin1").toString("utf8")) })
  );
  check("C-14 hash of a different byte encoding: refused", latin1.refusals.some((r) => r.code === "excerpt_hash_mismatch"));
  const nfd = validateSource(source("p", "public_review", "café?", { excerptSha256: sha256Utf8Hex("café?") }));
  check("C-14 hash of the NFD form for an NFC excerpt: refused", nfd.refusals.some((r) => r.code === "excerpt_hash_mismatch"));
}

function c15(): void {
  console.log("\nC-15 site_copy as buyer-authored or as evidence");
  const marked = validateSource(source("s1", "site_copy", SRC_TEXT, { buyerAuthored: true }));
  check("C-15 site_copy marked buyer-authored: refused", marked.refusals.some((r) => r.code === "site_copy_cannot_be_buyer_authored"));
  const basis = source("p1", "public_review", "Reconciling invoices takes our firm forever.");
  const site = source("s1", "site_copy", "Acme reconciles invoices automatically.");
  const text = "How can a small firm reconcile invoices faster?";
  for (const relation of ["verbatim", "paraphrase_basis"] as LinkRelation[]) {
    const r = run(candidate("c1", text, "adapted"), [link("c1", "p1", "paraphrase_basis"), link("c1", "s1", relation)], [basis, site]);
    check(`C-15 site_copy linked as ${relation}: refused`, r.codes.includes("seller_source_only_as_context"));
  }
  const ctx = run(candidate("c1", text, "adapted"), [link("c1", "p1", "paraphrase_basis"), link("c1", "s1", "context")], [basis, site]);
  check("C-15 site_copy as context: accepted", ctx.codes.length === 0, ctx.codes.join(","));
}

function c16(): void {
  console.log("\nC-16 unbranded candidate containing the brand or a product name");
  for (const text of ["Is ACME good for invoices?", "Is Ácme good for invoices?", "Does ledgerly integrate with banks?", "Does LEDGERLY integrate with banks?"]) {
    const r = run(candidate("c1", text, "hypothesis"), [], []);
    check(`C-16 "${text}": refused as unbranded`, r.codes.includes("unbranded_contains_brand"));
  }
  const clean = run(candidate("c1", "Which invoicing tool suits a small firm?", "hypothesis"), [], []);
  check("C-16 no brand: accepted", clean.codes.length === 0);
}

function c17(): void {
  console.log("\nC-17 branded-accuracy candidate without the brand");
  const r = run(candidate("c1", "Does Ledgerly support multi-currency invoices?", "hypothesis", { kind: "branded_accuracy" }), [], []);
  check("C-17 product name only, no brand: refused", r.codes.includes("branded_missing_brand"));
  const ok = run(candidate("c1", "Does Acme support multi-currency invoices?", "hypothesis", { kind: "branded_accuracy" }), [], []);
  check("C-17 with the brand: accepted", ok.codes.length === 0);
}

function c18(): void {
  console.log("\nC-18 invalid relevance ratings");
  const bad: Array<[string, RelevanceRatings]> = [
    ["4", { ...ratings(), icpFit: { value: 4, reason: "x" } }],
    ["-1", { ...ratings(), buyerRelevance: { value: -1, reason: "x" } }],
    ["1.5", { ...ratings(), commercialIntent: { value: 1.5, reason: "x" } }],
    ["NaN", { ...ratings(), productRelevance: { value: Number.NaN, reason: "x" } }],
    ["empty reason", { ...ratings(), icpFit: { value: 2, reason: "  " } }],
  ];
  for (const [label, r] of bad) {
    const res = run(candidate("c1", "Which invoicing tool suits a small firm?", "hypothesis", { ratings: r }), [], []);
    check(`C-18 rating ${label}: refused`, res.codes.includes("rating_invalid"));
  }
  const boundary = run(candidate("c1", "Which invoicing tool suits a small firm?", "hypothesis", { ratings: ratings(0, 3, 0, 3) }), [], []);
  check("C-18 0 and 3: accepted", boundary.codes.length === 0);
}

function c19(): void {
  console.log("\nC-19 provisional signals never refuse or change the grade");
  const long = `How ${"a".repeat(246)}?`;
  check("C-19 fixture lengths", [..."Pricing tiers?"].length === 14 && [...long].length === 251);
  const fixtures: Array<[string, string]> = [
    ["length_unusual", "Pricing tiers?"],
    ["length_unusual", long],
    ["not_phrased_as_question", "Which invoicing tool suits small firms"],
    ["contains_line_break", "Which invoicing tool\nsuits small firms?"],
    ["possible_personal_data", "Can someone at jane.doe@example.com explain invoice limits?"],
    ["possible_personal_data", "Has @ledgerfan99 tried any invoicing tool for firms?"],
    ["possible_personal_data", "I called +1 555 010 0199, which invoicing tool is best?"],
    ["possible_personal_data", "Is https://example.org/invoices a good invoicing tool?"],
  ];
  for (const [signal, text] of fixtures) {
    const r = run(candidate("c1", text, "observed"), [link("c1", "p1", "verbatim")], [source("p1", "public_community", text)]);
    check(`C-19 ${signal} raised for ${JSON.stringify(text.slice(0, 30))}`, r.signals.includes(signal as never));
    check(`C-19 ${signal}: not refused, still observed and verified`, r.codes.length === 0 && r.v.verification === "public_verifiable", r.codes.join(","));
    const s = validateSource(source("p1", "public_community", text));
    if (signal === "possible_personal_data") {
      check("C-19 same pattern in an excerpt: signal, no refusal", s.signals.some((x) => x.code === "possible_personal_data") && s.refusals.length === 0);
    }
  }
}

function c20(): void {
  console.log("\nC-20 marketing-language signal");
  const seller = [
    ["lexicon", "What is the best AI-powered all-in-one platform to streamline workflows?"],
    ["lexicon", "Which tool offers a seamless onboarding experience for finance teams?"],
    ["feature_list", "Which tool offers invoicing, payroll, expense tracking and reporting?"],
    ["site_copy_overlap", "Can I automate invoice approvals in minutes?"],
  ];
  for (const [trigger, text] of seller) {
    const m = marketingSignal(text, SITE);
    check(`C-20 flagged (${trigger}): ${text}`, m.flagged && m.triggers.includes(trigger as never), m.triggers.join(","));
    const r = run(candidate("c1", text, "observed"), [link("c1", "p1", "verbatim")], [source("p1", "public_community", text)]);
    check(`C-20 grade unchanged, not refused (${trigger})`, r.codes.length === 0 && r.v.verification === "public_verifiable" && r.signals.includes("marketing_language"));
  }
  const buyer = [
    "How do I stop chasing clients for late invoice payments?",
    "Is there an invoicing tool that works for a two-person bookkeeping firm?",
    "What do small agencies use to send invoices from their phone?",
    "Should I switch from spreadsheets to an invoicing app, and when?",
    "My accountant and I disagree on approval limits, who is right?",
  ];
  for (const text of buyer) {
    const m = marketingSignal(text, SITE);
    check(`C-20 buyer voice not flagged: ${text}`, !m.flagged, m.triggers.join(","));
  }
}

function c21(): void {
  console.log("\nC-21 a seventh candidate");
  const make = (n: number): ResearchSet => ({
    siteContext: SITE,
    sources: [],
    links: [],
    candidates: Array.from({ length: n }, (_, i) => candidate(`c${i}`, `Which invoicing tool number ${i} fits us?`, "hypothesis")),
  });
  check("C-21 six candidates: accepted", validateResearchSet(make(6)).refusals.length === 0);
  check("C-21 seven candidates: too_many_candidates", validateResearchSet(make(7)).refusals.some((r) => r.code === "too_many_candidates"));
}

function matched(text: string, site: SiteContext): boolean {
  return findNameMatches(text, site).matches.length > 0;
}

function brandSite(brand: string, resolution?: AliasResolution | null, products: string[] = []): SiteContext {
  return {
    brandNames: [{ name: brand, aliasResolution: resolution }],
    productNames: products.map((name) => ({ name })),
    siteCopy: "",
  };
}

function c22(): void {
  console.log("\nC-22 brand substring false positives");
  const site = brandSite("Acme");
  for (const word of ["Acmeton", "pacmen", "acmes", "Acme2"]) {
    check(`C-22 "${word}" not matched`, !matched(`Is ${word} any good?`, site));
  }
  for (const word of ["Acme's", "acme.com", "(Acme)"]) {
    check(`C-22 "${word}" matched`, matched(`Is ${word} pricing fair?`, site));
  }
}

function c23(): void {
  console.log("\nC-23 short brand names");
  for (const brand of ["Bo", "X"]) {
    const site = brandSite(brand);
    for (const word of ["both", "bob", "box", "xray"]) {
      check(`C-23 brand "${brand}" not matched inside "${word}"`, !matched(`Is ${word} useful here?`, site));
    }
  }
  const bo = findNameMatches("Is bo useful here?", brandSite("Bo"));
  check("C-23 \"bo\" as a word matched, ambiguous", bo.matches.length > 0 && bo.signals.some((s) => s.code === "brand_match_ambiguous" && s.name === "Bo"));
  const x = findNameMatches("Does X support invoices?", brandSite("X"));
  check("C-23 \"X\" as a word matched, ambiguous", x.matches.length > 0 && x.signals.some((s) => s.code === "brand_match_ambiguous" && s.name === "X"));
  const zelto = findNameMatches("Does Zelto support invoices?", brandSite("Zelto"));
  check("C-23 five-letter brand matched, not ambiguous", zelto.matches.length > 0 && !zelto.signals.some((s) => s.code === "brand_match_ambiguous"));
}

function c24(): void {
  console.log("\nC-24 product names");
  const site: SiteContext = { brandNames: [{ name: "Zelto" }], productNames: [{ name: "Acme Pay" }], siteCopy: "" };
  for (const phrase of ["acme pay", "Acme-Pay", "ACME  PAY"]) {
    check(`C-24 "${phrase}" matched`, matched(`Is ${phrase} safe?`, site));
  }
  for (const phrase of ["Acme Payroll", "pay acme", "acme and pay"]) {
    check(`C-24 "${phrase}" not matched`, !matched(`Is ${phrase} safe?`, site));
  }
}

function c25(): void {
  console.log("\nC-25 Unicode variants");
  const cafe = brandSite("Café");
  for (const [label, word] of [
    ["composed", "Café"],
    ["decomposed", "Café"],
    ["unaccented", "Cafe"],
    ["upper case", "CAFÉ"],
    ["lower case", "café"],
  ]) {
    check(`C-25 "Café" matches ${label}`, matched(`Is ${word} open late?`, cafe));
  }
  check("C-25 brand decomposed matches question composed", matched("Is Café open late?", brandSite("Café")));
  check("C-25 fullwidth question word matches \"Acme\"", matched("Is Ａｃｍｅ safe?", brandSite("Acme")));
  check("C-25 fullwidth brand matches \"acme\"", matched("Is acme safe?", brandSite("Ａｃｍｅ")));
  check("C-25 Turkish \"İzmir Tours\" matches \"izmir tours\"", matched("Are izmir tours worth it?", brandSite("İzmir Tours")));
  check("C-25 \"straße\" does not match \"STRASSE\" (documented D-019 limitation)", !matched("Is STRASSE open?", brandSite("straße")));
}

function c26(): void {
  console.log("\nC-26 stripped aliases and unusable names");
  const basis = source("p1", "public_review", "We keep comparing booking tools and none of them fit.");
  const states: Array<[string, AliasResolution | null]> = [["unresolved", null], ["accept", "accept"], ["reject", "reject"]];
  const brands: Array<[string, string, string, string]> = [
    ["Acme Inc.", "acme", "Acme Inc pricing?", "Acme pricing?"],
    ["Day Spa", "day", "day spa prices?", "day rates?"],
  ];
  for (const [brand, alias, fullQ, aliasQ] of brands) {
    for (const [state, resolution] of states) {
      const site = brandSite(brand, resolution);
      const full = brandPresence(fullQ, site);
      check(`C-26 ${brand} [${state}] "${fullQ}": full form definitive`, full.brandDefinitive && !full.signals.some((s) => s.code === "brand_alias_unresolved"));

      const evalKind = (kind: QuestionKind) => {
        const c = candidate("c1", aliasQ, "adapted", { kind, primarySourceId: "p1" });
        const set: ResearchSet = { siteContext: site, sources: [basis], candidates: [c], links: [link("c1", "p1", "paraphrase_basis")] };
        const v = validateResearchSet(set).candidates.get("c1")!;
        const rec = recommend(set);
        return { v, codes: v.refusals.map((r) => r.code), preselected: rec.preselected.includes("c1") };
      };
      const unb = evalKind("unbranded");
      const br = evalKind("branded_accuracy");
      if (state === "unresolved") {
        const sig = unb.v.signals.find((s) => s.code === "brand_alias_unresolved");
        check(`C-26 ${brand} [unresolved] "${aliasQ}": signal with original name and alias`, sig !== undefined && sig.name === brand && sig.alias === alias, JSON.stringify(sig));
        check(`C-26 ${brand} [unresolved] unbranded: not refused, not preselected`, unb.codes.length === 0 && !unb.preselected && unb.v.brandStatus === "unresolved");
        check(`C-26 ${brand} [unresolved] branded: not refused, unresolved, not preselected`, br.codes.length === 0 && br.v.brandStatus === "unresolved" && !br.preselected);
      } else if (state === "accept") {
        check(`C-26 ${brand} [accept] unbranded "${aliasQ}": refused`, unb.codes.includes("unbranded_contains_brand"));
        check(`C-26 ${brand} [accept] branded: satisfied and preselected`, br.codes.length === 0 && br.v.brandStatus === "present" && br.preselected);
      } else {
        check(`C-26 ${brand} [reject] unbranded "${aliasQ}": eligible and preselected`, unb.codes.length === 0 && unb.v.brandStatus === "absent" && unb.preselected);
        check(`C-26 ${brand} [reject] branded: refused`, br.codes.includes("branded_missing_brand"));
      }
    }
  }
  for (const product of ["Inc.", "LLC", "Pty Ltd"]) {
    const site = brandSite("Zelto", null, [product]);
    const res = findNameMatches("Is inc pricing fair for an llc or pty ltd?", site);
    check(`C-26 product "${product}": brand_name_unusable, matches nothing`, res.signals.some((s) => s.code === "brand_name_unusable" && s.name === product) && res.matches.length === 0);
  }
}

function c27(): void {
  console.log("\nC-27 mandatory confirmation versus the regex signal");
  const clean = "Which invoicing tool suits a small firm?";
  const pattern = "Email jane.doe@example.com: which invoicing tool suits a small firm?";
  const a = validateSource(source("a", "public_review", clean, { personalDataRemoved: false }));
  const b = validateSource(source("b", "public_review", pattern, { personalDataRemoved: true }));
  const c = validateSource(source("c", "public_review", pattern, { personalDataRemoved: false }));
  const d = validateSource(source("d", "public_review", clean, { personalDataRemoved: true }));
  check("C-27 (a) refused for the missing confirmation, no signal", a.refusals.map((r) => r.code).join() === "personal_data_confirmation_missing" && a.signals.length === 0);
  check("C-27 (b) accepted, possible_personal_data shown", b.refusals.length === 0 && b.signals.some((s) => s.code === "possible_personal_data"));
  check(
    "C-27 (c) refused for the confirmation; signal listed separately",
    c.refusals.map((r) => r.code).join() === "personal_data_confirmation_missing" &&
      !c.refusals.some((r) => (r.code as string) === "possible_personal_data") &&
      c.signals.some((s) => s.code === "possible_personal_data")
  );
  check("C-27 (d) accepted, no signal", d.refusals.length === 0 && d.signals.length === 0);
  check("C-27 result fields are only id, refusals and signals", [a, b, c, d].every((r) => Object.keys(r).sort().join() === "refusals,signals,sourceId"));

  const dir = join(process.cwd(), "lib", "buyer-questions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const offending = files.filter((f) => /anonymi[sz]/i.test(readFileSync(join(dir, f), "utf8")));
  check("C-27 static: nothing in lib/buyer-questions/ named or documented as anonymised", files.length > 0 && offending.length === 0, offending.join(","));
}

function c28(): void {
  console.log("\nC-28 domain names");
  const site = brandSite("acme.io");
  for (const word of ["acme.io", "www.acme.io", "Acme.IO?"]) {
    check(`C-28 "acme.io" matches "${word}"`, matched(`Is ${word} reliable`, site));
  }
  for (const phrase of ["acme", "acme io", "acme.io/pricing"]) {
    check(`C-28 "acme.io" does not match "${phrase}"`, !matched(`Is ${phrase} reliable`, site));
  }
  check("C-28 brand \"Acme\" matches \"acme.io\" through part key", matched("Is acme.io reliable", brandSite("Acme")));
}


// ------------------------------------------- adversarial regressions ([R])
// Expected results below are written out by hand from D-039 and the
// Founder's corrective decisions, not computed with the code under test.

function c02r(): void {
  const buyer = source("p1", "public_community", SRC_TEXT);
  const r = run(candidate("c1", SRC_TEXT, "observed"), [link("c1", "p1", "context")], [buyer]);
  check("[R] C-02 context-only link to a buyer source: observed refused", r.codes.includes("observed_requires_verbatim_buyer_source") && r.v.verification === null);
}

function c04r(): void {
  const text = "Which invoicing tool suits a small accounting firm?";
  const partial = source("p1", "public_community", "XWhich invoicing tool suits a small accounting firmly");
  const r1 = run(candidate("c1", text, "observed"), [link("c1", "p1", "verbatim", "Which invoicing tool suits a small accounting firm")], [partial]);
  check("[R] C-04 span starting and ending inside words: refused", r1.codes.includes("quoted_span_not_word_aligned") && r1.v.verification === null, r1.codes.join(","));
  const tail = source("p2", "public_community", "Honestly which invoicing tool suits a small accounting firmware team");
  const r2 = run(candidate("c1", text, "observed"), [link("c1", "p2", "verbatim", "which invoicing tool suits a small accounting firm")], [tail]);
  check("[R] C-04 span ending inside a word: refused", r2.codes.includes("quoted_span_not_word_aligned"));
  const invented = source("p3", "public_community", "Our invoices take forever to reconcile.");
  const r3 = run(candidate("c1", text, "observed"), [link("c1", "p3", "verbatim", text)], [invented]);
  check("[R] C-04 invented span not in the excerpt: refused", r3.codes.includes("quoted_span_not_in_excerpt"));
  const aligned = source("p4", "public_community", `Q: ${text} Thanks!`);
  const r4 = run(candidate("c1", text, "observed"), [link("c1", "p4", "verbatim", text)], [aligned]);
  check("[R] C-04 span bounded by spaces and punctuation: accepted", r4.codes.length === 0 && r4.v.verification === "public_verifiable", r4.codes.join(","));
  const edges = source("p5", "public_community", text);
  const r5 = run(candidate("c1", text, "observed"), [link("c1", "p5", "verbatim", text)], [edges]);
  check("[R] C-04 span equal to the whole excerpt: accepted", r5.codes.length === 0);
}

function c06r(): void {
  const cm = source("m1", "customer_material", SRC_TEXT);
  const pub = source("p1", "public_community", SRC_TEXT);
  const both = [link("c1", "m1", "verbatim"), link("c1", "p1", "verbatim")];
  const asCustomer = run(candidate("c1", SRC_TEXT, "observed", { primarySourceId: "m1" }), both, [cm, pub]);
  check("[R] C-06 customer + public verbatim, primary customer: customer_provided", asCustomer.codes.length === 0 && asCustomer.v.verification === "customer_provided");
  check(
    "[R] C-06 each source keeps its own status",
    JSON.stringify((asCustomer.v.sourceVerifications ?? []).map((e) => [e.sourceId, e.verification])) ===
      JSON.stringify([["m1", "customer_provided"], ["p1", "public_verifiable"]])
  );
  const asPublic = run(candidate("c1", SRC_TEXT, "observed", { primarySourceId: "p1" }), both, [cm, pub]);
  check("[R] C-06 primary public: public_verifiable", asPublic.v.verification === "public_verifiable");
  const none = run(candidate("c1", SRC_TEXT, "observed", { primarySourceId: null }), both, [cm, pub]);
  check("[R] C-06 no primary: no candidate status, review signal, not refused", none.codes.length === 0 && none.v.verification === null && none.signals.includes("primary_source_unresolved"));
  const basis = source("b1", "public_review", "Invoicing is painful for our firm.");
  const ctx = run(
    candidate("c1", SRC_TEXT, "observed", { primarySourceId: "m1" }),
    [link("c1", "m1", "verbatim"), link("c1", "b1", "paraphrase_basis"), link("c1", "b1", "context")],
    [cm, basis]
  );
  check("[R] C-06 customer verbatim + public basis/context: customer_provided", ctx.codes.length === 0 && ctx.v.verification === "customer_provided");
  const notSupporting = run(
    candidate("c1", SRC_TEXT, "observed", { primarySourceId: "b1" }),
    [link("c1", "m1", "verbatim"), link("c1", "b1", "paraphrase_basis")],
    [cm, basis]
  );
  check("[R] C-06 primary that is not a verbatim support of an observed candidate: refused", notSupporting.codes.includes("primary_source_invalid"));
  const adaptedText = "How can a small firm make invoicing less painful?";
  const mixedAdapted = run(
    candidate("c1", adaptedText, "adapted", { primarySourceId: "m1" }),
    [link("c1", "m1", "paraphrase_basis"), link("c1", "b1", "paraphrase_basis")],
    [cm, basis]
  );
  check("[R] C-06 adapted with customer + public bases, primary customer: customer_provided", mixedAdapted.codes.length === 0 && mixedAdapted.v.verification === "customer_provided");
  const mixedAdaptedNone = run(
    candidate("c1", adaptedText, "adapted", { primarySourceId: null }),
    [link("c1", "m1", "paraphrase_basis"), link("c1", "b1", "paraphrase_basis")],
    [cm, basis]
  );
  check("[R] C-06 adapted mixed bases, no primary: never upgraded to public", mixedAdaptedNone.v.verification === null && mixedAdaptedNone.signals.includes("primary_source_unresolved"));
}

function c20r(): void {
  const listForms = [
    "Which tool offers invoicing and payroll and expense tracking?",
    "Which tool offers invoicing; payroll; expense tracking?",
    "Which tool offers invoicing / payroll / expense tracking?",
    "Which tool offers invoicing, payroll or expense tracking?",
    "Which tool offers invoicing, payroll & expense tracking?",
    "Which tool offers automated multi-entity invoice approvals, real-time payroll sync across regions, and expense tracking?",
    "Which tool offers:\n- invoicing\n- payroll\n- expenses?",
    "What tool has invoicing, payroll, expense tracking, and how much is it?",
  ];
  for (const text of listForms) {
    check(`[R] C-20 feature list flagged: ${JSON.stringify(text)}`, marketingSignal(text, SITE).triggers.includes("feature_list" as never));
  }
  const notLists = [
    "Which tool offers invoicing, payroll?",
    "Is it worth paying for invoicing or should we stay on spreadsheets?",
    "My accountant and I disagree on approval limits, who is right?",
    "Should I switch from spreadsheets to an invoicing app, and when?",
  ];
  for (const text of notLists) {
    check(`[R] C-20 not a feature list: ${JSON.stringify(text)}`, !marketingSignal(text, SITE).triggers.includes("feature_list" as never));
  }
  const plain = "Which invoicing tool suits a small accounting firm?";
  check("[R] C-20 fixture passes every detector", !marketingSignal(plain, SITE).flagged);
  const sellerCopy = source("s1", "site_copy", plain);
  const r = run(candidate("c1", plain, "observed"), [link("c1", "s1", "verbatim")], [sellerCopy]);
  check("[R] C-20 passing the detector is no proof of buyer authorship: seller text still refused as observed", r.codes.includes("seller_source_only_as_context") && r.codes.includes("observed_requires_verbatim_buyer_source"));
}

function main(): void {
  const cases: Array<() => void> = [
    // Each [R] function runs right after its case, under the same case header,
    // and in its own try so one failure cannot hide another.
    c01, c02, c02r, c03, c04, c04r, c05, c06, c06r, c07, c08, c09, c10,
    c11, c12, c13, c14, c15, c16, c17, c18, c19, c20, c20r, c21, c22, c23, c24, c25, c26, c27, c28,
  ];
  for (const c of cases) {
    try {
      c();
    } catch (error) {
      check("case completed without an exception", false, error instanceof Error ? error.message : String(error));
    }
  }
  console.log(
    `\n${checks - failures}/${checks} checks passed (${cases.filter((c) => !c.name.endsWith("r")).length} cases). ` +
      (failures === 0 ? "BQI candidate rules PASSED." : "BQI candidate rules FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
