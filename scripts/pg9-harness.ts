/**
 * PG-9 — the parts of the isolated-PostgreSQL harness that never start a
 * stack, so they can be reviewed and tested offline
 * (scripts/test-pg9-harness-offline.ts). The stack run itself is
 * scripts/test-pg9-paid-gate-runtime.ts, opt-in only.
 *
 *   selectPg9Migrations   the explicit migration allowlist
 *   installLocalOnlyNetworkGuard
 *                          every socket and fetch outside the disposable
 *                          stack's loopback ports is refused and recorded
 *   PG9_CASES             the closed roster, each case classed as an
 *                          `assertion` (must pass) or a `limitation` (the
 *                          test demonstrates a known gap of the gate; it
 *                          must reproduce, and is reported separately)
 */

import net from "node:net";

/**
 * The schema PG-9 validates against: 0001-0081 and 0083. 0082 is on HOLD
 * (Founder decision, 2026-10-29): it exists only on feat/outcome-card-redesign,
 * is not on main, and must not be renumbered. A run refuses if it ever
 * appears, so the plan is revisited rather than silently changed.
 */
export const PG9_MIGRATION_NUMBERS: readonly number[] = [
  ...Array.from({ length: 81 }, (_, i) => i + 1),
  83,
];
export const PG9_HELD_MIGRATIONS: readonly number[] = [82];

export type MigrationSelection =
  | { ok: true; files: string[] }
  | { ok: false; reason: string };

/**
 * Exactly the allowlist, in order, from a directory listing. Fails closed on
 * a malformed name, a duplicate number, a missing expected number, a held
 * number, or any number outside the list. Non-`.sql` entries are ignored.
 */
export function selectPg9Migrations(entries: readonly string[]): MigrationSelection {
  const byNumber = new Map<number, string>();
  for (const e of entries) {
    if (!e.endsWith(".sql")) continue;
    const m = /^(\d{4})_[A-Za-z0-9_]+\.sql$/.exec(e);
    if (!m) return { ok: false, reason: `malformed migration filename: ${e}` };
    const n = Number.parseInt(m[1], 10);
    if (byNumber.has(n)) return { ok: false, reason: `duplicate migration number ${n}` };
    byNumber.set(n, e);
  }
  for (const held of PG9_HELD_MIGRATIONS) {
    if (byNumber.has(held)) return { ok: false, reason: `migration ${held} is on HOLD and must not be present` };
  }
  const expected = new Set(PG9_MIGRATION_NUMBERS);
  for (const n of byNumber.keys()) {
    if (!expected.has(n)) return { ok: false, reason: `migration ${n} is not in the PG-9 allowlist` };
  }
  const files: string[] = [];
  for (const n of PG9_MIGRATION_NUMBERS) {
    const f = byNumber.get(n);
    if (!f) return { ok: false, reason: `missing migration number ${n}` };
    files.push(f);
  }
  return { ok: true, files };
}

/** The disposable stack's API (Kong → PostgREST). The only origin a client may use. */
export const PG9_API_ORIGIN = "http://127.0.0.1:54321";
/** The ports `supabase start` binds for the disposable stack. */
export const PG9_LOCAL_PORTS: readonly number[] = [54321, 54322, 54323, 54324];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface NetworkGuard {
  /** Every refused destination, as `host:port` or a URL origin. */
  readonly blocked: string[];
  /** How many fetches and sockets were let through to the stack. */
  allowed(): number;
  restore(): void;
}

/** Whether a destination is the disposable stack on the loopback. */
export function isLocalStackDestination(host: string | undefined, port: number | undefined): boolean {
  return host !== undefined && LOOPBACK.has(host) && port !== undefined && PG9_LOCAL_PORTS.includes(port);
}

