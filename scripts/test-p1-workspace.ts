#!/usr/bin/env tsx
/**
 * P1 workspace handlers (D-046) over a fake store: the website, the
 * customer-run diagnostic (kill switch, rate limits, refusals, persistence
 * shape) and Brand Profile parsing. Offline: the diagnostic runs on the W1
 * fixture site; every fetch throws. The SQL is proved by
 * scripts/test-p1-workspace-db.ts.
 */
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import {
  DIAGNOSTIC_RATE_RULES,
  diagnosticBucketKey,
  handleRunDiagnostic,
  handleSaveProfile,
  handleSetWebsite,
  parseProfileInput,
  type WorkspaceDeps,
} from "@/lib/workspace/handlers";
import type { WorkspaceState, WorkspaceStore } from "@/lib/workspace/store";
import { draftProfile, setupSteps } from "@/lib/workspace/view";

import { acmeSite, fixtureNet } from "./fixtures/w1/fixture-net";

(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const UUID = "11111111-2222-4333-8444-555555555555";
const account = {
  accountId: UUID,
  email: "person@example.test",
  workspaceName: "Acme",
  session: { status: "ACTIVE" as const, sessionId: UUID, workspaceId: UUID, membershipId: UUID, stepUpAt: null, absoluteExpiresAt: "2026-12-01T00:00:00Z" },
};
const baseState: WorkspaceState = {
  status: "OK",
  workspace: { id: UUID, name: "Acme" },
  website: { domain: "acme-analytics.example", verification: "none" },
  profile: null,
  latestRun: null,
};

function store(overrides: Partial<WorkspaceStore> = {}): WorkspaceStore & { calls: string[] } {
  const calls: string[] = [];
  const s = {
    calls,
    async setWebsite(_t: string, _a: string, domain: string, name: string) {
      calls.push(`setWebsite:${domain}:${name}`);
      return "SET" as const;
    },
    async takeDiagnosticRateLimit(kind: string) {
      calls.push(`rate:${kind}`);
      return true;
    },
    async recordDiagnostic() {
      calls.push("record");
      return { status: "RECORDED" as const, runId: UUID };
    },
    async getState() {
      calls.push("getState");
      return baseState;
    },
    async saveProfile(_t: string, _a: string, v: number) {
      calls.push(`saveProfile:${v}`);
      return { status: "SAVED" as const, version: v + 1 };
    },
    ...overrides,
  };
  return s as unknown as WorkspaceStore & { calls: string[] };
}

function deps(s: WorkspaceStore, opts: { enabled?: boolean; diagnostic?: boolean; secret?: string | null; logs?: Array<Record<string, unknown>> } = {}): WorkspaceDeps & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    config: { enabled: opts.enabled ?? true, diagnosticEnabled: opts.diagnostic ?? true, hmacSecret: opts.secret === undefined ? "s".repeat(32) : opts.secret, hmacKeyId: "k1" },
    store: s,
    async runDiagnostic(url: string) {
      ran.push(url);
      const net = fixtureNet(acmeSite());
      return runSiteDiagnostic(url, { transport: net.transport, dnsLookup: net.dnsLookup, now: net.clock.now, sleep: net.clock.sleep } as Parameters<typeof runSiteDiagnostic>[1]);
    },
    log: (e) => opts.logs?.push(e),
  };
}

