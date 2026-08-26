#!/usr/bin/env tsx
/**
 * Regression test for lib/evidence/normalize-entity-text.ts (v1) —
 * the sole authoritative implementation of the v1 normalizer, per
 * D-017 §5 and D-019. This test runs every fixture in
 * normalize-entity-text.fixtures.ts against the real function and
 * asserts byte-for-byte equality with the hand-traced expected value.
 *
 * No database, no adapter, no pipeline wiring exists yet — this file
 * tests the normalizer function in isolation only.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });

import { normalizeEntityTextV1 } from "@/lib/evidence/normalize-entity-text";
import { NORMALIZER_V1_FIXTURES } from "@/lib/evidence/normalize-entity-text.fixtures";

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

function fixtureChecks(): void {
  console.log("\n  fixtures — normalizeEntityTextV1");

  for (const fixture of NORMALIZER_V1_FIXTURES) {
    const actual = normalizeEntityTextV1(fixture.input);
    check(
      `[${fixture.category}] ${fixture.description}`,
      actual === fixture.expected,
      `input=${JSON.stringify(fixture.input)} expected=${JSON.stringify(
        fixture.expected
      )} actual=${JSON.stringify(actual)}`
    );
  }
}

function propertyChecks(): void {
  console.log("\n  properties");

  check(
    "is a pure function of its argument — calling it twice on the same input is idempotent",
    normalizeEntityTextV1("Acme Inc.") === normalizeEntityTextV1("Acme Inc.")
  );
  check(
    "normalizing an already-normalized value is a no-op (idempotent under repeated application)",
    (() => {
      const once = normalizeEntityTextV1("Café Inc.");
      const twice = normalizeEntityTextV1(once);
      return once === twice;
    })()
  );
  check(
    "non-string input never throws — returns empty string",
    normalizeEntityTextV1(null as unknown as string) === "" &&
      normalizeEntityTextV1(undefined as unknown as string) === ""
  );
  check(
    "empty string input returns empty string, not an error",
    normalizeEntityTextV1("") === ""
  );
  check(
    "whitespace-only input collapses to empty string",
    normalizeEntityTextV1("   \t  ") === ""
  );
  check(
    "domain-shaped input is never run through legal-suffix stripping — a domain literally ending in a two-letter TLD that happens to also be a suffix-list entry (none currently do, but the branch must be exclusive) is untouched beyond the www. strip",
    normalizeEntityTextV1("www.acme.co") === "acme.co"
  );
  check(
    "the suffix list export is non-empty and includes both the shortest (2-char) and longest (multi-word) entries",
    (() => {
      const list = require("@/lib/evidence/normalize-entity-text")
        .NORMALIZER_V1_LEGAL_SUFFIXES as readonly string[];
      return (
        list.length > 0 &&
        list.includes("ag") &&
        list.includes("pty ltd") &&
        list.includes("s.p.a.")
      );
    })()
  );
}

function main(): void {
  fixtureChecks();
  propertyChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "normalize-entity-text v1 regression PASSED."
        : "normalize-entity-text v1 regression FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
