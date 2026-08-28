#!/usr/bin/env tsx
/**
 * 0057 — real PostgreSQL 17 runtime contract.
 *
 * Opt-in: does nothing without ZYPACT_M0_0057_RUNTIME_TEST=1. Creates a
 * disposable local container, applies migrations 0001-0056, snapshots the
 * privilege and structure surface, applies 0057, and proves the
 * properties only a real database can settle: that the dangerous matrix
 * actually empties, that every legitimate DML grant survives byte for
 * byte, that a table created afterwards inherits nothing dangerous, and
 * that nothing else — RLS, policies, functions, constraints, rows —
 * moved.
 *
 * No remote credential. No provider call. No staging, no Production.
 * Cleanup runs only after full success; on failure the container is left
 * up and its name printed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

if (process.env.ZYPACT_M0_0057_RUNTIME_TEST !== "1") {
  console.log("SKIP: set ZYPACT_M0_0057_RUNTIME_TEST=1 to run the 0057 runtime contract.");
  process.exit(0);
}

const IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.155";
const CONTAINER = "zypact-0057-runtime";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

let checks = 0;
const failures: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, {
    input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Every query below reads catalogs or fixture rows only. Never a write. */
function psql(sql: string): string {
  return docker(["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-tAF|",
    "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

function exec(sql: string): void {
  docker(["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-q",
    "-v", "ON_ERROR_STOP=1"], sql);
}

const ROLES = ["anon", "authenticated", "service_role"];
const DANGEROUS = ["TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN"];
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];

function matrix(privs: string[]): string {
  return psql(`
    select r.rolname || '|' || c.relname || '|' || p.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    cross join (values ${privs.map((p) => `('${p}')`).join(",")}) p(priv)
    cross join (values ${ROLES.map((r) => `('${r}')`).join(",")}) r(rolname)
    where c.relkind = 'r'
      and has_table_privilege(r.rolname, c.oid, p.priv)
    order by 1`);
}

const structure = () => ({
  rls: psql(`select c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname='public' and c.relkind='r' order by 1`),
  policies: psql(`select tablename||'|'||policyname||'|'||cmd||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'')
                  from pg_policies where schemaname='public' order by 1`),
  functions: psql(`select p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||md5(p.prosrc)
                   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                   where n.nspname='public' order by 1`),
  constraints: psql(`select conrelid::regclass::text||'|'||conname||'|'||pg_get_constraintdef(c.oid)
                     from pg_constraint c join pg_namespace n on n.oid=c.connamespace
                     where n.nspname='public' order by 1`),
  columns: psql(`select table_name||'|'||column_name||'|'||data_type||'|'||is_nullable
                 from information_schema.columns where table_schema='public' order by 1`),
});

function sentinel(name: string): string {
  exec(`create table public.${name}(id int);`);
  const acl = psql(`
    select r.rolname || '|' || p.priv
    from (values ${DANGEROUS.map((p) => `('${p}')`).join(",")}) p(priv)
    cross join (values ${ROLES.map((r) => `('${r}')`).join(",")}) r(rolname)
    where has_table_privilege(r.rolname, 'public.${name}'::regclass, p.priv)
    order by 1`);
  exec(`drop table public.${name};`);
  return acl;
}

let ok = false;
try {
  try { docker(["rm", "-f", CONTAINER]); } catch { /* not running */ }
  console.log("Starting the disposable stack...");
  docker(["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=disposable",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE]);

  let stable = 0;
  for (let i = 0; i < 90 && stable < 3; i += 1) {
    try { psql("select 1"); stable += 1; } catch { stable = 0; }
    if (stable < 3) execFileSync("perl", ["-e", "select undef,undef,undef,2"]);
  }
  if (stable < 3) throw new Error("PostgreSQL never became stable");

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const upTo56 = files.filter((f) => !f.startsWith("0057"));
  const only57 = files.filter((f) => f.startsWith("0057"));
  assert("exactly one 0057 migration on disk", only57.length === 1, `${only57.length}`);
  console.log(`Applying ${upTo56.length} migrations (0001-0056)...`);
  for (const f of upTo56) exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));

  // Fixture rows, so "no data modified" is a real assertion and not a
  // vacuous one on an empty table. `projects` is one of the 18 tables.
  exec(`insert into public.projects (domain, company_name, category) values
        ('fixture-one.example','Fixture One','fixture'),
        ('fixture-two.example','Fixture Two','fixture'),
        ('fixture-three.example','Fixture Three','fixture');`);
  const rowsBefore = psql(`select md5(string_agg(t::text, '|' order by t.domain)) || '|' || count(*)
                           from public.projects t`);

  // ---------------------------------------------------------- before
  const dangerBefore = matrix(DANGEROUS);
  const dmlBefore = matrix(DML);
  const structBefore = structure();
  const sentinelBefore = sentinel("zz_sentinel_before");
  const defaclBefore = psql(`select coalesce(defaclacl::text,'') from pg_default_acl d
                             join pg_namespace n on n.oid = d.defaclnamespace
                             where n.nspname='public' and d.defaclobjtype='r'
                               and d.defaclrole = 'postgres'::regrole`);
  const defaclOtherBefore = psql(`select coalesce(string_agg(defaclacl::text, '|' order by defaclobjtype::text), '')
                                  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
                                  where n.nspname='public' and d.defaclobjtype <> 'r'`);

  assert("pre-0057: the dangerous residue is present",
    dangerBefore.split("\n").filter(Boolean).length > 0,
    `${dangerBefore.split("\n").filter(Boolean).length} entries`);
  assert("pre-0057: a fresh table inherits the dangerous privileges",
    sentinelBefore.split("\n").filter(Boolean).length > 0,
    `${sentinelBefore.split("\n").filter(Boolean).length} entries`);

  // ----------------------------------------------------------- apply
  console.log("Applying 0057...");
  const sql57 = readFileSync(path.join(MIGRATIONS, only57[0]), "utf8");
  exec(sql57);

  // ----------------------------------------------------------- after
  const dangerAfter = matrix(DANGEROUS);
  const dmlAfter = matrix(DML);
  const structAfter = structure();
  const sentinelAfter = sentinel("zz_sentinel_after");
  const rowsAfter = psql(`select md5(string_agg(t::text, '|' order by t.domain)) || '|' || count(*)
                          from public.projects t`);

  assert("dangerous matrix is empty for all three roles",
    dangerAfter === "", `${dangerAfter.split("\n").filter(Boolean).length} entries remain`);

  // MAINTAIN travels through the version-guarded DO block, not a flat
  // statement, so assert its removal on its own: a guard that silently
  // failed to fire would otherwise hide inside the aggregate above.
  const maintainBefore = dangerBefore.split("\n").filter((l) => l.endsWith("|MAINTAIN")).length;
  const maintainAfter = dangerAfter.split("\n").filter((l) => l.endsWith("|MAINTAIN")).length;
  assert("PG17 guard fired: MAINTAIN was present before 0057",
    maintainBefore > 0, `${maintainBefore} entries`);
  assert("PG17 guard fired: MAINTAIN revoked everywhere after 0057",
    maintainAfter === 0, `${maintainAfter} entries remain`);
  assert("the fixture really is PostgreSQL 17 or later",
    Number(psql("select current_setting('server_version_num')")) >= 170000,
    psql("select current_setting('server_version_num')"));
  assert("DML matrix byte-identical before and after",
    dmlAfter === dmlBefore,
    `${dmlBefore.split("\n").filter(Boolean).length} -> ${dmlAfter.split("\n").filter(Boolean).length}`);
  assert("a table created after 0057 inherits nothing dangerous",
    sentinelAfter === "", sentinelAfter.replace(/\n/g, " "));

  assert("RLS flags unchanged", structAfter.rls === structBefore.rls);
  assert("policies unchanged", structAfter.policies === structBefore.policies);
  assert("function bodies unchanged", structAfter.functions === structBefore.functions);
  assert("constraints unchanged", structAfter.constraints === structBefore.constraints);
  assert("columns unchanged", structAfter.columns === structBefore.columns);
  assert("no row modified in the seeded table", rowsAfter === rowsBefore, `${rowsBefore} -> ${rowsAfter}`);

  // Default ACL, asserted letter by letter rather than assumed. In the
  // aclitem alphabet D=TRUNCATE, x=REFERENCES, t=TRIGGER, m=MAINTAIN and
  // a=INSERT r=SELECT w=UPDATE d=DELETE. The requirement is that no role
  // keeps any of the four dangerous letters, and that every DML letter a
  // role held before survives — not that the entry disappears, which is
  // only true when the four were all it had.
  const defaclNow = psql(`select coalesce(defaclacl::text,'') from pg_default_acl d
                          join pg_namespace n on n.oid = d.defaclnamespace
                          where n.nspname='public' and d.defaclobjtype='r'
                            and d.defaclrole = 'postgres'::regrole`);
  const letters = (acl: string, role: string): string => {
    const m = new RegExp(`(?:^|[,{])${role}=([a-zA-Z*]*)/`).exec(acl);
    return m ? m[1].replace(/\*/g, "") : "";
  };
  for (const role of ROLES) {
    const after = letters(defaclNow, role);
    const before = letters(defaclBefore, role);
    assert(`default ACL: ${role} keeps no dangerous letter`,
      !/[Dxtm]/.test(after), `${role}=${after || "(absent)"}`);
    assert(`default ACL: ${role} keeps every DML letter it had`,
      [...before.replace(/[Dxtm]/g, "")].every((c) => after.includes(c)),
      `${before} -> ${after}`);
  }
  assert("default ACL for sequences and functions untouched",
    psql(`select coalesce(string_agg(defaclacl::text, '|' order by defaclobjtype::text), '')
          from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
          where n.nspname='public' and d.defaclobjtype <> 'r'`) === defaclOtherBefore,
    "sequence/function defaults moved");

  // ----------------------------------------------------- idempotence
  console.log("Re-applying 0057 (idempotence)...");
  exec(sql57);
  assert("re-running 0057 raises no error and changes nothing",
    matrix(DANGEROUS) === "" && matrix(DML) === dmlBefore && sentinel("zz_sentinel_again") === "");

  ok = failures.length === 0;
} finally {
  if (ok) {
    try { docker(["rm", "-f", CONTAINER]); console.log("Disposable stack removed."); } catch { /* ignore */ }
  } else {
    console.error(`Container left up for inspection: ${CONTAINER}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed. 0057 runtime contract PASSED.`);
