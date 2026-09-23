/**
 * The report pass the protocol worker runs after its scan loop, and the
 * configuration it shares with the standalone report worker.
 *
 * Offline: every database and email dependency is a fake.
 */

import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  processReportRequests,
  resolveReportPassConfig,
  runReportPass,
  REPORT_PASS_LIMIT,
  type ReportPassConfig,
  type ReportPassDeps,
} from "@/lib/reports/report-pass";
import type { DeliveryOutcome, ProcessResult } from "@/lib/reports/deliver-protocol-report";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FAKE_CLIENT = { fake: true } as unknown as SupabaseClient;
const makeClient = () => FAKE_CLIENT;
const CREDS = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
};

function result(id: string, outcome: DeliveryOutcome): ProcessResult {
  return {
    snapshotRequestId: id,
    outcome,
    integrityStatus: "integrity_passed",
    integrityReasons: [],
    artifactId: `artifact-${id}`,
    publicToken: null,
    messageId: null,
  };
}

function recorder() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    events,
    log: (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }); },
    names: () => events.map((e) => e.event),
    last: (event: string) => [...events].reverse().find((e) => e.event === event)?.fields,
  };
}

const CONFIG: ReportPassConfig = {
  client: FAKE_CLIENT,
  autoSendEnabled: false,
  deliveryConfig: { apiKey: "", from: "", appBaseUrl: "https://www.zypact.com" },
};

