#!/usr/bin/env tsx
/**
 * Founder-operated ad-hoc evidence probe.
 *
 * Sends ONE exact buyer question to Perplexity Sonar, N times, and writes a
 * complete evidence file: every attempt's exact outbound body, exact response
 * bytes, both SHA-256 digests, HTTP status, latency, provider request id, and
 * every failure and retry. Nothing is paraphrased and nothing is summarised.
 *
 * What this is NOT. It is not the V1 protocol path: it touches no database,
 * creates no question/protocol identity, reserves no spend, and produces no
 * client report artifact. It is the manual evidence run a founder can defend
 * in writing while the protocol path is still undeployed. Anything sent to a
 * prospect off the back of this must be labelled as a founder-operated
 * directional snapshot on one surface, never as a pilot baseline.
 *
 * It also computes NO verdict. `won`/`partial`/`lost` are not V1 semantics
 * (D-001/D-002), so this reports raw term occurrences and leaves reading the
 * answer to a human. The only derived numbers are counts and a Wilson
 * interval over "answer contained a brand term", which is a presence rate on
 * one surface and nothing more.
 *
 * Usage:
 *   npx tsx scripts/run-adhoc-evidence-probe.ts --preflight
 *   npx tsx scripts/run-adhoc-evidence-probe.ts \
 *     --question "Which tools help security teams see what AI agents can access and control that access?" \
 *     --brand-terms "Cymphony,cymphony.ai" \
 *     --runs 5 \
 *     --confirm-spend
 *
 * Flags:
 *   --preflight       Check the endpoint only. Sends one deliberately invalid
 *                     body: a 400 proves the path exists, a 404 proves it does
 *                     not. Never charged, and no paid run follows.
 *   --confirm-spend   Required before any real call. Without it the script
 *                     prints the plan and exits 0 without contacting anyone.
 *   --question TEXT   Exact question. Sent verbatim, byte for byte.
 *   --question-file F Read the question from a file instead (avoids shell
 *                     mangling of quotes, apostrophes and smart punctuation).
 *   --brand-terms L   Comma-separated terms to scan for. Scanning only.
 *                     NEVER sent to the provider.
 *   --runs N          Default 5, matching migration 0069's approved baseline
 *                     plan, so this run stays comparable to a future protocol.
 *   --max-retries N   Per run, on a failed attempt. Default 2, matching the
 *                     protocol retry_cap.
 *   --out DIR         Default output/adhoc-evidence/<utc-timestamp>/.
 *
 * Env:
 *   PERPLEXITY_API_KEY  required. Never read into the output, never logged.
 *   PERPLEXITY_MODEL    optional; default `sonar`. Recorded in the evidence.
 */

// `dotenv/config` alone reads `.env` and NOTHING else, so a key that lives in
// `.env.local` — where Next.js looks, and where this repo's own
// `scripts/run-with-env.py` looks — is invisible to a bare tsx run. Load them
// explicitly, in Next.js precedence order: a variable already exported in the
// shell wins, then `.env.local`, then `.env`. `config()` never overwrites a
// value already present, so listing `.env.local` first is what makes it win.
import { config as loadEnvFile } from "dotenv";
loadEnvFile({ path: ".env.local" });
loadEnvFile();

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  PERPLEXITY_ENDPOINT,
  PerplexityProbeFailure,
  runPerplexityProbe,
} from "@/lib/probes/perplexity";
import { sha256Hex } from "@/lib/evidence/hash";

/* ------------------------------------------------------------------ */
/* Argument parsing                                                     */
/* ------------------------------------------------------------------ */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

