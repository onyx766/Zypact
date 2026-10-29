/**
 * M0 — worker hosting artefacts contract.
 *
 * The worker is now runnable by a host. These four files are what a host
 * would read, and each of them can silently undo an invariant the execution
 * gate spent 471 checks establishing:
 *
 *   Dockerfile.worker         a shell wrapper, an ENTRYPOINT or the `tsx`
 *                             CLI puts a process between the supervisor and
 *                             the entrypoint, and the cooperative shutdown
 *                             stops being observable.
 *   .dockerignore             a permissive context ships `.env`, `.git` or a
 *                             backup into a layer, where it stays forever.
 *   fly.worker.toml.template  an `app` line makes an inert template
 *                             deployable; an `http_service` block turns a
 *                             private worker into a public endpoint.
 *   fly.worker.staging.toml   a wrong app, region or execution mode can
 *                             deploy the worker to the wrong place or let
 *                             it spend before live execution is authorised.
 *
 * The static half runs everywhere and reads only these files. The Docker
 * half is OPT-IN — `ZYPACT_M0_HOSTING_DOCKER_TEST=1` — and, once asked for,
 * FAILS rather than skips when Docker is unavailable: a hosting proof that
 * quietly degrades into no proof is the failure mode this whole milestone
 * exists to refuse.
 *
 * Nothing here logs in, pushes an image, creates an app, reads a secret or
 * contacts Supabase or a provider. The only network use is the image pull
 * performed by `docker build`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { SOURCE_ROOTS } from "@/lib/protocol-worker/source-digest";
import { sourceDigestAtCommit } from "./worker-provenance-git";

let checks = 0;
const failures: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

/** Lines with comments and blanks removed — what the parser actually sees. */
function code(src: string, comment: string): string[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith(comment));
}

