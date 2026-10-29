/**
 * PG-9 — the harness, offline. Nothing here starts Docker, the Supabase
 * CLI or PostgreSQL.
 *
 *   [1] migration selection: the real supabase/migrations directory yields
 *       exactly 0001-0081 + 0083 (0082 held); the file list and hashes are
 *       printed as the selection proof; every malformed listing is refused;
 *   [2] the network guard: providers, remote hosts and other local ports
 *       are refused and recorded; the stack's loopback ports are let through;
 *   [3] the roster: P1-P15 once each; P8, P9, P13 are limitations (G1, G3,
 *       G4); every case is recorded by the stack script;
 *   [4] the stack script is opt-in: without ZYPACT_PG9_STACK_TEST=1 it runs
 *       neither docker nor supabase, exits 0 and says PG-9 remains open;
 *   [5] its static safety: never links, pushes or targets a remote; clears
 *       inherited credentials and installs the guard before any client;
 *       psql only in its own container; stop --no-backup only on success.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  PG9_API_ORIGIN,
  PG9_CASES,
  PG9_HELD_MIGRATIONS,
  PG9_MIGRATION_NUMBERS,
  installLocalOnlyNetworkGuard,
  isLocalStackDestination,
  selectPg9Migrations,
} from "./pg9-harness";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("\nPG-9 harness, offline (no stack is started)\n");

  /* ═══════ [1] migration selection ═══════ */
  console.log("[1] Migration allowlist");
  const dir = path.join("supabase", "migrations");
  const listing = readdirSync(dir);
  const sel = selectPg9Migrations(listing);
  check("the real directory selects", sel.ok, sel.ok ? "" : sel.reason);
  if (sel.ok) {
    const numbers = sel.files.map((f) => Number(f.slice(0, 4)));
    check("exactly 82 files: 0001-0081 and 0083", sel.files.length === 82
      && numbers.join(",") === PG9_MIGRATION_NUMBERS.join(","), `${sel.files.length}`);
    check("0082 is absent (HOLD), and 0083 is the last", !numbers.includes(82) && numbers[numbers.length - 1] === 83);
    check("nothing is renumbered: each selected file is the repository's own file name",
      sel.files.every((f) => listing.includes(f)));
    const proof = createHash("sha256");
    for (const f of sel.files) proof.update(`${f}\0${createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")}\n`);
    console.log(`  selection: ${sel.files[0]} … ${sel.files[80]}, ${sel.files[81]}`);
    console.log(`  selection proof (sha256 over "name\\0sha256\\n" lines): ${proof.digest("hex")}`);
  }
  check("the held list is exactly [82]", PG9_HELD_MIGRATIONS.join(",") === "82");
  const base = sel.ok ? sel.files : [];
  for (const [label, entries, reason] of [
    ["0082 present", [...base, "0082_m7_post_implementation_deviations.sql"], /HOLD/],
    ["an unlisted 0084", [...base, "0084_future.sql"], /not in the PG-9 allowlist/],
    ["0083 missing", base.filter((f) => !f.startsWith("0083_")), /missing migration number 83/],
    ["0001 missing", base.filter((f) => !f.startsWith("0001_")), /missing migration number 1$/],
    ["a duplicate number", [...base, "0010_duplicate.sql"], /duplicate migration number 10/],
    ["a malformed name", [...base, "10_bad.sql"], /malformed/],
  ] as const) {
    const r = selectPg9Migrations(entries);
    check(`${label} → refused`, !r.ok && reason.test(r.reason), r.ok ? "selected" : r.reason);
  }
  check("non-SQL entries are ignored", selectPg9Migrations([...base, "README.md", ".DS_Store"]).ok);

  /* ═══════ [2] the network guard ═══════ */
  console.log("\n[2] Local-only network guard");
  check("the stack's loopback API is a local destination", isLocalStackDestination("127.0.0.1", 54321));
  for (const [h, p] of [["127.0.0.1", 5432], ["127.0.0.1", 54399], ["10.0.0.1", 54321], ["db.example.supabase.co", 5432], [undefined, 54321]] as const) {
    check(`${h}:${p} is not`, !isLocalStackDestination(h, p));
  }
  {
    const realFetch = globalThis.fetch;
    const guard = installLocalOnlyNetworkGuard();
    try {
      for (const url of ["https://api.perplexity.ai/v1/sonar", "https://api.openai.com/v1/chat/completions",
        "https://abcdefghijklmnopqrst.supabase.co/rest/v1/protocols", "http://127.0.0.1:54399/rest/v1/"]) {
        let refused = false;
        try { await fetch(url); } catch (e) { refused = /network guard: refused/.test(String(e)); }
        check(`fetch ${new URL(url).origin} is refused before leaving`, refused);
      }
      check("each refusal is recorded", guard.blocked.length === 4, guard.blocked.join(","));
      const allowedBefore = guard.allowed();
      try { await fetch(`${PG9_API_ORIGIN}/rest/v1/`); } catch { /* nothing listens here; only the guard's verdict matters */ }
      check("fetch to the stack API is let through", guard.allowed() > allowedBefore && guard.blocked.length === 4);
      for (const [host, port] of [["1.1.1.1", 443], ["127.0.0.1", 5432]] as const) {
        let refused = false;
        try { net.connect({ host, port }).on("error", () => {}); } catch (e) { refused = /network guard: refused/.test(String(e)); }
        check(`a socket to ${host}:${port} is refused`, refused);
      }
      const s = net.connect({ host: "127.0.0.1", port: 54322 });
      s.on("error", () => {});
      check("a socket to a stack port (54322) is let through", !guard.blocked.includes("127.0.0.1:54322"));
      s.destroy();
    } finally {
      guard.restore();
    }
    check("restore puts the original fetch back", globalThis.fetch === realFetch);
  }

  /* ═══════ [3] the roster ═══════ */
  console.log("\n[3] Roster");
  const ids = PG9_CASES.map((c) => c.id);
  check("P1-P15, each exactly once", ids.join(",") === Array.from({ length: 15 }, (_, i) => `P${i + 1}`).join(","), ids.join(","));
  const lim = PG9_CASES.filter((c) => c.kind === "limitation").map((c) => `${c.id}:${c.gap}`);
  check("limitations are exactly P8 (G1), P9 (G3), P13 (G4)", lim.join(",") === "P8:G1,P9:G3,P13:G4", lim.join(","));
  check("every assertion has no gap label", PG9_CASES.filter((c) => c.kind === "assertion").every((c) => c.gap === undefined));
  const stack = readFileSync("scripts/test-pg9-paid-gate-runtime.ts", "utf8");
  for (const id of ids) {
    check(`${id} is recorded by the stack script`, new RegExp(`record\\("${id}",`).test(stack));
  }

  /* ═══════ [4] opt-in only ═══════ */
  console.log("\n[4] Opt-in only");
  {
    const bin = mkdtempSync(path.join(os.tmpdir(), "pg9-stub-bin-"));
    const marker = path.join(bin, "INVOKED");
    try {
      for (const name of ["docker", "supabase"]) {
        writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$0 $@" >> "${marker}"\nexit 0\n`);
        chmodSync(path.join(bin, name), 0o755);
      }
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/test-pg9-paid-gate-runtime.ts"], {
        encoding: "utf8", timeout: 120_000,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_ENV: "test", TZ: "UTC" },
      });
      check("without ZYPACT_PG9_STACK_TEST=1 it exits 0", r.status === 0, `status=${r.status} ${r.stderr.slice(0, 120)}`);
      check("…invokes neither docker nor supabase", !existsSync(marker));
      check("…and says nothing was validated and PG-9 remains open",
        /NOTHING was started, migrated or validated/.test(r.stdout) && /PG-9 remains OPEN/.test(r.stdout), r.stdout.slice(0, 200));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  /* ═══════ [5] static safety of the stack script ═══════ */
  console.log("\n[5] Stack script safety");
  for (const [label, re] of [
    ["links a remote project", /"link"|supabase link/],
    ["pushes or resets against a remote", /"db",\s*"push"|--linked|--db-url|db push/],
    ["names a hosted Supabase URL", /https:\/\/[a-z0-9-]+\.supabase\.(co|in)/],
    ["prunes Docker (a \"prune\" argument to any command)", /"prune"/],
    ["reads a pre-existing credential before clearing it", /process\.env\.(SUPABASE_SERVICE_ROLE_KEY|PERPLEXITY_API_KEY|OPENAI_API_KEY)\s*\?\?/],
  ] as const) {
    check(`it never ${label}`, !re.test(stack));
  }
  const clearAt = stack.indexOf("delete process.env[k]");
  const guardAt = stack.indexOf("const guard = installLocalOnlyNetworkGuard();");
  const dbAt = stack.indexOf('await import("@/lib/db")');
  check("inherited Supabase/provider/paid variables are cleared first", clearAt > 0 && clearAt < guardAt);
  check("the network guard is installed before any client or adapter is loaded", guardAt > 0 && guardAt < dbAt);
  check("the client URL is the stack's loopback API", /process\.env\.NEXT_PUBLIC_SUPABASE_URL = PG9_API_ORIGIN;/.test(stack));
  check("psql runs only in this run's own database container",
    /const container = `supabase_db_\$\{projectId\}`;/.test(stack) && (stack.match(/"exec", "-i", container,/g) ?? []).length === 1
      && !/startsWith\("supabase_db_"\)/.test(stack));
  check("the stack is stopped with --no-backup only on success",
    /if \(success\) \{\s*try \{ run\("supabase", \["stop", "--no-backup", "--workdir", workdir\]\)/.test(stack));
  check("migrations come from the allowlist and are copied, never edited",
    /selectPg9Migrations\(readdirSync\(src\)\)/.test(stack) && /copyFileSync\(path\.join\(src, f\), path\.join\(dst, f\)\)/.test(stack));
  check("the summary reports limitations separately and never as a pass",
    /LIMITATION DEMONSTRATED/.test(stack) && /limitations above are demonstrated gaps, not passes/.test(stack));

  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}`);
  console.log("This suite validates the harness only. PG-9 itself is NOT validated until the stack run is approved and executed.\n");
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
