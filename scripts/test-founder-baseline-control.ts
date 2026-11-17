#!/usr/bin/env tsx
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log("  ok   " + label);
  else { failures += 1; console.error("  FAIL " + label); }
}

const route = readFileSync(
  "app/api/internal/founder-baselines/[jobId]/run/route.ts",
  "utf8"
);
const panel = readFileSync(
  "app/admin/snapshot-requests/founder-baseline-panel.tsx",
  "utf8"
);
const page = readFileSync(
  "app/admin/snapshot-requests/page.tsx",
  "utf8"
);

check(
  "route requires founder authorization",
  route.includes('requireFounderForRoute("founder-baselines/run")')
);
check(
  "route targets exact job and exact protocol",
  route.includes('.eq("id", jobId)') &&
    route.includes('.eq("protocol_id", protocolId)')
);
check(
  "route pins five-run standalone plan",
  route.includes('protocolRow.planned_baseline_runs === 5') &&
    route.includes('protocolRow.planned_retest_runs === 0') &&
    route.includes('protocolRow.run_cap === 5') &&
    route.includes('protocolRow.retry_cap === 0') &&
    route.includes('Number(protocolRow.spend_cap_usd) <= 0.25')
);
check(
  "route refuses prior attempts and non-single-attempt job",
  route.includes('jobRow.attempt_count === 0') &&
    route.includes('jobRow.max_attempts === 1') &&
    route.includes('jobRow.next_baseline_ordinal === 1')
);
check(
  "route blocks competing project jobs",
  route.includes('RUNNABLE_JOB_STATUSES') &&
    route.includes('.neq("id", jobId)') &&
    route.includes('"competing_job_present"')
);
check(
  "route requires stopped worker before start",
  route.includes('workerState !== "stopped"') &&
    route.includes('startWorkerMachine({')
);
check(
  "panel exposes the approved caps and exact identifiers",
  panel.includes("5 planned runs") ||
    (panel.includes("{row.plannedRuns} planned runs") &&
      panel.includes("Protocol {shortId(row.protocolId)}") &&
      panel.includes("Job {shortId(row.jobId)}"))
);
check(
  "panel confirmation states caps before paid start",
  panel.includes("Plan: 5 runs, run cap 5, retry cap 0, spend cap $0.25.")
);
check(
  "admin page loads standalone baselines outside snapshot-request protocols",
  page.includes("loadFounderBaselines") &&
    page.includes("attachedIds") &&
    page.includes("<FounderBaselinePanel rows={founderBaselines} />")
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