// ═══════════════════════════════════════════════ 1. Dockerfile.worker
{
  const src = read("Dockerfile.worker");
  const lines = code(src, "#");
  const BASE = "node:24.19.0-bookworm-slim";

  const froms = lines.filter((l) => /^FROM /i.test(l));
  assert("exactly two build stages", froms.length === 2, froms.join(" | "));
  assert("both stages pin the same exact base image",
    froms.every((l) => l.includes(BASE)), froms.join(" | "));

  // A tag is mutable: `node:24.19.0-bookworm-slim` can be repushed, and a
  // build whose base moved is a build whose earlier proofs no longer
  // describe it. Both stages must be pinned by digest, and by the SAME one,
  // or the runtime image could inherit node_modules built against another
  // base entirely.
  const digests = froms.map((l) => (l.match(/@(sha256:[0-9a-f]{64})/) ?? [])[1]);
  assert("both stages are pinned by digest",
    digests.every((d) => typeof d === "string"), froms.join(" | "));
  assert("both stages pin the SAME digest",
    digests[0] !== undefined && digests[0] === digests[1],
    digests.join(" vs "));
  assert("each FROM keeps the human-readable tag alongside its digest",
    froms.every((l) => new RegExp(`${BASE}@sha256:[0-9a-f]{64}`).test(l)),
    froms.join(" | "));
  // Negative proof: an unpinned FROM would fail the check above.
  const unpinned = src.replace(/@sha256:[0-9a-f]{64}/g, "");
  assert("an unpinned FROM would fail the digest check",
    (unpinned.match(/@sha256:[0-9a-f]{64}/g) ?? []).length === 0);
  // Negative proof: two different digests must not pass.
  const mixed = [`FROM ${BASE}@sha256:${"a".repeat(64)}`, `FROM ${BASE}@sha256:${"b".repeat(64)}`]
    .map((l) => (l.match(/@(sha256:[0-9a-f]{64})/) ?? [])[1]);
  assert("two different digests would fail the same-digest check",
    mixed[0] !== mixed[1]);

  // The production install lives in its own stage, so the runtime image
  // inherits node_modules without the npm cache or the build metadata.
  const depsHalf = src.slice(0, src.indexOf("AS runtime"));
  const runtimeHalf = src.slice(src.indexOf("AS runtime"));
  assert("the production install is `npm ci --omit=dev`",
    /RUN\s+npm ci --omit=dev/.test(src));
  assert("it runs in the separate deps stage, not the runtime stage",
    /RUN\s+npm ci --omit=dev/.test(depsHalf) && !/RUN\s+npm ci/.test(runtimeHalf));
  assert("the runtime stage copies node_modules from that stage",
    /COPY --from=deps[^\n]*node_modules/.test(runtimeHalf));

  const users = lines.filter((l) => /^USER /i.test(l));
  assert("the final user is the unprivileged `node` account",
    users.length >= 1 && /^USER\s+node$/i.test(users[users.length - 1]),
    users.join(" | ") || "no USER instruction");
  assert("no USER instruction returns to root",
    !users.some((l) => /^USER\s+(root|0)\b/i.test(l)), users.join(" | "));

  for (const [k, v] of [
    ["NODE_ENV", "production"],
    ["WORKER_EXECUTION_MODE", "disabled"],
    ["WORKER_HEALTH_PORT", "0"],
  ] as const) {
    // The values are plain literals; a substring match on the runtime half
    // is exact enough and cannot be fooled by a stray escape.
    assert(`the image defaults ${k} to ${v}`, runtimeHalf.includes(`${k}=${v}`), k);
  }

  assert("STOPSIGNAL is SIGTERM", /^STOPSIGNAL\s+SIGTERM$/im.test(src));

  // The whole point of the file. Exec form, no wrapper, exactly one CMD.
  const EXACT_CMD = 'CMD ["node", "--import", "tsx", "scripts/run-protocol-worker.ts"]';
  const cmds = lines.filter((l) => /^CMD /i.test(l));
  assert("exactly one CMD", cmds.length === 1, cmds.join(" | "));
  assert("PID 1 is the Node entrypoint, in exec form, verbatim",
    cmds[0] === EXACT_CMD, cmds[0] ?? "absent");
  // The base image declares ENTRYPOINT ["docker-entrypoint.sh"] and an image
  // inherits it, so "no ENTRYPOINT instruction" would silently accept a shell
  // wrapper this repository did not write. The instruction must be present,
  // and it must be the empty reset that clears the inherited value.
  const entrypoints = lines.filter((l) => /^ENTRYPOINT/i.test(l));
  assert("exactly one ENTRYPOINT instruction", entrypoints.length === 1,
    entrypoints.join(" | ") || "none");
  assert("it is the empty reset that clears the inherited entrypoint",
    entrypoints[0] === "ENTRYPOINT []", entrypoints[0] ?? "absent");
  assert("the reset precedes the CMD",
    lines.indexOf("ENTRYPOINT []") < lines.findIndex((l) => /^CMD /i.test(l)));
  assert("no EXPOSE — this is a worker, not a service",
    !lines.some((l) => /^EXPOSE/i.test(l)));
  assert("CMD invokes neither npm nor a shell",
    !/CMD[^\n]*(npm|yarn|pnpm|\/bin\/sh|\/bin\/bash|sh -c|bash -c)/i.test(src));

  // Needles assembled at runtime so this file does not match itself.
  const internalLoader = ["tsx", "dist", "loader.mjs"].join("/");
  assert("no path into the tsx build output", !src.includes(internalLoader));
  assert("the loader is the bare public specifier", cmds[0]?.includes('"tsx"') === true);
  // These read the INSTRUCTIONS, not the prose. The header comment names the
  // credentials the image deliberately does not carry, and a contract that
  // could not tell a comment from a COPY would forbid saying so.
  const instructions = lines.join("\n");
  for (const forbidden of ["curl", "wget", "apt-get install", "chmod 777"]) {
    assert(`no \`${forbidden}\` instruction`,
      !new RegExp(forbidden, "i").test(instructions), forbidden);
  }
  assert("no env file is copied into the image",
    !/COPY[^\n]*\.env/i.test(instructions) && !/ADD[^\n]*\.env/i.test(instructions));
  assert("no instruction carries a credential-shaped token",
    !/(SUPABASE|PERPLEXITY|OPENAI|ANTHROPIC|SERVICE_ROLE|API_KEY|_TOKEN|_SECRET)/i.test(instructions),
    instructions.split("\n").filter((l) => /KEY|TOKEN|SECRET/i.test(l)).join(" | "));
  // PR-2 — provenance. Exactly one build argument, GIT_SHA, with no
  // default (a default would let a build without provenance pass), declared
  // in the runtime stage after the sources are copied. The build itself
  // validates it and records it: a RUN that writes build-provenance.json
  // through writeImageProvenance (which refuses a missing or malformed SHA),
  // then the image environment and the OCI revision label. All of it before
  // USER node, so the worker cannot rewrite its own record.
  const onlyGitShaArg = (ls: string[]): boolean => {
    const a = ls.filter((l) => /^ARG /i.test(l));
    return a.length === 1 && a[0] === "ARG GIT_SHA";
  };
  assert("the only build argument is GIT_SHA, with no default", onlyGitShaArg(lines),
    lines.filter((l) => /^ARG /i.test(l)).join(" | ") || "none");
  assert("a GIT_SHA default, or a second ARG, would fail that check",
    !onlyGitShaArg(lines.map((l) => (l === "ARG GIT_SHA" ? `ARG GIT_SHA=${"0".repeat(40)}` : l)))
      && !onlyGitShaArg([...lines, "ARG EXTRA"]));
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const argAt = at(/^ARG GIT_SHA$/);
  const runAt = at(/^RUN node --import tsx -e .*writeImageProvenance\('\.', process\.env\.GIT_SHA\)/);
  const envAt = at(/^ENV ZYPACT_BUILD_GIT_SHA=\$\{GIT_SHA\}$/);
  const labelAt = at(/^LABEL org\.opencontainers\.image\.revision=\$\{GIT_SHA\}$/);
  const lastCopyAt = lines.reduce((acc, l, i) => (/^COPY /i.test(l) ? i : acc), -1);
  const userAt = lines.findIndex((l) => /^USER\s+node$/i.test(l));
  const runtimeAt = lines.findIndex((l) => /AS runtime/i.test(l));
  assert("GIT_SHA is declared in the runtime stage, after every COPY",
    argAt > runtimeAt && argAt > lastCopyAt, `arg=${argAt} lastCopy=${lastCopyAt}`);
  assert("the build validates GIT_SHA and records the source digest (writeImageProvenance)",
    runAt > argAt, `run=${runAt}`);
  assert("the RUN fails the build on refusal (explicit non-zero exit)",
    runAt >= 0 && /\.catch\(\(e\) => \{ console\.error\(e\.message\); process\.exit\(1\); \}\)/.test(lines[runAt]));
  assert("the SHA is recorded in the image environment and the OCI revision label",
    envAt > argAt && labelAt > argAt, `env=${envAt} label=${labelAt}`);
  assert("provenance is written before USER node, so the worker cannot rewrite it",
    runAt >= 0 && userAt > runAt && userAt > envAt && userAt > labelAt, `run=${runAt} user=${userAt}`);
  {
    // Negative proof: the same ordering check on a file with USER moved first.
    const moved = [...lines.slice(0, runAt), "USER node", ...lines.slice(runAt).filter((l) => !/^USER\s+node$/i.test(l))];
    assert("a USER node placed before the provenance RUN would fail that ordering check",
      moved.findIndex((l) => /^USER\s+node$/i.test(l)) < moved.findIndex((l) => /writeImageProvenance/.test(l)));
  }
  assert("no provenance record is copied in from the build context",
    !/(COPY|ADD)[^\n]*build-provenance/i.test(instructions));
}

// ══════════════════════════════════════════════════════ 2. .dockerignore
{
  const src = read(".dockerignore");
  const lines = code(src, "#");
  assert("the context is denied wholesale before anything is admitted",
    lines[0] === "*", lines[0] ?? "empty");

  const allowed = lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1));
  // Exactly the paths the image needs. `tsconfig.*.json` was admitted for a
  // file that does not exist; an allow-list entry with nothing behind it is
  // a claim the repository does not support, so it is gone.
  const EXPECTED = [
    "package.json", "package-lock.json", "tsconfig.json",
    "lib/", "scripts/run-protocol-worker.ts",
  ];
  assert("the allow-list is exactly the files the image needs",
    allowed.length === EXPECTED.length && EXPECTED.every((e) => allowed.includes(e)),
    allowed.join(", "));

  for (const danger of [".git", ".env", ".next", "node_modules", "supabase", "docs", "app", "public"]) {
    assert(`nothing re-admits \`${danger}\``,
      !allowed.some((a) => a === danger || a.startsWith(`${danger}/`) || a.startsWith(`${danger}.`)),
      danger);
  }
  // Belt and braces: the same paths are denied by name, so a future edit to
  // the allow-list cannot quietly let them through.
  for (const denied of [".git/", ".env", ".env.*", ".next/", "node_modules/", "supabase/"]) {
    assert(`\`${denied}\` is also denied explicitly`, lines.includes(denied), denied);
  }
}

