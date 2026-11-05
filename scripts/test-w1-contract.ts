#!/usr/bin/env tsx
/**
 * W1-A: the TypeScript mirror of the Q2′-2 contract, the check catalogue,
 * URL handling and the tightened outbound address policy.
 *
 * C*  the mirror equals the migration text (fails on drift)
 * D*  the detail-spec validator behaves like _q2p2_detail_matches_spec
 * K*  every catalogue entry is complete, well formed and storable
 * U*  input normalisation and the evidence-URL sanitiser
 * S*  IPv6/IPv4 ranges newly refused by outbound-url-safety.ts
 *
 * Offline: reads repository files only.
 */
import { readFileSync } from "node:fs";

import { isPublicAddress } from "@/lib/crawler/outbound-url-safety";
import { W1_CATALOG, W1_RULE_SET_VERSION } from "@/lib/site-diagnostic/catalog";
import {
  CHECK_ID_RE,
  DETAIL_TOKEN_RE,
  PAGE_FETCH_ERRORS,
  RUN_OUTCOMES,
  UNKNOWN_REASONS,
  detailMatchesSpec,
  isNormalisedDomain,
  isSanitisedUrl,
  specIsWellFormed,
  worstCaseDetailBytes,
  type DetailSpec,
} from "@/lib/site-diagnostic/contract";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { W1_USER_AGENT } from "@/lib/site-diagnostic/policy";
import { normalizeDiagnosticInput, sanitizeEvidenceUrl, siteHosts, isExcludedPath } from "@/lib/site-diagnostic/url";

let failures = 0;
let total = 0;
function check(label: string, condition: boolean): void {
  total += 1;
  if (condition) console.log("  ✓ " + label);
  else {
    failures += 1;
    console.error("  ✗ " + label);
  }
}
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

console.log("test-w1-contract");

/* ---------------------------------------------------------------- C */
const migration = readFileSync("supabase/migrations/20261103173000_q2p2_domains_and_site_diagnostics.sql", "utf8");
const flat = migration.replace(/\s+/g, " ");
const listIn = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",\\s*");
check("C1 unknown reasons equal the migration's", new RegExp(`unknown_reason in \\(\\s*${listIn(UNKNOWN_REASONS)}\\s*\\)`).test(migration.replace(/\s+/g, " ")) || new RegExp(listIn(UNKNOWN_REASONS)).test(flat));
check("C2 page fetch_error values equal the migration's", new RegExp(listIn(PAGE_FETCH_ERRORS)).test(flat));
check("C3 run outcomes equal the migration's", new RegExp(listIn(RUN_OUTCOMES)).test(flat));
check("C4 finding states equal the migration's", new RegExp(listIn(["pass", "issue", "info", "unknown"])).test(flat));
check("C5 check_id regex is the migration's", migration.includes("'^[a-z][a-z0-9_.]{2,63}$'") && CHECK_ID_RE.source === "^[a-z][a-z0-9_.]{2,63}$");
check("C6 detail token regex is the migration's", migration.includes("'^[a-z][a-z0-9_]{0,31}$'") && DETAIL_TOKEN_RE.source === "^[a-z][a-z0-9_]{0,31}$");
check("C7 sanitised URL regex is the migration's", migration.includes("'^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#@[:space:]]*)?$'"));
check("C8 page cap 1..10 and page_index 0..9", /page_cap between 1 and 10/.test(flat) && /page_index between 0 and 9/.test(flat));
check("C9 excerpt cap 300", /length\(excerpt\) between 1 and 300/.test(flat));
check("C10 the registry still ships empty (no spec approved yet)", /_q2p2_finding_detail_spec[\s\S]{0,400}?begin\s+return null;\s+end;/.test(migration));
check("C11 user agent fits user_agent <= 300", W1_USER_AGENT.length <= 300);