/**
 * Replaces globalThis.fetch and net.Socket.prototype.connect for this
 * process. A fetch is allowed only to PG9_API_ORIGIN; a socket only to a
 * loopback host on a PG9 port. Anything else — a provider, a remote
 * Supabase, any other port — throws before a byte leaves, and is recorded.
 * Child processes (`docker exec psql`) are not network calls from here and
 * are not affected.
 */
export function installLocalOnlyNetworkGuard(): NetworkGuard {
  const blocked: string[] = [];
  let allowed = 0;
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.origin !== PG9_API_ORIGIN) {
      blocked.push(url.origin);
      throw new Error(`PG-9 network guard: refused ${url.origin}`);
    }
    allowed += 1;
    return realFetch(input, init);
  }) as typeof fetch;

  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    // net.connect() and undici pass Node's already-normalised [options, cb]
    // array as the single argument; a direct call passes options or a port.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let port: number | undefined;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const o = first as { host?: string; port?: number | string; path?: string };
      if (typeof o.path === "string") {
        // A local IPC socket is not network traffic.
        allowed += 1;
        return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
      }
      host = o.host ?? "localhost";
      port = o.port === undefined ? undefined : Number(o.port);
    } else if (typeof first === "number" || typeof first === "string") {
      port = Number(first);
      host = typeof args[1] === "string" ? (args[1] as string) : "localhost";
    }
    if (!isLocalStackDestination(host, port)) {
      blocked.push(`${host ?? "?"}:${port ?? "?"}`);
      throw new Error(`PG-9 network guard: refused ${host ?? "?"}:${port ?? "?"}`);
    }
    allowed += 1;
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  return {
    blocked,
    allowed: () => allowed,
    restore: () => {
      globalThis.fetch = realFetch;
      net.Socket.prototype.connect = realConnect;
    },
  };
}

export type CaseKind = "assertion" | "limitation";

export interface Pg9Case {
  id: string;
  kind: CaseKind;
  title: string;
  /** For a limitation: which documented gap it demonstrates. */
  gap?: "G1" | "G3" | "G4";
}

/**
 * The closed roster. An `assertion` must pass. A `limitation` must
 * REPRODUCE the gap it names; it is reported as a demonstrated limitation,
 * never as a pass, and a limitation that fails to reproduce fails the run
 * (the harness's model of the gate would then be wrong).
 */
export const PG9_CASES: readonly Pg9Case[] = [
  { id: "P1", kind: "assertion", title: "missing or invalid configuration refuses with zero stack requests" },
  { id: "P2", kind: "assertion", title: "the last-24-hour ledger total, by cost basis, against the database clock" },
  { id: "P3", kind: "assertion", title: "the largest eligible cap: queued and claimed/running with attempts left only" },
  { id: "P4", kind: "assertion", title: "the ceiling boundary: equal is allowed, above is refused" },
  { id: "P5", kind: "assertion", title: "a refusal leaves jobs, attempts, calls and receipts byte-identical" },
  { id: "P6", kind: "assertion", title: "an allowed claim runs once; its spend is in the next read, which can refuse" },
  { id: "P7", kind: "assertion", title: "an expired lease with attempts left counts and is claimed; an exhausted job is swept" },
  { id: "P8", kind: "limitation", gap: "G1", title: "concurrent workers both pass one read and claim two jobs" },
  { id: "P9", kind: "limitation", gap: "G3", title: "the queue changes between read and claim; the oldest eligible job claimed was never read" },
  { id: "P10", kind: "assertion", title: "service-role read failures refuse, each isolated and restored" },
  { id: "P11", kind: "assertion", title: "an incomplete ledger window (more rows than the read limit) refuses" },
  { id: "P12", kind: "assertion", title: "a job queue larger than the API's max_rows refuses (C1)" },
  { id: "P13", kind: "limitation", gap: "G4", title: "a worker clock ahead of the database undercounts the window edge" },
  { id: "P14", kind: "assertion", title: "database constraints reject invalid rows; real PostgREST values parse" },
  { id: "P15", kind: "assertion", title: "the per-protocol spend cap still refuses admission in SQL" },
];