// ═══════════════════════════════════════════ 3. fly.worker.toml.template
{
  const src = read("fly.worker.toml.template");
  const lines = code(src, "#");
  const body = lines.join("\n");

  // Not deployable, and saying so is part of the contract.
  assert("no `app` key — the template cannot name an application",
    !lines.some((l) => /^app\s*=/.test(l)), lines.filter((l) => /^app/.test(l)).join(" | "));
  assert("no `primary_region` key — the region is not chosen yet",
    !lines.some((l) => /^primary_region\s*=/.test(l)));
  assert("a comment states that both are added only after an authorisation",
    /app.*primary_region/is.test(src) && /authoris|authoriz/i.test(src)
      && /region/i.test(src));

  assert("kill_signal is SIGTERM",
    lines.some((l) => /^kill_signal\s*=\s*"SIGTERM"$/.test(l)));
  assert("kill_timeout is 30",
    lines.some((l) => /^kill_timeout\s*=\s*30$/.test(l)));

  // The invariant, checked as ARITHMETIC rather than as prose. Fly kills the
  // machine kill_timeout seconds after the signal; the worker's cooperative
  // shutdown is budgeted by WORKER_GRACE_MS. If the budget reaches or passes
  // the window, the stop stops being cooperative — the process is killed
  // mid-iteration and the final event never lands. Both numbers are read
  // from this file, so neither can drift without the other being re-checked.
  const killTimeoutS = Number.parseInt(
    (lines.find((l) => /^kill_timeout\s*=/.test(l)) ?? "").split("=")[1] ?? "", 10);
  const graceLine = lines.find((l) => /^WORKER_GRACE_MS\s*=/.test(l));
  const graceMs = Number.parseInt(
    ((graceLine ?? "").match(/"(\d+)"/) ?? [])[1] ?? "", 10);
  assert("[env] states WORKER_GRACE_MS explicitly, as a quoted integer",
    graceLine !== undefined && Number.isSafeInteger(graceMs) && graceMs > 0,
    graceLine ?? "absent");
  assert("kill_timeout parses as a positive integer number of seconds",
    Number.isSafeInteger(killTimeoutS) && killTimeoutS > 0, String(killTimeoutS));
  assert("WORKER_GRACE_MS is strictly inside kill_timeout x 1000",
    graceMs < killTimeoutS * 1000,
    `${graceMs} ms vs ${killTimeoutS * 1000} ms`);
  // Negative proofs: equality and overrun must both fail, and a missing
  // value must not be read as zero.
  assert("a grace equal to the window would fail", !(killTimeoutS * 1000 < killTimeoutS * 1000));
  assert("a grace above the window would fail", !(killTimeoutS * 1000 + 1 < killTimeoutS * 1000));
  // A template with no WORKER_GRACE_MS line must not be read as zero, which
  // would satisfy `< kill_timeout * 1000` while proving nothing.
  const withoutGrace = lines.filter((l) => !/^WORKER_GRACE_MS\s*=/.test(l));
  const absentGraceMs = Number.parseInt(
    ((withoutGrace.find((l) => /^WORKER_GRACE_MS\s*=/.test(l)) ?? "").match(/"(\d+)"/) ?? [])[1] ?? "",
    10);
  assert("a missing WORKER_GRACE_MS parses as NaN, never as zero",
    Number.isNaN(absentGraceMs), String(absentGraceMs));

  assert("the build uses Dockerfile.worker",
    lines.includes("[build]") && lines.some((l) => /^dockerfile\s*=\s*"Dockerfile\.worker"$/.test(l)));

  const ENV = [
    ['NODE_ENV', 'production'],
    ['WORKER_EXECUTION_MODE', 'disabled'],
    // D-036: a slot is one baseline run, and 7 is the protocol run_cap, so a
    // job can finish inside the claim that started it.
    ['WORKER_MAX_SLOTS_PER_CLAIM', '7'],
    ['WORKER_MAX_RUNTIME_SECONDS', '900'],
    ['WORKER_PROVIDER_TIMEOUT_MS', '45000'],
    ['WORKER_EXIT_AFTER_CLAIMED_JOB', 'true'],
    ['WORKER_MAX_THROTTLED_RETRIES', '0'],
    ['WORKER_HEALTH_HOST', '0.0.0.0'],
    ['WORKER_HEALTH_PORT', '8080'],
    ['WORKER_GRACE_MS', '10000'],
  ] as const;
  assert("[env] exists", lines.includes("[env]"));
  for (const [k, v] of ENV) {
    assert(`[env] carries ${k} = "${v}"`,
      lines.some((l) => l === `${k} = "${v}"`), k);
  }
  // Whatever else [env] holds, it must not hold a credential.
  const envBlock = body.slice(body.indexOf("[env]"), body.indexOf("[checks]"));
  assert("[env] carries exactly the declared non-secret values, and nothing else",
    envBlock.split("\n").filter((l) => l.includes("=")).length === ENV.length,
    envBlock.replace(/\n/g, " | "));
  assert("no credential-shaped key anywhere in the template",
    !/(SERVICE_ROLE|API_KEY|_TOKEN|_SECRET|PERPLEXITY|OPENAI|ANTHROPIC|SUPABASE)/i.test(body));

  // A top-level check, because a worker has no service to hang one on.
  assert("a top-level [checks] table exists", lines.includes("[checks]"));
  assert("the check is named `readiness`", lines.includes("[checks.readiness]"),
    lines.filter((l) => l.startsWith("[checks.")).join(" | "));
  // /readyz, not /healthz: both answer 200 while inert, but only /readyz
  // turns 503 when a live worker stops making progress. A check pointed at
  // /healthz would keep reporting a wedged worker as healthy.
  assert("the check is HTTP GET on /readyz, port 8080",
    lines.some((l) => /^type\s*=\s*"http"$/.test(l))
      && lines.some((l) => /^port\s*=\s*8080$/.test(l))
      && lines.some((l) => /^method\s*=\s*"GET"$/.test(l))
      && lines.some((l) => /^path\s*=\s*"\/readyz"$/.test(l)));
  assert("no check is pointed at /healthz",
    !lines.some((l) => /^path\s*=\s*"\/healthz"$/.test(l)),
    lines.filter((l) => l.startsWith("path")).join(" | "));
  assert("exactly one check is declared",
    lines.filter((l) => /^\[checks\.[^\]]+\]$/.test(l)).length === 1,
    lines.filter((l) => l.startsWith("[checks.")).join(" | "));

  // A bounded one-claim worker must remain stopped after every exit. An
  // automatic restart would create a fresh process lifetime and defeat both
  // the intrinsic total-runtime ceiling and WORKER_EXIT_AFTER_CLAIMED_JOB.
  // `never` is fly.toml's spelling of that policy. `no` is the Machines API
  // spelling, which flyctl rejects at config validation, so a file carrying
  // it cannot be deployed at all.
  assert("[[restart]] declares policy = \"never\"",
    lines.includes("[[restart]]") && lines.some((l) => /^policy\s*=\s*"never"$/.test(l)),
    lines.filter((l) => l.startsWith("policy")).join(" | ") || "no policy");
  assert("no restart policy uses the Machines API spelling `no`",
    !lines.some((l) => /^policy\s*=\s*"no"$/.test(l)),
    lines.filter((l) => l.startsWith("policy")).join(" | "));
  assert("no other restart policy is declared",
    lines.filter((l) => /^policy\s*=/.test(l)).length === 1);

  // The template must not claim the region is irreversible: on Fly a machine
  // is created in a region, and another machine can be created elsewhere.
  // The reason to choose carefully is latency to Supabase, not permanence.
  assert("the template makes no irreversibility claim about the region",
    !/irreversib|cannot be changed|immutable|permanent/i.test(src),
    (src.match(/[^.]*\b(irreversib|cannot be changed|immutable|permanent)[^.]*\./i) ?? [""])[0].trim());

  // Negative proofs, in memory: each of the three new properties must be the
  // reason its own check passes.
  const noReadyz = src.split('path = "/readyz"').join('path = "/healthz"');
  assert("a template probing /healthz would fail the path check",
    !/path\s*=\s*"\/readyz"/.test(noReadyz));
  const noRestart = src.split("[[restart]]").join("# [[restart]]");
  assert("a template without [[restart]] would fail the restart check",
    !code(noRestart, "#").includes("[[restart]]"));
  const renamed = src.split("[checks.readiness]").join("[checks.health]");
  assert("a check under another name would fail the name check",
    !code(renamed, "#").includes("[checks.readiness]"));
  assert("the check port matches WORKER_HEALTH_PORT",
    lines.includes('WORKER_HEALTH_PORT = "8080"') && lines.some((l) => /^port\s*=\s*8080$/.test(l)));
  assert("the bind host is the wildcard, or the prober could not reach it",
    lines.includes('WORKER_HEALTH_HOST = "0.0.0.0"'));

  for (const forbidden of [
    "[http_service]", "[[services]]", "[[services.ports]]", "[mounts]", "[[mounts]]",
    "[[statics]]", "[deploy]", "[experimental]",
  ]) {
    assert(`no \`${forbidden}\` — this worker serves no public traffic`,
      !lines.includes(forbidden), forbidden);
  }
  for (const key of ["internal_port", "force_https", "auto_stop_machines", "auto_start_machines"]) {
    assert(`no \`${key}\` key`, !lines.some((l) => l.startsWith(`${key}`)), key);
  }
  assert("no IP address is allocated or referenced",
    !/\bip_address\b|\bipv[46]\b/i.test(body));
  assert("no volume is declared", !/\bsource\s*=|\bdestination\s*=/.test(body));

  assert("[[vm]] declares a shared 1-CPU, 512 MB machine",
    lines.includes("[[vm]]")
      && lines.some((l) => /^size\s*=\s*"shared-cpu-1x"$/.test(l))
      && lines.some((l) => /^cpu_kind\s*=\s*"shared"$/.test(l))
      && lines.some((l) => /^cpus\s*=\s*1$/.test(l))
      && lines.some((l) => /^memory_mb\s*=\s*512$/.test(l)));
}