async function main(): Promise<void> {
  console.log("test-p1-workspace");

  /* W: website ------------------------------------------------------ */
  const w = store();
  const ok = await handleSetWebsite(deps(w), account, "tok", { website: "https://www.Acme-Analytics.example/pricing?x=1", companyName: " Acme  Analytics " });
  check("W1 a URL is normalised to its apex domain and the name cleaned", ok.status === 200 && w.calls[0] === "setWebsite:acme-analytics.example:Acme Analytics", w.calls[0]);
  check("W2 an IP address is refused before the store", (await handleSetWebsite(deps(w), account, "tok", { website: "http://10.0.0.1/", companyName: "A" })).status === 400 && w.calls.length === 1);
  check("W3 a missing company name is refused", (await handleSetWebsite(deps(w), account, "tok", { website: "acme.example", companyName: "" })).status === 400);
  const diff = await handleSetWebsite(deps(store({ setWebsite: async () => "DIFFERENT_WEBSITE_SET" })), account, "tok", { website: "acme.example", companyName: "A" });
  check("W4 a different website is 409 website_already_set", diff.status === 409 && diff.body.error === "website_already_set");
  check("W5 no session is 401", (await handleSetWebsite(deps(w), null, null, { website: "acme.example", companyName: "A" })).status === 401);
  check("W6 accounts off is 404", (await handleSetWebsite(deps(w, { enabled: false }), account, "tok", { website: "acme.example", companyName: "A" })).status === 404);

  /* D: diagnostic --------------------------------------------------- */
  const off = deps(store(), { diagnostic: false });
  check("D1 the diagnostic switch off is 503 and nothing is fetched", (await handleRunDiagnostic(off, account, "tok", { ip: "203.0.113.5" })).status === 503 && off.ran.length === 0);
  const nosecret = deps(store(), { secret: null });
  check("D2 no HMAC secret is 503 and nothing is fetched", (await handleRunDiagnostic(nosecret, account, "tok", { ip: "203.0.113.5" })).status === 503 && nosecret.ran.length === 0);
  const nosite = deps(store({ getState: async () => ({ ...baseState, website: null }) }));
  check("D3 no website is 409 and nothing is fetched", (await handleRunDiagnostic(nosite, account, "tok", { ip: "203.0.113.5" })).status === 409 && nosite.ran.length === 0);
  const limited = deps(store({ takeDiagnosticRateLimit: async (kind) => kind !== "domain" }));
  check("D4 any refusing bucket is 429 and nothing is fetched", (await handleRunDiagnostic(limited, account, "tok", { ip: "203.0.113.5" })).status === 429 && limited.ran.length === 0);
  const logs: Array<Record<string, unknown>> = [];
  const good = store();
  const gd = deps(good, { logs });
  const res = await handleRunDiagnostic(gd, account, "tok", { ip: "203.0.113.5" });
  check("D5 a run fetches only the workspace's own domain", res.status === 200 && gd.ran.join() === "https://acme-analytics.example/");
  check("D6 every rate bucket is taken before the run", good.calls.filter((c) => c.startsWith("rate:")).join() === DIAGNOSTIC_RATE_RULES.map((r) => `rate:${r.kind}`).join());
  check("D7 the result is recorded once", good.calls.filter((c) => c === "record").length === 1);
  check("D8 logs carry no domain, IP or account id", !JSON.stringify(logs).match(/acme|203\.0\.113|1111/));
  const mismatch = deps(store({ recordDiagnostic: async () => ({ status: "DOMAIN_MISMATCH", runId: null }) }));
  check("D9 a store DOMAIN_MISMATCH is 409", (await handleRunDiagnostic(mismatch, account, "tok", { ip: "203.0.113.5" })).status === 409);
  check("D10 bucket keys are keyed HMACs, distinct per kind", (() => {
    const a = diagnosticBucketKey("s".repeat(32), "account", "x");
    const b = diagnosticBucketKey("s".repeat(32), "ip", "x");
    return /^[0-9a-f]{64}$/.test(a) && a !== b && a !== diagnosticBucketKey("t".repeat(32), "account", "x");
  })());

  /* B: Brand Profile ------------------------------------------------ */
  const base = { expectedVersion: 0, companyName: "Acme", competitors: "Contoso\ncontoso, Fabrikam", objective: "compare_competitors" };
  const p = parseProfileInput(base);
  check("B1 competitors split on lines and commas, de-duplicated case-insensitively", p.ok && p.profile.competitors.join("|") === "Contoso|Fabrikam");
  check("B2 an empty objective is null", (() => {
    const q = parseProfileInput({ ...base, objective: "" });
    return q.ok && q.profile.objective === null;
  })());
  check("B3 an unknown objective is refused", !parseProfileInput({ ...base, objective: "grow" }).ok);
  check("B4 more than 10 competitors are refused", !parseProfileInput({ ...base, competitors: Array.from({ length: 11 }, (_, i) => `C${i}`) }).ok);
  check("B5 an over-long description is refused, not cut", !parseProfileInput({ ...base, description: "x".repeat(1001) }).ok);
  check("B6 a negative expected version is refused", !parseProfileInput({ ...base, expectedVersion: -1 }).ok);
  check("B7 a non-uuid run id is refused", !parseProfileInput({ ...base, basedOnRunId: "1; drop" }).ok);
  const conflict = await handleSaveProfile(deps(store({ saveProfile: async () => ({ status: "VERSION_CONFLICT", version: 3 }) })), account, "tok", base);
  check("B8 VERSION_CONFLICT is 409", conflict.status === 409 && conflict.body.error === "version_conflict");
  const saved = await handleSaveProfile(deps(store()), account, "tok", base);
  check("B9 a save redirects to the Overview", saved.status === 200 && saved.body.redirect === "/account");

  /* V: views -------------------------------------------------------- */
  check("V1 setup steps are four, none done for an empty workspace", setupSteps({ ...baseState, website: null }).filter((s) => s.done).length === 0);
  check("V2 the profile draft invents nothing without a diagnostic", draftProfile(baseState, null).description === null && draftProfile(baseState, null).sources.length === 0);

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