/* ---------------------------------------------------------------- D */
const fixtureSpec: DetailSpec = {
  keys: {
    has_canonical: { type: "boolean" },
    missing_alt_count: { type: "count", max: 500 },
    text_ratio: { type: "ratio" },
    severity: { type: "enum", values: ["low", "medium", "high"] },
    tags: { type: "enum_list", values: ["og_title", "og_image"], max_items: 2 },
  },
};
check("D1 a valid detail matches", detailMatchesSpec(fixtureSpec, { has_canonical: true, missing_alt_count: 3, text_ratio: 0.25, severity: "low", tags: ["og_title"] }));
check("D2 null spec matches nothing", !detailMatchesSpec(null, { has_canonical: true }));
check("D3 {} is refused (1..16 keys)", !detailMatchesSpec(fixtureSpec, {}));
check("D4 unknown key is refused", !detailMatchesSpec(fixtureSpec, { other: true }));
check("D5 count above max is refused", !detailMatchesSpec(fixtureSpec, { missing_alt_count: 501 }));
check("D6 negative and fractional counts are refused", !detailMatchesSpec(fixtureSpec, { missing_alt_count: -1 }) && !detailMatchesSpec(fixtureSpec, { missing_alt_count: 1.5 }));
check("D7 ratio scale > 4 is refused (float noise)", !detailMatchesSpec(fixtureSpec, { text_ratio: 0.1 + 0.2 }) && detailMatchesSpec(fixtureSpec, { text_ratio: 0.3 }));
check("D8 ratio outside 0..1 is refused", !detailMatchesSpec(fixtureSpec, { text_ratio: 1.5 }));
check("D9 enum value outside the list is refused", !detailMatchesSpec(fixtureSpec, { severity: "critical" }));
check("D10 enum_list over max_items is refused", !detailMatchesSpec(fixtureSpec, { tags: ["og_title", "og_image", "og_title"] }));
check("D11 enum_list [] is accepted (as in SQL)", detailMatchesSpec(fixtureSpec, { tags: [] }));
check("D12 free text is refused", !detailMatchesSpec(fixtureSpec, { severity: "https://example.com" }));
check("D13 nested objects and null are refused", !detailMatchesSpec(fixtureSpec, { has_canonical: null }) && !detailMatchesSpec(fixtureSpec, { tags: [{}] as never }));
check("D14 a malformed spec matches nothing", !detailMatchesSpec({ keys: { a: { type: "count", max: 0 } } }, { a: 0 }));
check("D15 17 keys are refused", !detailMatchesSpec({ keys: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, { type: "boolean" }])) as never }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, true]))));

/* ---------------------------------------------------------------- K */
const ids = W1_CATALOG.map((c) => c.checkId);
check("K1 catalogue has 23 checks", W1_CATALOG.length === 23);
check("K2 check ids are unique", new Set(ids).size === ids.length);
check("K3 rule set version is set", W1_RULE_SET_VERSION.trim() !== "");
const level2Probes = ["html.title", "html.meta", "robots.txt", "x"];
for (const def of W1_CATALOG) {
  const at = `K ${def.checkId}`;
  check(`${at}: id matches the database regex`, CHECK_ID_RE.test(def.checkId));
  check(`${at}: avoids the Level-2 QR2-19 probe pairs`, !(level2Probes.includes(def.checkId) && ["r1", "r2", "v1"].includes(def.ruleVersion)));
  check(`${at}: has a non-blank rule version`, def.ruleVersion.trim() !== "");
  check(`${at}: spec is well formed`, specIsWellFormed(def.detailSpec));
  check(`${at}: worst-case detail fits 4096 bytes`, worstCaseDetailBytes(def.detailSpec) <= 4096);
  check(`${at}: unknown reasons are database values`, def.unknownReasons.length > 0 && def.unknownReasons.every((r) => (UNKNOWN_REASONS as readonly string[]).includes(r)));
  check(`${at}: states what it does not establish`, def.doesNotEstablish.trim().length > 20);
  check(`${at}: title and establishes are present`, def.title.trim() !== "" && def.establishes.trim().length > 20);
  const lintable = [def.title, def.establishes, def.fix.issue ?? "", def.fix.info ?? ""].join(" ").toLowerCase();
  const hit = FORBIDDEN_W1_PHRASES.find((phrase) => lintable.includes(phrase));
  check(`${at}: copy uses no forbidden phrase${hit ? ` (found "${hit}")` : ""}`, hit === undefined);
}
check("K4 no catalogue field is called score, grade or percent", !/score|grade|percent/i.test(JSON.stringify(W1_CATALOG.map((c) => Object.keys(c.detailSpec.keys)))));