// ═══════════════════════════════════ 4. the deployable deployment configs
//
// Both environments are checked by the same contract, against the same inert
// template. Bounds that differ between staging and production would mean a
// staging demonstration establishes nothing about production behaviour, so
// the only semantic difference either file may carry is its own identity.
{
  const templateSrc = read("fly.worker.toml.template");
  const templateLines = code(templateSrc, "#");

  // `mode` is the ONE value a deployable config may differ from the template
  // by, beyond its own identity, and it is stated here rather than read from
  // the file: a flip in either direction must break this contract and be
  // argued for, never merged as a quiet edit to a toml.
  const DEPLOYABLE = [
    {
      env: "staging", file: "fly.worker.staging.toml",
      app: "zypact-protocol-worker-staging", mode: "disabled",
    },
    {
      env: "production", file: "fly.worker.production.toml",
      app: "zypact-protocol-worker", mode: "live", // D-034
    },
  ] as const;

  const identities = new Set<string>();

  const MODE_LINE = /^WORKER_EXECUTION_MODE\s*=/;
  const templateBounds = templateLines.filter((l) => !MODE_LINE.test(l));
  assert("the template itself remains execution-disabled",
    templateLines.filter((l) => l === 'WORKER_EXECUTION_MODE = "disabled"').length === 1,
    templateLines.filter((l) => MODE_LINE.test(l)).join(" | ") || "absent");

  for (const { env, file, app, mode } of DEPLOYABLE) {
    const src = read(file);
    const lines = code(src, "#");

    const appLines = lines.filter((l) => /^app\s*=/.test(l));
    const regionLines = lines.filter((l) => /^primary_region\s*=/.test(l));
    assert(`${env} names exactly the authorised Fly application`,
      appLines.length === 1 && appLines[0] === `app = "${app}"`,
      appLines.join(" | ") || "absent");
    assert(`${env} names exactly the authorised Fly region`,
      regionLines.length === 1 && regionLines[0] === 'primary_region = "iad"',
      regionLines.join(" | ") || "absent");
    assert(`${env}'s app and region are the first two semantic lines, at top level`,
      lines[0] === appLines[0] && lines[1] === regionLines[0],
      lines.slice(0, 4).join(" | "));

    // Two environments must never name the same application: a deploy of one
    // would then silently replace the other's running image.
    assert(`${env}'s application name is not shared with another environment`,
      !identities.has(appLines[0] ?? ""), appLines[0] ?? "absent");
    identities.add(appLines[0] ?? "");

    // Identity and mode aside, every BOUND must still be the template's.
    // Those are what a staging demonstration establishes; a production file
    // that quietly widened a runtime, a slot count or a retry ceiling would
    // be a worker no rehearsal describes.
    const bounds = lines.filter(
      (l) => !/^app\s*=/.test(l) && !/^primary_region\s*=/.test(l) && !MODE_LINE.test(l),
    );
    assert(`${env} differs from the inert template only by app, region and execution mode`,
      bounds.join("\n") === templateBounds.join("\n"),
      `${bounds.length} ${env} bound lines vs ${templateBounds.length} template bound lines`);

    assert(`${env} declares exactly one execution mode, and it is "${mode}"`,
      lines.filter((l) => MODE_LINE.test(l)).length === 1
        && lines.includes(`WORKER_EXECUTION_MODE = "${mode}"`),
      lines.filter((l) => MODE_LINE.test(l)).join(" | ") || "absent");

    // A live worker is bounded by these two values and nothing else. Without
    // both, one operator start would no longer mean one job: the process
    // would claim again after finishing, and a restart would hand it a fresh
    // runtime ceiling. The mode is only safe to enable while they hold.
    if (mode === "live") {
      assert(`${env} exits after a single claimed job`,
        lines.includes('WORKER_EXIT_AFTER_CLAIMED_JOB = "true"'),
        lines.filter((l) => l.startsWith("WORKER_EXIT_AFTER_CLAIMED_JOB")).join(" | "));
      assert(`${env} never restarts a machine automatically`,
        lines.some((l) => /^policy\s*=\s*"never"$/.test(l)),
        lines.filter((l) => l.startsWith("policy")).join(" | "));
      // This used to require exactly one slot per claim, on the reading that
      // a slot was a job. It is one baseline RUN. A 5-run baseline under a
      // one-slot claim ran once, then was closed `slot_budget_exhausted` and
      // parked for review — so no production baseline could ever complete,
      // and no report could ever be built from one (D-036).
      //
      // What a live config must guarantee instead is that its runtime can
      // absorb every slot it permits, each slot at its worst case: two
      // provider calls that both run to the timeout. A ceiling below that
      // would let the deadline cut a job off mid-run, which is exactly the
      // stranded state a one-start-one-job worker cannot recover from alone.
      const intOf = (key: string): number => Number.parseInt(
        (lines.find((l) => l.startsWith(`${key} =`))?.match(/"(\d+)"/) ?? [])[1] ?? "", 10);
      const slots = intOf("WORKER_MAX_SLOTS_PER_CLAIM");
      const runtimeMs = intOf("WORKER_MAX_RUNTIME_SECONDS") * 1000;
      const timeoutMs = intOf("WORKER_PROVIDER_TIMEOUT_MS");
      const graceMs = intOf("WORKER_GRACE_MS");
      const worstCaseMs = slots * 2 * timeoutMs + graceMs;
      assert(`${env} declares its slot, runtime, timeout and grace bounds`,
        [slots, runtimeMs, timeoutMs, graceMs].every((n) => Number.isSafeInteger(n) && n > 0),
        `${slots} / ${runtimeMs} / ${timeoutMs} / ${graceMs}`);
      assert(`${env}'s runtime absorbs every permitted slot at its worst case`,
        worstCaseMs < runtimeMs, `${worstCaseMs} ms needed vs ${runtimeMs} ms allowed`);
      // A slot count below a 5-run plan is the defect itself, restated as a
      // number, and it must not return.
      assert(`${env} permits enough slots for a 5-run baseline to finish in one claim`,
        slots >= 5, String(slots));
    }

    const body = lines.join("\n");
    assert(`${env} carries no credential-shaped key`,
      !/(SERVICE_ROLE|API_KEY|_TOKEN|_SECRET|PERPLEXITY|OPENAI|ANTHROPIC|SUPABASE)/i.test(body));
    assert(`${env} contains no stale claim that it is non-deployable`,
      !/deliberately\s+NOT\s+deployable|ABSENT ON PURPOSE|refuse to run|cannot create/i.test(src));
  }

  assert("the two deployable configs name different applications",
    identities.size === DEPLOYABLE.length, [...identities].join(" | "));
}

