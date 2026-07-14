#!/usr/bin/env tsx
/** Sprint 14A focused checks for the one-command MVP scan runner. */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    passed += 1;
    console.log(`✅ ${name}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}`);
  }
}

const script = readFileSync("scripts/mvp-scan.ts", "utf-8");
const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { scripts?: Record<string, string> };

check("mvp:scan npm command is registered", pkg.scripts?.["mvp:scan"] === "tsx scripts/mvp-scan.ts");
check("runner supports --dry-run", script.includes('has("dry-run")'));
check("runner supports --probe-mode live|simulated", script.includes('probeModeRaw !== "live"') && script.includes('probeModeRaw !== "simulated"'));
check("runner supports --prompts and --runs", script.includes('get("prompts")') && script.includes('get("runs")'));
check("runner has a budget guard", script.includes("Budget guard stopped scan before paid probes"));
check("runner resumes by counting existing prompt/run rows", script.includes("existingRunCount") && script.includes("missing = Math.max"));
check("runner persists rawProbeRequest", script.includes("rawProbeRequest: live.rawProbeRequest") && script.includes("rawProbeRequest: prompt.prompt"));
check("runner asserts no hidden client identity", script.includes("probeRequestLeaksClientIdentity"));
check("runner writes predictable exports path", script.includes("./exports/") && script.includes("mvp-scan"));
check("runner prints final scorecard line", script.includes("scorecard           :") && script.includes("recommendedAsProduct"));
check("runner keeps simulated mode free of Perplexity calls", script.includes('if (args.probeMode === "simulated")') && script.includes("saveSimulatedProbe"));
check("runner does not import generated asset pipeline", !script.includes("generate-asset") && !script.includes("run-qa"));

if (failed > 0) {
  console.error(`Sprint 14A MVP scan runner checks failed: ${failed} failed / ${passed} passed.`);
  process.exit(1);
}
console.log(`Sprint 14A MVP scan runner checks passed: ${passed}/${passed}.`);