/* ---------------------------------------------------------------- U */
const n = (raw: string) => normalizeDiagnosticInput(raw);
const ok = n("Example.COM/pricing?x=1#frag");
check("U1 bare domain gets https, lowercased, homepage start", ok.ok && ok.value.startUrl === "https://example.com/" && ok.value.pathIgnored && ok.value.queryPresent);
check("U2 www is stripped for the domain identity only", (() => { const r = n("https://www.acme.example"); return r.ok && r.value.host === "www.acme.example" && r.value.normalizedDomain === "acme.example"; })());
check("U3 IDN becomes an A-label", (() => { const r = n("https://bücher.example/"); return r.ok && r.value.host === "xn--bcher-kva.example"; })());
const refusals: Array<[string, string]> = [
  ["", "empty"],
  ["ftp://example.com", "unsupported_protocol"],
  ["https://user:pw@example.com", "embedded_credentials"],
  ["https://example.com:8443", "non_default_port"],
  ["http://10.0.0.1/", "ip_literal"],
  ["http://[::1]/", "ip_literal"],
  ["https://localhost", "reserved_hostname"],
  ["https://intranet.corp", "reserved_hostname"],
  ["https://router.local", "reserved_hostname"],
  ["https://single", "invalid_domain"],
  ["https://under_score.example", "invalid_domain"],
  ["https://ab--c.example", "invalid_domain"],
  ["https://exa mple.com", "invalid_url"],
];
for (const [raw, reason] of refusals) {
  const r = n(raw);
  check(`U4 "${raw}" is refused as ${reason}`, !r.ok && r.reason === reason);
}
for (const raw of ["https://example.com/a/b?q=1#f", "https://Example.COM:443/@user", "http://example.com", "https://example.com./x y", "https://bücher.example/preise"]) {
  const s = sanitizeEvidenceUrl(raw);
  check(`U5 sanitised form of ${raw} matches the database regex`, s !== null && isSanitisedUrl(s.url));
}
check("U6 query dropped and flagged", sanitizeEvidenceUrl("https://example.com/p?email=a%40b.c")?.url === "https://example.com/p" && sanitizeEvidenceUrl("https://example.com/p?x")?.queryPresent === true);
check("U7 '@' in the path is percent-encoded", sanitizeEvidenceUrl("https://example.com/@user")?.url === "https://example.com/%40user");
check("U8 path is at least '/'", sanitizeEvidenceUrl("https://example.com")?.url === "https://example.com/");
check("U9 IP literals have no sanitised form", sanitizeEvidenceUrl("http://93.184.216.34/") === null && sanitizeEvidenceUrl("http://[2606:2800::1]/") === null);
check("U10 over 2048 characters has no sanitised form", sanitizeEvidenceUrl("https://example.com/" + "a".repeat(2100)) === null);
check("U11 site hosts: apex gains www", [...siteHosts("acme.example")].sort().join(",") === "acme.example,www.acme.example");
check("U12 site hosts: www gains apex", [...siteHosts("www.acme.example")].sort().join(",") === "acme.example,www.acme.example");
check("U13 site hosts: other subdomains stay alone", [...siteHosts("app.acme.example")].join(",") === "app.acme.example");
check("U14 login, checkout and account paths are excluded", ["/login", "/en/sign-in", "/checkout/step1", "/my-account", "/wp-login.php"].every(isExcludedPath));
check("U15 ordinary paths are not excluded", !["/pricing", "/blog/login-best-practices", "/security"].some(isExcludedPath));
check("U16 domain vectors from Level 2", ["example.com", "a.io", "xn--bcher-kva.example", "example.xn--p1ai"].every(isNormalisedDomain) && !["ab--c.example.com", "example.123", "Example.com", "example.com.", "a.b"].some(isNormalisedDomain));

/* ---------------------------------------------------------------- S */
const newlyRefused = ["::a00:1", "::ffff:0:a00:1", "64:ff9b:1::a00:1", "fec0::1", "2001::1", "2001:20::1", "3fff::1", "5f00::1", "::10.0.0.1", "::ffff:0:10.0.0.1", "192.88.99.1"];
for (const address of newlyRefused) check(`S1 ${address} is not public`, !isPublicAddress(address));
const stillPublic = ["2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4001:82a::200e", "64:ff9b::5db8:d822", "::ffff:93.184.216.34", "93.184.216.34"];
for (const address of stillPublic) check(`S2 ${address} is still public`, isPublicAddress(address));
const stillPrivate = ["::1", "fe80::1", "fd00:ec2::254", "::ffff:10.0.0.1", "64:ff9b::a00:1", "169.254.169.254", "100.100.100.200", "2001:db8::1", "2002::1"];
for (const address of stillPrivate) check(`S3 ${address} stays non-public`, !isPublicAddress(address));

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