// ═══════════════════════════════════════ 5. the repository wires it in
{
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert("package.json registers this contract",
    pkg.scripts?.["test:m0-worker-hosting-contract"]
      === "tsx scripts/test-m0-worker-hosting-contract.ts",
    pkg.scripts?.["test:m0-worker-hosting-contract"] ?? "absent");

  const wf = read(".github/workflows/m0-worker-execution-gate.yml");
  for (const p of [
    "Dockerfile.worker", ".dockerignore", "fly.worker.toml.template", "fly.worker.staging.toml",
    "fly.worker.production.toml", "scripts/test-m0-worker-hosting-contract.ts",
  ]) {
    assert(`CI filters on \`${p}\``, wf.includes(`"${p}"`), p);
  }
  assert("CI runs this contract's static half",
    wf.includes("npm run test:m0-worker-hosting-contract"));
  // CI now runs the Docker half — on a natively amd64 runner, which is the
  // architecture Fly uses. What must be pinned is WHERE the opt-in lives.
  // Read the raw YAML lines here, not the comment-stripped join: indentation
  // is the whole point, and `code()` trims it away.
  const wfLines = wf.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const optIns = wfLines.filter((l) => l.includes("ZYPACT_M0_HOSTING_DOCKER_TEST"));
  assert("the Docker opt-in appears exactly once in the YAML",
    optIns.length === 1, optIns.join(" | ") || "absent");
  assert("it sets the variable to 1",
    /^\s*ZYPACT_M0_HOSTING_DOCKER_TEST:\s*"1"\s*$/.test(optIns[0] ?? ""), optIns[0] ?? "absent");

  // Step-level env is indented deeper than a job key; workflow-level `env:`
  // sits at column 0 and job-level `env:` at four spaces. Anything shallower
  // than a step's own keys would leak the opt-in into every other step.
  const indent = (l: string): number => l.length - l.trimStart().length;
  assert("the opt-in is indented as a step-level env entry, not job or workflow level",
    indent(optIns[0] ?? "") >= 10, `indent=${indent(optIns[0] ?? "")}`);
  const optIdx = wfLines.indexOf(optIns[0]);
  const envHeader = [...wfLines.slice(0, optIdx)].reverse().find((l) => /^\s*env:\s*$/.test(l));
  assert("its `env:` header is a step key, at eight spaces",
    envHeader !== undefined && indent(envHeader) === 8, envHeader ?? "no env: header above it");
  // The nearest preceding `- name:` must be the hosting contract step.
  const owner = [...wfLines.slice(0, optIdx)].reverse().find((l) => /^\s*- name:/.test(l));
  assert("it belongs to the hosting artefacts step and no other",
    (owner ?? "").includes("Run the hosting artefacts contract"), owner ?? "no step above it");

  // Neither the workflow-level nor a job-level `env:` may carry it.
  const topEnvIdx = wfLines.findIndex((l) => /^env:\s*$/.test(l));
  const topEnvBlock = topEnvIdx === -1 ? [] :
    wfLines.slice(topEnvIdx + 1).filter((l, i, a) => a.slice(0, i + 1).every((x) => indent(x) >= 2));
  assert("the workflow-level env block does not carry the opt-in",
    !topEnvBlock.some((l) => l.includes("ZYPACT_M0_HOSTING_DOCKER_TEST")),
    topEnvBlock.join(" | "));
  assert("no job-level env block carries it",
    !wfLines.some((l, i) => /^    env:\s*$/.test(l)
      && wfLines.slice(i + 1, i + 8).some((n) => n.includes("ZYPACT_M0_HOSTING_DOCKER_TEST"))));
  assert("CI still runs no docker command of its own",
    !wfLines.some((l) => /^\s*run:.*\bdocker\b/.test(l)), "docker in a run: line");
}