async function main(): Promise<void> {
  console.log("\n[1] configuration");
  {
    const missing = resolveReportPassConfig({}, makeClient);
    check("no Supabase credentials is refused", !missing.ok);
    check("…naming the variables, not their values",
      !missing.ok && missing.reason.includes("SUPABASE_SERVICE_ROLE_KEY"));

    const onlyUrl = resolveReportPassConfig({ NEXT_PUBLIC_SUPABASE_URL: CREDS.NEXT_PUBLIC_SUPABASE_URL }, makeClient);
    check("a URL without a key is refused", !onlyUrl.ok);

    const dry = resolveReportPassConfig({ ...CREDS }, makeClient);
    check("credentials alone are enough for a dry pass", dry.ok);
    check("auto-send is off by default", dry.ok && dry.config.autoSendEnabled === false);
    check("mail credentials are not required while auto-send is off",
      dry.ok && dry.config.deliveryConfig.apiKey === "" && dry.config.deliveryConfig.from === "");

    for (const value of ["TRUE", "1", " true", "true ", "yes", ""]) {
      const r = resolveReportPassConfig({ ...CREDS, SNAPSHOT_AUTO_DELIVERY_ENABLED: value }, makeClient);
      check(`auto-send stays off for ${JSON.stringify(value)}`, r.ok && r.config.autoSendEnabled === false);
    }

    const noKey = resolveReportPassConfig({ ...CREDS, SNAPSHOT_AUTO_DELIVERY_ENABLED: "true" }, makeClient);
    check("auto-send without RESEND_API_KEY is refused",
      !noKey.ok && noKey.reason.includes("RESEND_API_KEY"));

    const noFrom = resolveReportPassConfig(
      { ...CREDS, SNAPSHOT_AUTO_DELIVERY_ENABLED: "true", RESEND_API_KEY: "k" }, makeClient);
    check("auto-send without SNAPSHOT_EMAIL_FROM is refused",
      !noFrom.ok && noFrom.reason.includes("SNAPSHOT_EMAIL_FROM"));

    const on = resolveReportPassConfig(
      { ...CREDS, SNAPSHOT_AUTO_DELIVERY_ENABLED: "true", RESEND_API_KEY: "k", SNAPSHOT_EMAIL_FROM: "a@b.c" },
      makeClient);
    check("exactly \"true\" with mail credentials enables auto-send", on.ok && on.config.autoSendEnabled);

    let seen: [string, string] | null = null;
    resolveReportPassConfig({ ...CREDS }, (url, key) => { seen = [url, key]; return FAKE_CLIENT; });
    check("the client is built from exactly the configured URL and key",
      seen !== null && seen[0] === CREDS.NEXT_PUBLIC_SUPABASE_URL && seen[1] === CREDS.SUPABASE_SERVICE_ROLE_KEY);
  }

  console.log("\n[2] processing requests");
  {
    const calls: string[] = [];
    const deps: ReportPassDeps = {
      findDeliverableRequests: async () => [],
      processProtocolReport: async (id) => {
        calls.push(id);
        if (id === "boom") throw new Error("database unavailable");
        if (id === "held") return result(id, "held_blocked");
        return result(id, "held_auto_send_disabled");
      },
    };
    const rec = recorder();
    const summary = await processReportRequests(CONFIG, ["a", "boom", "held", "b"], rec.log, { deps });
    check("every request is attempted, in order", calls.join(",") === "a,boom,held,b", calls.join(","));
    check("one failing request does not stop the batch", summary.processed === 3 && summary.failed === 1,
      JSON.stringify(summary));
    check("an outcome a human must see is counted", summary.needsAttention === 1);
    check("the failure is logged as report_failed with its request",
      rec.events.some((e) => e.event === "report_failed" && e.fields.requestId === "boom"));

    const stopCalls: string[] = [];
    let stop = false;
    const stopDeps: ReportPassDeps = {
      findDeliverableRequests: async () => [],
      processProtocolReport: async (id) => {
        stopCalls.push(id);
        stop = true;
        return result(id, "held_auto_send_disabled");
      },
    };
    const stopped = await processReportRequests(CONFIG, ["x", "y", "z"], recorder().log,
      { deps: stopDeps, shouldStop: () => stop });
    check("a stop is honoured at the next request boundary",
      stopCalls.join(",") === "x" && stopped.stopped && stopped.processed === 1, stopCalls.join(","));
  }

  console.log("\n[3] the pass");
  {
    let found = 0;
    const rejected = recorder();
    await runReportPass({
      env: {},
      log: rejected.log,
      shouldStop: () => false,
      deps: {
        findDeliverableRequests: async () => { found += 1; return []; },
        processProtocolReport: async (id) => result(id, "held_auto_send_disabled"),
      },
    });
    check("rejected configuration is logged, not thrown",
      rejected.names().join(",") === "report_pass_configuration_rejected", rejected.names().join(","));
    check("…and touches no database", found === 0);

    const failing = recorder();
    let threw = false;
    try {
      await runReportPass({
        env: { ...CREDS },
        log: failing.log,
        shouldStop: () => false,
        resolveConfig: () => ({ ok: true, config: CONFIG }),
        deps: {
          findDeliverableRequests: async () => { throw { message: "relation does not exist", code: "42P01" }; },
          processProtocolReport: async (id) => result(id, "held_auto_send_disabled"),
        },
      });
    } catch {
      threw = true;
    }
    check("a failing lookup never throws out of the pass", !threw);
    check("…and is logged as report_pass_failed",
      failing.names().includes("report_pass_failed")
        && String(failing.last("report_pass_failed")?.message).includes("relation does not exist"));

    let limitSeen = -1;
    const empty = recorder();
    await runReportPass({
      env: {},
      log: empty.log,
      shouldStop: () => false,
      resolveConfig: () => ({ ok: true, config: CONFIG }),
      deps: {
        findDeliverableRequests: async (_c, limit) => { limitSeen = limit ?? -1; return []; },
        processProtocolReport: async () => { throw new Error("must not be called"); },
      },
    });
    check("the lookup is bounded by the pass limit", limitSeen === REPORT_PASS_LIMIT, String(limitSeen));
    check("an empty backlog finishes with found 0",
      empty.last("report_pass_finished")?.found === 0);
    check("the started line says whether auto-send is on",
      empty.last("report_pass_started")?.autoSendEnabled === false);

    const full = recorder();
    const processed: string[] = [];
    await runReportPass({
      env: {},
      log: full.log,
      shouldStop: () => false,
      resolveConfig: () => ({ ok: true, config: CONFIG }),
      deps: {
        findDeliverableRequests: async () => ["r1", "r2"],
        processProtocolReport: async (id) => { processed.push(id); return result(id, "held_auto_send_disabled"); },
      },
    });
    check("every deliverable request is processed", processed.join(",") === "r1,r2");
    check("the pass reports what it did",
      full.last("report_pass_finished")?.found === 2 && full.last("report_pass_finished")?.processed === 2);
  }

  console.log("\n[4] wiring");
  {
    const code = (file: string) => readFileSync(file, "utf8")
      .split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

    const entry = code("scripts/run-protocol-worker.ts");
    const runLiveAt = entry.indexOf("async function runLive");
    const mainAt = entry.indexOf("async function main()");
    const importAt = entry.indexOf('import("@/lib/reports/report-pass")');
    check("the protocol worker loads the report pass dynamically, inside runLive",
      importAt > runLiveAt && importAt < mainAt);
    check("…and never statically",
      !/^import [^;]*"@\/lib\/reports\/report-pass";/m.test(entry));

    const stoppedAt = entry.indexOf('log("worker_stopped"');
    const passAt = entry.indexOf("await runReportPass(");
    check("the pass runs after the scan loop has stopped",
      stoppedAt > 0 && passAt > stoppedAt && passAt < mainAt);
    check("a requested stop skips the pass",
      /if \(signal\.aborted\) \{\s*log\("report_pass_skipped"/.test(entry));
    check("the pass stops when the stop flag is set",
      /shouldStop: \(\) => signal\.aborted/.test(entry));
    check("the disabled path never reaches the report pass",
      !entry.slice(entry.indexOf("async function runDisabled"), runLiveAt).includes("runReportPass"));

    const standalone = code("scripts/run-report-delivery-worker.ts");
    check("the standalone worker uses the shared configuration",
      /resolveReportPassConfig\(process\.env\)/.test(standalone));
    check("…and holds no auto-send rule of its own",
      !standalone.includes("SNAPSHOT_AUTO_DELIVERY_ENABLED ==="));
  }

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
