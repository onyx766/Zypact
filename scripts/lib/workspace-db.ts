/**
 * Shared helpers for the P1/P2 workspace database tests. They talk to a
 * DISPOSABLE Supabase Postgres container (named zp-*) through `docker exec
 * psql`, as created by scripts/run-p2-workspace-db-local.sh.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

export type Role = "supabase_admin" | "service_role" | "anon" | "authenticated";

/** Exits SKIP (2) without a container and STOP (4) for a non-disposable name. */
export function requireContainer(): string {
  const name = process.env.ZYPACT_P2_DB_CONTAINER;
  if (!name) {
    console.log("SKIP: set ZYPACT_P2_DB_CONTAINER (see scripts/run-p2-workspace-db-local.sh).");
    process.exit(2);
  }
  if (!/^zp-[a-z0-9-]+$/.test(name)) {
    console.error("STOP: ZYPACT_P2_DB_CONTAINER must name a disposable zp-* container.");
    process.exit(4);
  }
  return name;
}

export function makeChecker() {
  const state = { failures: 0, total: 0 };
  const check = (label: string, ok: boolean, detail = ""): void => {
    state.total += 1;
    if (ok) console.log(`  ✓ ${label}`);
    else {
      state.failures += 1;
      console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const finish = (): never => {
    console.log(`\n${state.total - state.failures}/${state.total} passed`);
    process.exit(state.failures === 0 ? 0 : 1);
  };
  return { check, finish };
}

/** A dollar-quoted literal; refuses content that could close the quote. */
export function lit(value: string | null): string {
  if (value === null) return "null";
  if (value.includes("$zq$")) throw new Error("literal contains its own quote tag");
  return `$zq$${value}$zq$`;
}

export function db(container: string) {
  const psql = (sql: string, role: Role = "service_role"): string => {
    const prefix = role === "supabase_admin" ? "" : `set role ${role};\n`;
    return execFileSync(
      "docker",
      ["exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"],
      { input: prefix + sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  };
  const fails = (sql: string, role: Role = "service_role"): string | null => {
    try {
      psql(sql, role);
      return null;
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? error);
    }
  };
  return { psql, fails };
}

export const row = (out: string) => out.split("|");

export interface Tenant {
  accountId: string;
  token: string;
}

export const who = (t: Tenant) => `${lit(t.token)}, ${lit(t.accountId)}::uuid`;

/** A workspace with one owner and an open account session; optionally its website. */
export function makeTenant(psql: ReturnType<typeof db>["psql"], name: string, domain: string | null): Tenant {
  const accountId = randomUUID();
  const token = randomBytes(32).toString("hex");
  psql(
    `select status from public.create_workspace_with_owner(${lit(accountId)}::uuid, ${lit(name)}, ${lit(randomUUID())}, 'system', null, 'p2.test', '1');`,
    "supabase_admin"
  );
  const opened = psql(`select status from public.open_account_session(${lit(accountId)}::uuid, ${lit(token)}, 3600, 1800);`);
  if (opened !== "OPENED") throw new Error(`session not opened: ${opened}`);
  if (domain) {
    const site = psql(`select status from public.set_workspace_website(${lit(token)}, ${lit(accountId)}::uuid, ${lit(domain)}, ${lit(name)});`);
    if (site !== "SET") throw new Error(`website not set: ${site}`);
  }
  return { accountId, token };
}