// ═══════════════════════════════════════════════ 6. the Docker half
/**
 * Opt-in, and unforgiving once opted into. Everything it creates carries a
 * unique name, and it removes exactly those two objects — never a prune,
 * never another image, container or volume.
 */
const DOCKER_REQUESTED = process.env.ZYPACT_M0_HOSTING_DOCKER_TEST === "1";
const DOCKER = process.env.ZYPACT_DOCKER_BIN ?? "docker";
/**
 * The image is built and exercised for the architecture it will actually run
 * on. Fly machines are x86-64; a smoke test that only ever proved an arm64
 * image would say nothing about the artefact that gets deployed. On an arm64
 * workstation this runs under emulation, which is slower and entirely the
 * point.
 */
const PLATFORM = "linux/amd64";

function docker(args: string[], input?: string): { code: number; out: string; err: string } {
  const r = spawnSync(DOCKER, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? String(r.error ?? "") };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => (p ? resolve(p) : reject(new Error("no port"))));
    });
  });
}

async function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.text() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function dockerHalf(): Promise<void> {
  if (!DOCKER_REQUESTED) {
    console.log("\n[docker] not requested — set ZYPACT_M0_HOSTING_DOCKER_TEST=1 to run it.");
    console.log("[docker] NOTHING was built, started or verified in Docker by this run.");
    return;
  }

  // Asked for, so a missing daemon is a failure, never a skip.
  const probe = docker(["version", "--format", "{{.Server.Version}}"]);
  if (probe.code !== 0) {
    failures.push(
      "the Docker half was requested but Docker is unavailable: "
      + `\`${DOCKER} version\` exited ${probe.code}. `
      + (probe.err.trim().split("\n")[0] ?? ""),
    );
    checks += 1;
    return;
  }
  checks += 1;
  console.log(`\n[docker] server ${probe.out.trim()}`);

  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const TAG = `zypact-m0-worker-hosting:${stamp}`;
  const NAME = `zypact-m0-worker-hosting-${stamp}`;
  let built = false;
  let started = false;

  try {
    // ---------------------------------------------------------- build
    // PR-2 — the image claims the checked-out commit, and the contract
    // proves it holds that commit's files. That proof needs a clean build
    // context: an edit or an untracked file under the image source would
    // ship under a commit it does not match, so it is a failure, not a skip.
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--",
      ...SOURCE_ROOTS.map((r) => r.replace(/\/$/, ""))], { encoding: "utf8" }).stdout.trim();
    assert("the build context is a clean checkout of HEAD", /^[0-9a-f]{40}$/.test(head) && dirty === "",
      dirty.split("\n").slice(0, 3).join(" / ") || head);
    if (dirty !== "" || !/^[0-9a-f]{40}$/.test(head)) return;
    const expectedDigest = sourceDigestAtCommit(head);

    // Fail closed: no image without a valid GIT_SHA.
    for (const [label, extra] of [
      ["no GIT_SHA", [] as string[]],
      ["a malformed GIT_SHA", ["--build-arg", "GIT_SHA=not-a-commit"]],
      ["an abbreviated GIT_SHA", ["--build-arg", `GIT_SHA=${head.slice(0, 12)}`]],
    ] as const) {
      const refused = docker(["build", "--platform", PLATFORM, "--file", "Dockerfile.worker", ...extra, "."]);
      assert(`a build with ${label} fails`, refused.code !== 0, `exit=${refused.code}`);
      assert(`…and says why`, /GIT_SHA must be passed as a build argument/.test(refused.err + refused.out),
        refused.err.trim().split("\n").slice(-2).join(" / "));
    }

    const build = docker([
      "build", "--platform", PLATFORM, "--file", "Dockerfile.worker",
      "--build-arg", `GIT_SHA=${head}`, "--tag", TAG, ".",
    ]);
    assert("the image builds", build.code === 0,
      build.err.trim().split("\n").slice(-4).join(" / "));
    if (build.code !== 0) return;
    built = true;

    // ------------------------------------------------------ provenance
    const label = docker(["image", "inspect", "--format",
      '{{index .Config.Labels "org.opencontainers.image.revision"}}', TAG]);
    assert("the OCI revision label is the built commit", label.out.trim() === head, label.out.trim());
    const record = docker(["run", "--rm", "--platform", PLATFORM, TAG, "cat", "/app/build-provenance.json"]);
    let parsedRecord: Record<string, unknown> = {};
    try { parsedRecord = JSON.parse(record.out) as Record<string, unknown>; } catch { /* asserted below */ }
    assert("build-provenance.json records the built commit", parsedRecord.gitSha === head, record.out.trim().slice(0, 120));
    assert("…and the source digest git computes for that commit",
      parsedRecord.sourceDigest === expectedDigest, `${String(parsedRecord.sourceDigest)} vs ${expectedDigest}`);
    const owner = docker(["run", "--rm", "--platform", PLATFORM, TAG, "stat", "-c", "%U %a", "/app/build-provenance.json"]);
    assert("the record is root-owned and read-only to others", owner.out.trim() === "root 644", owner.out.trim());
    const writable = docker(["run", "--rm", "--platform", PLATFORM, TAG, "test", "-w", "/app/build-provenance.json"]);
    assert("the worker user cannot rewrite it", writable.code !== 0, `exit=${writable.code}`);

    // ------------------------------------------- the architecture built
    const arch = docker(["image", "inspect", "--format", "{{.Architecture}}/{{.Os}}", TAG]);
    assert(`the image is ${PLATFORM}`, arch.out.trim() === "amd64/linux", arch.out.trim());

    // ------------------------------------------- what the image holds
    const ls = docker(["run", "--rm", "--platform", PLATFORM, TAG, "ls", "-a", "/app"]);
    assert("the image lists its build context", ls.code === 0, ls.err.slice(0, 200));
    const entries = ls.out.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const want of ["package.json", "package-lock.json", "tsconfig.json", "lib", "node_modules", "scripts"]) {
      assert(`the image contains \`${want}\``, entries.includes(want), entries.join(" "));
    }
    for (const unwanted of [".env", ".env.local", ".env.example", ".git", ".next", "supabase", "docs", "app", "components", "public"]) {
      assert(`the image does NOT contain \`${unwanted}\``, !entries.includes(unwanted), entries.join(" "));
    }

    const bin = docker(["run", "--rm", "--platform", PLATFORM, TAG, "ls", "/app/node_modules/.bin/tsx"]);
    assert("tsx survived the production install", bin.code === 0, bin.err.slice(0, 160));
    for (const dev of ["typescript", "tailwindcss", "dotenv", "autoprefixer", "@types/node"]) {
      const r = docker(["run", "--rm", "--platform", PLATFORM, TAG, "ls", "-d", `/app/node_modules/${dev}`]);
      assert(`devDependency \`${dev}\` is absent from the image`, r.code !== 0, dev);
    }

    // ------------------------- the live path loads, with no network at all
    //
    // The disabled path proves the image starts. It proves nothing about the
    // modules `runLive` imports dynamically — and those are exactly what a
    // production install could be missing, because nothing loads them until
    // execution is switched on. By then the worker holds a claimed job.
    //
    // The specifiers are READ FROM THE ENTRYPOINT, so this cannot drift from
    // the code it is meant to cover, and `--network none` proves the modules
    // resolve from the image alone: no registry, no Supabase, no provider.
    const entrySrc = read("scripts/run-protocol-worker.ts");
    const dynamic = [...entrySrc.matchAll(/import\("(@\/[^"]+)"\)/g)].map((m) => m[1]);
    assert("the entrypoint declares dynamic live-path imports to cover",
      dynamic.length >= 6, `${dynamic.length} found`);
    const uniq = [...new Set(dynamic)];
    assert("every dynamic import is distinct", uniq.length === dynamic.length,
      dynamic.join(","));

    const loader =
      `const specs=${JSON.stringify(uniq)};`
      + "for(const s of specs){const m=await import(s);"
      + "if(!m||Object.keys(m).length===0)throw new Error('empty module: '+s);"
      + "console.log('loaded '+s);}";
    const load = docker([
      "run", "--rm", "--network", "none", "--platform", PLATFORM,
      TAG, "node", "--import", "tsx", "-e", loader,
    ]);
    assert("every live-path module loads inside the image with no network",
      load.code === 0,
      `exit=${load.code} ${load.err.trim().split("\n").slice(-3).join(" / ")}`);
    for (const spec of uniq) {
      assert(`\`${spec}\` loaded offline`, load.out.includes(`loaded ${spec}`),
        load.out.replace(/\n/g, " | ").slice(0, 200));
    }
    // Negative proof: a specifier the image does not carry must fail, so the
    // check above is not merely reporting a command that always succeeds.
    const absent = docker([
      "run", "--rm", "--network", "none", "--platform", PLATFORM,
      TAG, "node", "--import", "tsx", "-e", "await import('@/lib/does-not-exist');",
    ]);
    assert("a module the image lacks would fail that same probe",
      absent.code !== 0, `exit=${absent.code}`);

    // --------------------------------------------------------- start
    const hostPort = await freePort();
    const run = docker([
      "run", "--detach", "--platform", PLATFORM, "--name", NAME,
      "--env", "WORKER_HEALTH_HOST=0.0.0.0",
      "--env", "WORKER_HEALTH_PORT=8080",
      "--publish", `127.0.0.1:${hostPort}:8080`,
      TAG,
    ]);
    assert("the container starts", run.code === 0, run.err.trim().slice(0, 200));
    if (run.code !== 0) return;
    started = true;
    await sleep(3000);

    // ------------------------------------------------ PID 1 and user
    // The IMAGE's configured command, which is what a real host executes and
    // the only emulation-independent statement of it.
    const cfgCmd = docker(["image", "inspect", "--format", "{{json .Config.Cmd}}", TAG]);
    assert("the image's CMD is the four-element exec form, verbatim",
      cfgCmd.out.trim() === '["node","--import","tsx","scripts/run-protocol-worker.ts"]',
      cfgCmd.out.trim());
    const cfgEntry = docker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", TAG]);
    assert("the image declares no ENTRYPOINT",
      cfgEntry.out.trim() === "null" || cfgEntry.out.trim() === "[]", cfgEntry.out.trim());
    const cfgUser = docker(["image", "inspect", "--format", "{{.Config.User}}", TAG]);
    assert("the image's configured user is `node`", cfgUser.out.trim() === "node", cfgUser.out.trim());
    const cfgStop = docker(["image", "inspect", "--format", "{{.Config.StopSignal}}", TAG]);
    assert("the image's STOPSIGNAL is SIGTERM", cfgStop.out.trim() === "SIGTERM", cfgStop.out.trim());
    const cfgExposed = docker(["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", TAG]);
    assert("the image exposes no port", cfgExposed.out.trim() === "null", cfgExposed.out.trim());

    // And the live argv. Running amd64 under emulation, Docker Desktop's
    // Rosetta shim PREPENDS flags of its own — `--no-opt -r /proc/.reset` —
    // between the binary and the CMD. That is a property of this host, not
    // of the artefact, so the runtime check asserts the structure that
    // matters instead of an exact argument count: node is PID 1, the public
    // loader is used, the entrypoint is the final argument, and nothing that
    // could swallow a signal sits anywhere in the line.
    const cmdline = docker(["exec", NAME, "cat", "/proc/1/cmdline"]);
    const argv = cmdline.out.split("\0").filter(Boolean);
    assert("PID 1 is node itself", /(^|\/)node$/.test(argv[0] ?? ""), argv.join(" "));
    const importAt = argv.indexOf("--import");
    assert("PID 1 loads TypeScript through the bare public `tsx` specifier",
      importAt > 0 && argv[importAt + 1] === "tsx", argv.join(" "));
    assert("the entrypoint is the final argument",
      argv[argv.length - 1] === "scripts/run-protocol-worker.ts", argv.join(" "));
    assert("no npm, shell or `-c` wrapper appears in PID 1's argv",
      !argv.some((a) => /(^|\/)(npm|npx|yarn|pnpm|sh|bash|dash)$/.test(a) || a === "-c"),
      argv.join(" "));
    const internalInArgv = ["tsx", "dist", "loader.mjs"].join("/");
    assert("PID 1 uses no path into the tsx build output",
      !argv.some((a) => a.includes(internalInArgv)), argv.join(" "));
    // Everything the emulator added must be a flag, never another program.
    const extra = argv.slice(1, importAt);
    assert("anything preceding --import is a flag or its value, not a program",
      extra.every((a, i) => a.startsWith("-") || (i > 0 && extra[i - 1].startsWith("-"))),
      extra.join(" ") || "(none)");
    const machine = docker(["exec", NAME, "uname", "-m"]);
    assert("the running container really is x86-64", machine.out.trim() === "x86_64",
      machine.out.trim());
    const uid = docker(["exec", NAME, "id", "-u"]);
    assert("the process does not run as root",
      uid.out.trim() !== "0" && uid.out.trim() !== "", `uid=${uid.out.trim()}`);
    const who = docker(["exec", NAME, "id", "-un"]);
    assert("the process runs as `node`", who.out.trim() === "node", who.out.trim());
    const envDump = docker(["exec", NAME, "printenv"]);
    assert("the running container holds no credential-shaped variable",
      !/(SERVICE_ROLE|API_KEY|_TOKEN=|_SECRET|PERPLEXITY|OPENAI|ANTHROPIC|SUPABASE)/i.test(envDump.out),
      envDump.out.split("\n").filter((l) => /KEY|TOKEN|SECRET/i.test(l)).join(" | "));
    assert("execution is disabled inside the container",
      /WORKER_EXECUTION_MODE=disabled/.test(envDump.out));
    assert("the image environment carries the built commit",
      envDump.out.split("\n").includes(`ZYPACT_BUILD_GIT_SHA=${head}`));

    // ------------------------------------------------------- health
    const healthz = await get(hostPort, "/healthz");
    const readyz = await get(hostPort, "/readyz");
    const unknown = await get(hostPort, "/metrics");
    assert("/healthz answers 200", healthz.status === 200, String(healthz.status));
    assert("/readyz answers 200", readyz.status === 200, String(readyz.status));
    assert("an unknown route answers 404", unknown.status === 404, String(unknown.status));
    for (const [probeName, probe] of [["healthz", healthz], ["readyz", readyz]] as const) {
      const parsed = JSON.parse(probe.body) as Record<string, unknown>;
      // PR-2 — /healthz also states the image's provenance; /readyz does not change.
      const keys = probeName === "healthz" ? "executionEnabled,gitSha,provenance,ready,sourceDigest" : "executionEnabled,ready";
      assert(`${probeName} carries closed scalars only`,
        Object.keys(parsed).sort().join(",") === keys,
        Object.keys(parsed).join(","));
      if (probeName === "healthz") {
        assert("healthz reports the built commit, the git-computed digest, and provenance=recorded",
          parsed.gitSha === head && parsed.sourceDigest === expectedDigest && parsed.provenance === "recorded",
          probe.body.slice(0, 200));
      }
      const label = probeName;
      assert(`${label} reports executionEnabled=false`, parsed.executionEnabled === false);
      assert(`${label} leaks no identifier`,
        !/token|job|project|prompt|key|secret|ref/i.test(probe.body), probe.body);
    }

    // ----------------------------------------- cooperative shutdown
    // `docker stop` sends the image's STOPSIGNAL to PID 1 and waits.
    const stop = docker(["stop", "--time", "30", NAME]);
    assert("docker stop returns cleanly", stop.code === 0, stop.err.slice(0, 200));

    const logs = docker(["logs", NAME]);
    const out = `${logs.out}${logs.err}`;
    assert("the container emitted the cooperative stop event",
      /"event":"worker_execution_disabled_stopped"/.test(out),
      out.replace(/\s+/g, " ").slice(0, 200));
    assert("the stop event names SIGTERM", /"signal":"SIGTERM"/.test(out));
    assert("the stop event reports the health server closed",
      /"healthServerClosed":true/.test(out));
    assert("the start event reported the wildcard bind host",
      /"healthHost":"0\.0\.0\.0"/.test(out));
    assert("the start event reported the same provenance as /healthz",
      out.includes(`"provenance":"recorded","gitSha":"${head}","sourceDigest":"${expectedDigest}"`));
    assert("exactly two closed events, and no others",
      (out.match(/"event":/g) ?? []).length === 2,
      (out.match(/"event":"[a-z_]+"/g) ?? []).join(","));

    const rc = docker(["inspect", "--format", "{{.State.ExitCode}}", NAME]);
    assert("PID 1 exited 0 rather than being killed", rc.out.trim() === "0", rc.out.trim());
    const oom = docker(["inspect", "--format", "{{.State.OOMKilled}}", NAME]);
    assert("the container was not OOM-killed", oom.out.trim() === "false", oom.out.trim());

    let open = true;
    try { await get(hostPort, "/healthz"); } catch { open = false; }
    assert("the published port is closed after shutdown", !open, `port ${hostPort}`);
  } finally {
    // Exactly this container and this image. No prune, ever.
    if (started) {
      const rm = docker(["rm", "--force", NAME]);
      assert("the test container is removed", rm.code === 0, rm.err.slice(0, 160));
    }
    if (built) {
      const rmi = docker(["rmi", TAG]);
      assert("the test image is removed", rmi.code === 0, rmi.err.slice(0, 160));
      const left = docker(["images", "--quiet", TAG]);
      assert("no image remains under the test tag", left.out.trim() === "", left.out.trim());
    }
  }
}

// ═════════════════════════════════════════════════════════════ report
dockerHalf().then(() => {
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${checks} checks FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n${checks}/${checks} checks passed`
    + `${DOCKER_REQUESTED ? ", Docker half included" : ", static half only"}.`
    + " M0 worker hosting artefacts contract PASSED.");
}).catch((err: unknown) => {
  console.error(`\nharness error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