function intOption(name: string, fallback: number): number {
  const raw = option(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Evidence shapes                                                      */
/* ------------------------------------------------------------------ */

interface AttemptEvidence {
  attemptOrdinal: number;
  runOrdinal: number;
  /** null when this is a run's first attempt; otherwise the attempt it retries. */
  retryOfAttemptOrdinal: number | null;
  outcome: "succeeded" | "failed";
  startedAt: string;
  completedAt: string;
  latencyMs: number | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  /** Exact JSON body sent on the wire, and its digest. */
  requestBody: string | null;
  requestBodySha256: string | null;
  /** Exact response bytes as received, and their digest. */
  responseBody: string | null;
  responseBodySha256: string | null;
  /** Present only on success. */
  model: string | null;
  answer: string | null;
  citations: string[] | null;
  searchResults: unknown[] | null;
  /** Present only on failure. */
  failureReason: string | null;
  failureMessage: string | null;
}

interface BrandScan {
  term: string;
  attemptsMentioningInAnswer: number;
  attemptsMentioningInCitations: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary-ish match, matching the convention already used by
 * `lib/pipeline/run-live-perplexity-probes.ts` so a term counted here is
 * counted the same way the pipeline would count it.
 */
function mentions(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Wilson 95% interval — the same method the protocol report uses
 * (`intervalMethod: "wilson_95"`), so this run's uncertainty is expressed on
 * the same scale as a future protocol baseline rather than a second one.
 */
function wilson95(numerator: number, denominator: number): { low: number; high: number } | null {
  if (denominator <= 0) return null;
  const z = 1.959963984540054;
  const p = numerator / denominator;
  const d = 1 + (z * z) / denominator;
  const centre = p + (z * z) / (2 * denominator);
  const spread = z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator * denominator));
  return {
    low: Math.max(0, (centre - spread) / d),
    high: Math.min(1, (centre + spread) / d),
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Explains a missing key precisely, without ever revealing one.
 *
 * "Set the variable" is useless advice when the variable IS set and something
 * else is wrong — the wrong file, a stray quote, a BOM that swallows the first
 * key. This inspects the env files for the KEY NAME only and never reads,
 * prints, measures or hashes a value.
 */
function reportMissingKey(): void {
  console.error("PERPLEXITY_API_KEY is not set.");
  console.error("");

  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) {
      console.error(`  ${file}: not present`);
      continue;
    }
    const raw = readFileSync(file, "utf8");
    const hasBom = raw.charCodeAt(0) === 0xfeff;
    const named = raw
      .split(/\r?\n/)
      .some((line) => /^\s*(export\s+)?PERPLEXITY_API_KEY\s*=/.test(line));

    console.error(`  ${file}: present, PERPLEXITY_API_KEY ${named ? "IS" : "is NOT"} declared${hasBom ? " — WARNING: file starts with a BOM, which hides the first key from dotenv" : ""}`);
  }

  console.error("");
  console.error("Most common causes, in order:");
  console.error("  1. The key is in .env.local but the line is commented out with #.");
  console.error("  2. The name is misspelled (PERPLEXITY_KEY, PPLX_API_KEY, …).");
  console.error("  3. The value is split across lines, or wrapped in mismatched quotes.");
  console.error("  4. The file has a BOM — re-save it as UTF-8 without BOM.");
  console.error("");
  console.error("Never paste the key into a terminal, a commit, or a chat.");
}

/* ------------------------------------------------------------------ */
/* Preflight                                                            */
/* ------------------------------------------------------------------ */

/**
 * Settles the one open question about the transport: does
 * `PERPLEXITY_ENDPOINT` exist?
 *
 * Every committed test injects its own `fetchImpl`, so no test has ever
 * exercised the real path. An unauthenticated probe cannot answer it either —
 * Perplexity returns 401 for every path, valid or not, because it
 * authenticates before it routes. So this sends a real key with a
 * deliberately invalid body: a routed request fails validation (4xx that is
 * not 404), an unrouted one is 404. An invalid body is not a completion and
 * is not billed.
 */
async function preflight(): Promise<number> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    reportMissingKey();
    return 1;
  }

  console.log(`Preflight — POST ${PERPLEXITY_ENDPOINT} with an intentionally invalid body.`);
  const res = await fetch(PERPLEXITY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: "{}",
  });
  const body = await res.text();

  console.log(`HTTP ${res.status}`);
  console.log(`body: ${body.slice(0, 400)}`);
  console.log("");

  if (res.status === 404) {
    console.error("VERDICT: the endpoint does NOT exist. Every live probe would fail as http_error.");
    console.error("Fix lib/probes/perplexity.ts PERPLEXITY_ENDPOINT before running anything paid.");
    return 2;
  }
  if (res.status === 401 || res.status === 403) {
    console.error("VERDICT: inconclusive — the key was rejected, so routing was never reached.");
    console.error("Check PERPLEXITY_API_KEY is a live key with credit, then re-run.");
    return 3;
  }
  console.log("VERDICT: the endpoint exists and routed the request. Safe to proceed to a paid run.");
  return 0;
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  if (flag("preflight")) return preflight();

  const questionFile = option("question-file");
  const question = (questionFile ? readFileSync(questionFile, "utf8") : option("question") ?? "").trim();
  if (!question) {
    console.error("Supply --question \"...\" or --question-file PATH.");
    return 1;
  }

  const brandTerms = (option("brand-terms") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const runs = intOption("runs", 5);
  const maxRetries = intOption("max-retries", 2);
  const model = process.env.PERPLEXITY_MODEL || "sonar";

  const startedAtIso = new Date().toISOString();
  const outDir =
    option("out") ??
    path.join("output", "adhoc-evidence", startedAtIso.replace(/[:.]/g, "-"));

  // Printed before anything is sent, so the operator sees the exact wording
  // and the exact spend shape before authorising either.
  console.log("Ad-hoc evidence probe — plan");
  console.log(`  endpoint     : ${PERPLEXITY_ENDPOINT}`);
  console.log(`  model        : ${model}`);
  console.log(`  runs         : ${runs}`);
  console.log(`  max retries  : ${maxRetries} per run`);
  console.log(`  max calls    : ${runs * (1 + maxRetries)}`);
  console.log(`  brand terms  : ${brandTerms.length > 0 ? brandTerms.join(", ") : "(none)"} — scanned locally, never sent`);
  console.log(`  output       : ${outDir}`);
  console.log("  question (sent verbatim, nothing prepended or appended):");
  console.log(`    ${question}`);
  console.log("");

  if (!flag("confirm-spend")) {
    console.log("No call made. Re-run with --confirm-spend to execute.");
    return 0;
  }
  if (!process.env.PERPLEXITY_API_KEY) {
    reportMissingKey();
    return 1;
  }

  const attempts: AttemptEvidence[] = [];
  let attemptOrdinal = 0;

  for (let run = 1; run <= runs; run += 1) {
    let firstAttemptOfRun: number | null = null;

    for (let tryIndex = 0; tryIndex <= maxRetries; tryIndex += 1) {
      attemptOrdinal += 1;
      const startedAt = new Date().toISOString();

      try {
        const result = await runPerplexityProbe({
          prompt: question,
          // Never reaches the wire — `buildUserPrompt` sends `prompt` alone.
          // Kept empty so a future change that did start using it would send
          // nothing identifying rather than a real brand name.
          brandName: "",
        });

        attempts.push({
          attemptOrdinal,
          runOrdinal: run,
          retryOfAttemptOrdinal: firstAttemptOfRun,
          outcome: "succeeded",
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: result.latencyMs ?? null,
          httpStatus: result.httpStatus ?? null,
          providerRequestId: result.providerRequestId ?? null,
          requestBody: result.fullRequestBody ?? null,
          requestBodySha256: result.fullRequestBodySha256 ?? null,
          responseBody: result.rawResponseBody ?? null,
          responseBodySha256: result.rawResponseBodySha256 ?? null,
          model: result.model,
          answer: result.answer,
          citations: result.citations,
          searchResults: result.searchResults,
          failureReason: null,
          failureMessage: null,
        });

        console.log(`run ${run} attempt ${attemptOrdinal}: ok (${result.latencyMs ?? "?"}ms, ${result.citations.length} citations)`);
        break;
      } catch (err) {
        const failure = err instanceof PerplexityProbeFailure ? err : null;

        attempts.push({
          attemptOrdinal,
          runOrdinal: run,
          retryOfAttemptOrdinal: firstAttemptOfRun,
          outcome: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: failure?.latencyMs ?? null,
          httpStatus: failure?.httpStatus ?? null,
          providerRequestId: failure?.providerRequestId ?? null,
          requestBody: failure?.fullRequestBody ?? null,
          requestBodySha256: failure?.fullRequestBodySha256 ?? null,
          responseBody: failure?.errorBody ?? null,
          responseBodySha256: failure?.errorBodySha256 ?? null,
          model: null,
          answer: null,
          citations: null,
          searchResults: null,
          failureReason: failure?.reason ?? "unknown_error",
          failureMessage: err instanceof Error ? err.message : String(err),
        });

        console.log(`run ${run} attempt ${attemptOrdinal}: FAILED (${failure?.reason ?? "unknown"}, HTTP ${failure?.httpStatus ?? "-"})`);

        // The first attempt of a run becomes the anchor every later attempt
        // of that run is recorded as retrying, so the retry relationship is
        // never inferred from ordering alone.
        if (firstAttemptOfRun === null) firstAttemptOfRun = attemptOrdinal;
      }
    }
  }

  /* ---------------- reconciliation and scanning ---------------- */

  const succeeded = attempts.filter((a) => a.outcome === "succeeded");
  const failed = attempts.filter((a) => a.outcome === "failed");
  const retried = attempts.filter((a) => a.retryOfAttemptOrdinal !== null);
  const runsWithAResult = new Set(succeeded.map((a) => a.runOrdinal));

  const brandScan: BrandScan[] = brandTerms.map((term) => ({
    term,
    attemptsMentioningInAnswer: succeeded.filter((a) => mentions(a.answer ?? "", term)).length,
    attemptsMentioningInCitations: succeeded.filter((a) =>
      (a.citations ?? []).some((c) => mentions(c, term))
    ).length,
  }));

  const anyTermPresent = succeeded.filter((a) =>
    brandTerms.some((t) => mentions(a.answer ?? "", t))
  ).length;
  const interval = brandTerms.length > 0 ? wilson95(anyTermPresent, succeeded.length) : null;

  const evidence = {
    evidenceVersion: 1,
    kind: "founder_operated_adhoc_probe",
    generatedAt: new Date().toISOString(),
    startedAt: startedAtIso,
    question: { text: question, sha256: sha256Hex(question) },
    transport: { endpoint: PERPLEXITY_ENDPOINT, requestedModel: model },
    plan: { runs, maxRetriesPerRun: maxRetries, maxCalls: runs * (1 + maxRetries) },
    reconciliation: {
      attempted: attempts.length,
      succeeded: succeeded.length,
      failed: failed.length,
      retried: retried.length,
      runsPlanned: runs,
      runsWithAResult: runsWithAResult.size,
      accountedFor: succeeded.length + failed.length === attempts.length,
    },
    brandScan,
    presenceRate:
      brandTerms.length > 0
        ? {
            metric: "answer_contains_any_brand_term",
            numerator: anyTermPresent,
            denominator: succeeded.length,
            rate: succeeded.length > 0 ? anyTermPresent / succeeded.length : null,
            interval,
            intervalMethod: "wilson_95",
          }
        : null,
    attempts,
    limitations: [
      "One provider surface (Perplexity Sonar). Not representative of all AI assistants or all buyers.",
      "Founder-operated manual run. Not a registered protocol, not a pilot baseline, no reserved spend, no immutable database evidence.",
      "No causal claim. This shows what one surface answered at one moment, not why, and not any effect on a sale.",
      "Term scanning is literal string matching on the answer text. It does not judge sentiment, accuracy or how favourably anything is described.",
      "Provider answers are nondeterministic; repeated identical runs estimate a presence rate under that nondeterminism, not coverage across phrasings.",
    ],
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");

  /* ---------------- human-readable companion ---------------- */

  const md: string[] = [
    "# Ad-hoc evidence probe",
    "",
    "Founder-operated directional snapshot on one AI surface. Not a pilot baseline.",
    "",
    `- Generated: ${evidence.generatedAt}`,
    `- Endpoint: \`${PERPLEXITY_ENDPOINT}\``,
    `- Requested model: \`${model}\``,
    `- Question SHA-256: \`${evidence.question.sha256}\``,
    "",
    "## Question, exactly as sent",
    "",
    "```text",
    question,
    "```",
    "",
    "## Attempt reconciliation",
    "",
    `| Planned runs | Attempted | Succeeded | Failed | Retries | Runs with a result |`,
    `|---|---|---|---|---|---|`,
    `| ${runs} | ${attempts.length} | ${succeeded.length} | ${failed.length} | ${retried.length} | ${runsWithAResult.size} |`,
    "",
  ];

  if (evidence.presenceRate) {
    const r = evidence.presenceRate;
    md.push(
      "## Presence rate",
      "",
      `\`${r.metric}\`: **${r.numerator} of ${r.denominator}**` +
        (r.rate !== null ? ` (${pct(r.rate)})` : "") +
        (r.interval ? `, 95% Wilson interval ${pct(r.interval.low)}–${pct(r.interval.high)}` : ""),
      "",
      "The interval is wide at small sample sizes. Read it, not the point estimate.",
      "",
      "| Term | Answers mentioning | Citations mentioning |",
      "|---|---|---|",
      ...brandScan.map((b) => `| ${b.term} | ${b.attemptsMentioningInAnswer}/${succeeded.length} | ${b.attemptsMentioningInCitations}/${succeeded.length} |`),
      ""
    );
  }

  for (const a of attempts) {
    md.push(
      `## Attempt ${a.attemptOrdinal} — run ${a.runOrdinal}${a.retryOfAttemptOrdinal !== null ? ` (retry of attempt ${a.retryOfAttemptOrdinal})` : ""}`,
      "",
      `- Outcome: **${a.outcome}**`,
      `- Started: ${a.startedAt}`,
      `- Completed: ${a.completedAt}`,
      `- HTTP status: ${a.httpStatus ?? "—"}`,
      `- Latency: ${a.latencyMs ?? "—"} ms`,
      `- Provider request id: ${a.providerRequestId ?? "—"}`,
      `- Model reported: ${a.model ?? "—"}`,
      `- Request body SHA-256: \`${a.requestBodySha256 ?? "—"}\``,
      `- Response body SHA-256: \`${a.responseBodySha256 ?? "—"}\``,
      ""
    );

    if (a.requestBody) {
      md.push("### Exact request body sent", "", "```json", a.requestBody, "```", "");
    }
    if (a.outcome === "succeeded") {
      md.push("### Full answer, verbatim", "", "```text", a.answer ?? "", "```", "");
      md.push("### Cited sources", "");
      if ((a.citations ?? []).length === 0) {
        md.push("None returned.", "");
      } else {
        md.push(...(a.citations ?? []).map((c, i) => `${i + 1}. ${c}`), "");
      }
    } else {
      md.push(
        "### Failure",
        "",
        `- Reason: \`${a.failureReason}\``,
        `- Message: ${a.failureMessage}`,
        "",
        "```text",
        (a.responseBody ?? "").slice(0, 4000),
        "```",
        ""
      );
    }
  }

  md.push("## Limitations", "", ...evidence.limitations.map((l) => `- ${l}`), "");

  writeFileSync(path.join(outDir, "report.md"), md.join("\n"), "utf8");

  console.log("");
  console.log(`Evidence written to ${outDir}`);
  console.log("  · evidence.json — complete machine-readable record of every attempt");
  console.log("  · report.md     — human-readable, full answers and sources verbatim");
  console.log("");
  console.log(`attempted ${attempts.length} / succeeded ${succeeded.length} / failed ${failed.length} / retries ${retried.length}`);

  // A run where nothing succeeded is a failed run, and the exit code has to
  // say so — an evidence file full of failures is not a result.
  return succeeded.length > 0 ? 0 : 1;
}

// `process.exit()` tears the loop down while undici's keep-alive socket is
// still closing, which trips a libuv assertion on Windows and prints a crash
// banner after a perfectly good run. Every write above is synchronous and
// already flushed, so there is nothing to wait for: set the code and let Node
// exit on its own once the socket pool goes idle.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  });
