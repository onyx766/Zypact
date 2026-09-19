/**
 * Every link emailed to a customer comes from one origin.
 *
 * Before this, report and Outcome Card links were built from
 * SNAPSHOT_PUBLIC_BASE_URL in the workers and review-actions, and from
 * NEXT_PUBLIC_SITE_URL in the web send routes — so a card sent by the worker
 * and one sent by the founder could point at different hosts. All of them now
 * call publicSiteUrl() (lib/seo/site.ts). Section [2] fails if any delivery
 * path drifts back.
 */

import { readFileSync } from "node:fs";
import { publicSiteUrl } from "@/lib/seo/site";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\nPublic site URL for customer links\n");

console.log("[1] publicSiteUrl()");
const original = process.env.NEXT_PUBLIC_SITE_URL;
delete process.env.NEXT_PUBLIC_SITE_URL;
check("unset falls back to the canonical www host", publicSiteUrl() === "https://www.zypact.com", publicSiteUrl());
process.env.NEXT_PUBLIC_SITE_URL = "   ";
check("blank falls back too", publicSiteUrl() === "https://www.zypact.com");
process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.invalid/";
check("read at call time, after import — staging can point at its own host",
  publicSiteUrl() === "https://staging.example.invalid");
process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.invalid///";
check("trailing slashes are stripped, since callers join paths onto it",
  publicSiteUrl() === "https://staging.example.invalid");
if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
else process.env.NEXT_PUBLIC_SITE_URL = original;

console.log("\n[2] Every customer-link path uses it");
const DELIVERY_PATHS = [
  "app/api/internal/snapshot-requests/[requestId]/send-report/route.ts",
  "app/api/internal/interventions/[interventionId]/outcome-card/send/route.ts",
  "lib/reports/review-actions.ts",
  "scripts/run-report-delivery-worker.ts",
  "scripts/run-outcome-card-worker.ts",
  "scripts/run-pipeline-once.ts",
];
for (const file of DELIVERY_PATHS) {
  const code = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  check(`${file} calls publicSiteUrl()`, /publicSiteUrl\(\)/.test(code));
  check(`${file} does not read SNAPSHOT_PUBLIC_BASE_URL`, !/SNAPSHOT_PUBLIC_BASE_URL/.test(code));
  check(`${file} does not hard-code a fallback host`, !/["']https:\/\/(www\.)?zypact\.com["']/.test(code));
}

console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
if (failed > 0) process.exit(1);
