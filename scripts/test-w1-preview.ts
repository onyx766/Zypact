#!/usr/bin/env tsx
/**
 * W1 founder preview: route order, refusals, statelessness, and the import
 * boundary of every W1 module.
 *
 * P*  handleW1Preview with an injected guard and engine (no network, no auth)
 * S*  static checks on the real route, page and handler files
 * G*  import graph: nothing in W1 reaches a model, probe, database, worker
 *     or legacy pipeline module, and no W1 code names a Q2′ table
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import {
  W1_PREVIEW_DOMAIN_COOLDOWN_MS,
  W1_PREVIEW_MAX_BODY_BYTES,
  handleW1Preview,
  resetPreviewCooldownsForTests,
  type PreviewDeps,
} from "@/lib/site-diagnostic/preview-handler";
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";

import { acmeSite, fixtureNet } from "./fixtures/w1/fixture-net";

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
let fetchCalls = 0;
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  fetchCalls += 1;
  throw new Error("network disabled");
};

function req(body: string, contentType = "application/json"): Request & { bodyRead: () => boolean } {
  let read = false;
  const request = new Request("https://www.zypact.com/api/internal/site-diagnostics/preview", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const original = request.text.bind(request);
  (request as unknown as { text: () => Promise<string> }).text = () => {
    read = true;
    return original();
  };
  return Object.assign(request, { bodyRead: () => read });
}

async function main(): Promise<void> {
  console.log("test-w1-preview");
  const logs: Array<Record<string, unknown>> = [];
  let clock = 1_000_000;
  let runs = 0;
  const net = fixtureNet(acmeSite());
  const founder: PreviewDeps["guard"] = async () => ({ ok: true, user: { id: "founder-1" } });
  const deps = (overrides: Partial<PreviewDeps> = {}): PreviewDeps => ({
    enabled: () => true,
    guard: founder,
    run: (url, signal) => {
      runs += 1;
      return runSiteDiagnostic(url, { transport: net.transport, dnsLookup: net.dnsLookup, now: net.clock.now, sleep: net.clock.sleep, signal });
    },
    now: () => clock,
    log: (entry) => logs.push(entry),
    ...overrides,
  });

  /* P: behaviour --------------------------------------------------- */
  {
    let guardCalls = 0;
    const r = req(JSON.stringify({ url: "acme-analytics.example" }));
    const res = await handleW1Preview(r, deps({ enabled: () => false, guard: async () => { guardCalls += 1; return founder(); } }));
    check("P1 kill switch off: 503 before the guard and before the body", res.status === 503 && guardCalls === 0 && !r.bodyRead());
  }
  {
    const r = req(JSON.stringify({ url: "acme-analytics.example" }));
    const denied = NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const res = await handleW1Preview(r, deps({ guard: async () => ({ ok: false, response: denied }) }));
    check("P2 not a founder: the guard's 404 is returned and the body is never read", res.status === 404 && !r.bodyRead() && runs === 0);
  }
  {
    const res = await handleW1Preview(req("url=acme", "application/x-www-form-urlencoded"), deps());
    check("P3 a non-JSON body is 415 (no form posts)", res.status === 415);
  }
  {
    const res = await handleW1Preview(req(JSON.stringify({ url: "a".repeat(W1_PREVIEW_MAX_BODY_BYTES) })), deps());
    check("P4 an oversized body is 413", res.status === 413);
  }
  {
    const res = await handleW1Preview(req("{not json"), deps());
    check("P5 malformed JSON is 400", res.status === 400);
  }
  {
    const res = await handleW1Preview(req(JSON.stringify({ url: "http://10.0.0.1/" })), deps());
    const body = (await res.json()) as { error: string };
    check("P6 an IP literal is refused with a closed code", res.status === 422 && body.error === "ip_literal" && runs === 0);
  }
  {
    resetPreviewCooldownsForTests();
    const res = await handleW1Preview(req(JSON.stringify({ url: "acme-analytics.example" })), deps());
    const body = (await res.json()) as { ok: boolean; report: { reportSha256: string; notices: { ownership: string } }; markdown: string };
    check("P7 a founder run returns the report and Markdown", res.status === 200 && body.ok && /^[0-9a-f]{64}$/.test(body.report.reportSha256) && body.markdown.includes("Domain ownership not verified."));
    const runLog = logs.find((entry) => entry.event === "w1_preview_run");
    check("P8 the run log has closed fields only", runLog !== undefined && !JSON.stringify(runLog).includes("acme") && Object.keys(runLog).every((key) => ["event", "userId", "outcome", "stopReason", "pageCount", "requestCount", "durationMs"].includes(key)));
    const again = await handleW1Preview(req(JSON.stringify({ url: "https://www.acme-analytics.example/" })), deps());
    check("P9 the same domain again within the cooldown is 429 (www folded)", again.status === 429);
    clock += W1_PREVIEW_DOMAIN_COOLDOWN_MS;
    const later = await handleW1Preview(req(JSON.stringify({ url: "acme-analytics.example" })), deps());
    check("P10 after the cooldown it runs again", later.status === 200);
  }
  {
    const res = await handleW1Preview(req(JSON.stringify({ url: "boom.example" })), deps({ run: async () => { throw new Error("secret detail 10.0.0.1:443"); } }));
    const text = await res.text();
    check("P11 an unexpected error is a closed 500 with no detail", res.status === 500 && !text.includes("secret") && !JSON.stringify(logs).includes("secret"));
  }

  /* S: static order in the real files ------------------------------ */
  const handler = readFileSync("lib/site-diagnostic/preview-handler.ts", "utf8");
  const at = (needle: string) => handler.indexOf(needle);
  check("S1 handler: kill switch, then guard, then body", at("deps.enabled()") > 0 && at("deps.enabled()") < at("deps.guard()") && at("deps.guard()") < at("request.text()"));
  const route = readFileSync("app/api/internal/site-diagnostics/preview/route.ts", "utf8");
  check("S2 route uses the founder route guard and the env kill switch", route.includes("requireFounderForRoute(W1_PREVIEW_ROUTE)") && route.includes("previewEnabledFromEnv"));
  check("S3 route exports only POST (no GET-triggered crawl)", /export async function POST/.test(route) && !/export (async )?function (GET|PUT|PATCH|DELETE)/.test(route));
  check("S4 route declares nodejs runtime and a maxDuration above the run deadline", route.includes('runtime = "nodejs"') && /maxDuration = (\d+)/.test(route) && Number(route.match(/maxDuration = (\d+)/)?.[1]) > 45);
  check("S5 kill switch must be exactly \"true\"", handler.includes('process.env[W1_PREVIEW_ENV] === "true"'));
  const page = readFileSync("app/admin/site-diagnostics/page.tsx", "utf8");
  const body = page.slice(page.indexOf("export default async function"));
  check("S6 page calls requireFounderForPage first", body.indexOf("await requireFounderForPage(") > 0 && body.indexOf("await requireFounderForPage(") < body.indexOf("previewEnabledFromEnv()"));
  check("S7 page is labelled as an internal preview", page.includes("INTERNAL_PREVIEW_LABEL"));
  const env = readFileSync(".env.example", "utf8");
  check("S8 .env.example names the kill switch without a value", /^ZYPACT_W1_PREVIEW_ENABLED=\s*$/m.test(env));

  /* G: import boundary --------------------------------------------- */
  const FORBIDDEN = [/^lib\/llm\//, /^lib\/probes\//, /^lib\/db\//, /^lib\/pipeline\//, /^lib\/agents\//, /^lib\/worker-control\//, /^lib\/protocol-worker\//, /^lib\/reports\/service-client/, /^lib\/supabase\//];
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const roots = [
    ...readdirSync("lib/site-diagnostic").map((f) => `lib/site-diagnostic/${f}`),
    "lib/crawler/robots.ts",
    "app/api/internal/site-diagnostics/preview/route.ts",
    "app/admin/site-diagnostics/page.tsx",
    "app/admin/site-diagnostics/preview-client.tsx",
  ].filter((f) => /\.tsx?$/.test(f));
  /*
   * lib/auth/** is the shared, separately reviewed founder gate: the session
   * helpers behind requireFounderFor* read lib/db for project ownership. W1
   * reaches it only through lib/auth/founder.ts, and the walk stops there.
   */
  const authEntries = new Set<string>();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const target = resolve(file, match[1]);
      if (!target || target.startsWith("node_modules")) continue;
      if (target.startsWith("lib/auth/")) {
        authEntries.add(`${file} -> ${target}`);
        continue;
      }
      stack.push(target);
    }
  }
  const reached = [...seen];
  const offending = reached.filter((file) => FORBIDDEN.some((re) => re.test(file)));
  check(`G1 no W1 module reaches a model, probe, DB, worker or pipeline module${offending.length ? " — " + offending.join(", ") : ""}`, offending.length === 0);
  check(
    "G1b W1 enters lib/auth only through the founder guard, from the route and page",
    [...authEntries].sort().join("|") ===
      ["app/admin/site-diagnostics/page.tsx -> lib/auth/founder.ts", "app/api/internal/site-diagnostics/preview/route.ts -> lib/auth/founder.ts"].join("|")
  );
  check("G2 the crawl reaches the SSRF-safe transport", reached.includes("lib/crawler/safe-fetch.ts") && reached.includes("lib/crawler/outbound-url-safety.ts"));
  check("G3 W1 never imports the legacy crawler", !reached.includes("lib/crawler/crawl-site.ts"));
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const w1Source = roots.filter((f) => f.startsWith("lib/site-diagnostic/")).map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
  check("G4 no W1 module names a Q2′ table or RPC", !/site_diagnostic_(runs|pages|findings)|workspace_domains|diagnostic_rate_limit_events|\.rpc\(|\.from\(["']/.test(w1Source));
  check("G5 the client component imports types only from the report module", /import type \{[^}]+\} from "@\/lib\/site-diagnostic\/report"/.test(readFileSync("app/admin/site-diagnostics/preview-client.tsx", "utf8")));

  check("no global fetch call", fetchCalls === 0);
  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
