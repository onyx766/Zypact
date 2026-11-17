# Worker deploy runbook — production protocol worker

- **Application:** `zypact-protocol-worker` (D-033), region `iad`
- **Config:** [`fly.worker.production.toml`](../fly.worker.production.toml)
- **Written:** 2026-10-02
- **Status:** procedure recorded; the open question in §3 is not resolved

## 1. Why this file exists

D-034's stop procedure says to "set the line back to `disabled` and redeploy".
D-036 says its slot fix "takes effect only when the production config is
redeployed". [`CURRENT_STATUS.md`](CURRENT_STATUS.md) §18.5 item 8 records that
it has not been.

Until this file, the repository contained no executable `fly` command anywhere —
three decisions depended on a redeploy that nothing described. This file supplies
the command sequence and, more importantly, the verification step that tells you
whether the deployed machine actually carries the bounds the committed file
declares. Nothing in the repository compared those two before now.

## 2. What a deploy of this config does and does not authorise

It does **not** grant new authorisation. `WORKER_EXECUTION_MODE = "live"` was
authorised by D-034 and is already committed; the bounds were set by D-036 and
are already committed. A deploy only makes the deployed machine match what `main`
already says.

It does not, by itself, spend. Spending requires a *started* machine that finds a
claimable job. `WORKER_EXIT_AFTER_CLAIMED_JOB = "true"` with `[[restart]] policy =
"never"` keeps one start to one job (D-034, D-036).

Deploying is **safe during the self-test freeze**:
[`SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md`](SELF_TEST_PERPLEXITY_CONTENT_CHANGE.md)
§6 names "worker configuration" in its safe-to-change list, because the worker is
not retrievable by the provider and cannot confound the artifact under
observation.

## 3. Open question — deploy-time machine state

**Unresolved. Do not treat the answer as known.**

Every safety statement in the config header and in D-033/D-034 says a machine is
*created* stopped. That is a claim about creation. Whether `fly deploy` against an
application whose machine already exists leaves that machine stopped, or starts it
to roll out the new image, is **not** established anywhere in this repository or
by any decision record. `[[restart]] policy = "never"` governs restarts after the
process exits; it is not a statement about deploy-time state.

**Mitigation, which makes the question moot rather than answering it: deploy only
while the job queue is empty.** A worker that starts against an empty queue claims
nothing, runs zero iterations and exits — precisely what the Phase 3C staging
evidence in §14 and §16 of `CURRENT_STATUS.md` demonstrates. Under those
conditions an unexpected deploy-time start costs nothing and proves nothing was
at risk.

Two consequences:

- **Never deploy between "Queue retest run" and "Run retest now"** (self-test §7
  steps 4 and 5). In that interval a job sits `queued` and a deploy-time start
  could claim it, outside the founder's intent and outside the console.
- Until D-052 is deployed (migration `20261109130000`, numbered `20261114120000` until 2026-11-17 (D-058), and a worker image
  built from it), the claim is unscoped (`CURRENT_STATUS.md` §18.5 item 2).
  Deploy D-052's worker after its migration and before its web app: the
  new worker, started by the old console, finds no run request and stops.
  Roll back in the reverse order: the web app first, then the worker.
  After it, a worker claims only the job a Run named and stops at once when
  no Run is pending, so a deploy-time start claims nothing; keep the empty
  queue rule anyway until a deploy has been observed under D-052.
- Before D-052:
  `claim_protocol_execution_job` takes the oldest eligible job *globally*. An
  empty queue is therefore the check, not "no job for this intervention".

If a future deploy is observed leaving the machine stopped or starting it, record
that observation here and promote it from an open question to a stated fact.

## 4. Timing

Deploy **days before** the retest, not on the day of it. If the machine is
destroyed and recreated, `FLY_WORKER_MACHINE_ID` must be updated on the Next.js
host and that deployment redeployed too (§7). Discovering that on the day the
observation window closes (2026-10-09) leaves no slack.

## 5. Prerequisites

```bash
git checkout main && git pull --ff-only
npm run test:m0-worker-hosting-contract
```

The contract must pass. Note what it proves: it is a **static check of the
committed files** against the inert template. It passed on `main` at `4440ddc`
with 141/141, static half only. It says nothing about any deployed machine — that
is the gap §6 step 5 closes.

Secrets are expected to be set already. The Supabase URL and project ref, the
service-role key, the Perplexity key and the analysis-provider key live in `fly
secrets` and are absent from the config by design. Do not add them to the toml:
the eleven `[env]` values are contract-locked, and the hosting contract fails on a
twelfth.

> **2026-11-17:** D-056's phase A (PR #121, merged) added the eleventh `[env]`
> value, `WORKER_CHATGPT_ENABLED = "false"`, and the hosting contract locks it.
> Check (d) in §6 confirms it on the machine. The production sequence is in
> [`PILOT_PRODUCTION_PLAN.md`](PILOT_PRODUCTION_PLAN.md), step 6.

## 6. The sequence

```bash
# 1. Confirm the account and the application you are pointed at
flyctl auth whoami
flyctl status -a zypact-protocol-worker

# 2. RECORD the current machine ID and state. You compare against this in step 5.
flyctl machine list -a zypact-protocol-worker
```

**3. Confirm the queue is empty** (§3). Either from the admin console, or:

```sql
select count(*) from protocol_execution_jobs
 where status in ('queued', 'claimed', 'running');   -- must be 0
```

Those three are the live statuses in migration `0050`. If the count is not zero,
stop: resolve the job first. Do not deploy past a non-empty queue.

```bash
# 4a. Provenance (PR-2). The build context must be exactly the commit you deploy:
#     this exits 1 on any edit or untracked file under the image source.
npm run verify:worker-provenance -- "$(git rev-parse HEAD)" --worktree

# 4b. Deploy, naming that commit. The image build refuses a missing or
#     malformed GIT_SHA, so a deploy without this argument fails to build.
flyctl deploy -c fly.worker.production.toml -a zypact-protocol-worker \
  --build-arg GIT_SHA="$(git rev-parse HEAD)"

# 5. Verify. This step is the point of the runbook.
flyctl machine list -a zypact-protocol-worker
flyctl machine status <MACHINE_ID> -a zypact-protocol-worker --json
```

Four things to check in step 5, in order:

| # | Check | If it fails |
|---|-------|-------------|
| a | Machine ID is unchanged from step 2 | Go to §7 |
| b | State is `stopped` | `flyctl machine stop <ID> -a zypact-protocol-worker`, then record the observation in §3 |
| c | `WORKER_MAX_SLOTS_PER_CLAIM` is `7` and `WORKER_MAX_RUNTIME_SECONDS` is `900` in the machine's env | The deploy did not land. Do not run a retest; `1` slot cannot complete a 5-run plan (D-036) |
| d | `WORKER_CHATGPT_ENABLED` is exactly `false` in the machine's env (D-056) | Stop. Do not start the machine; redeploy from the release commit. With anything but `"true"` the engine is off, but a value other than `false` means the config is not the committed one |

Check (c) is the only direct evidence that D-036 took effect. Record the values
you observed, not the values you expected.

**Provenance (PR-2).** Record the commit passed in step 4b and the digest
`npm run verify:worker-provenance -- <sha>` prints for it. The image reports
both (`gitSha`, `sourceDigest`, `provenance: "recorded"`) in its start event
(`worker_execution_disabled` / `worker_started`) and on its private `/healthz`,
so the first separately authorised start can be checked with
`npm run verify:worker-provenance -- <gitSha> --digest <sourceDigest>`. Anything
other than `provenance: "recorded"` and a match means the running image is not
the commit on record: stop it.

`recorded` proves only that the image's own two records (the
`ZYPACT_BUILD_GIT_SHA` environment value and `build-provenance.json`) are well
formed and agree. It does not prove the digest belongs to the claimed commit:
the `--digest` comparison above, which recomputes the digest from git, is
independent and **mandatory before production activation**. A live worker
refuses to start (`worker_provenance_refused`, exit 78) unless provenance is
`recorded`, so live execution is only possible from an image built with
`GIT_SHA`; it cannot run from a plain checkout.

## 7. If the machine ID changed

`FLY_WORKER_MACHINE_ID` is deployment state, not configuration (D-035). It lives
on the **Next.js host**, not on the worker. If the ID changed:

1. Update `FLY_WORKER_MACHINE_ID` on the web deployment to the new ID.
2. Redeploy the web application so the route reads the new value.
3. Confirm the admin console's start control responds rather than reporting that
   Fly has no such machine.

`FLY_WORKER_APP`, `FLY_WORKER_MACHINE_ID` and `FLY_API_TOKEN` are all-or-nothing:
with any one unset the start routes answer 503 and contact nothing. The token must
stay scoped to this application alone.

## 8. Stop procedure (D-034)

Either is sufficient, and neither requires more than it says:

- `flyctl machine stop <ID> -a zypact-protocol-worker` — a stopped machine cannot
  claim.
- Set `WORKER_EXECUTION_MODE = "disabled"` in the config and redeploy — the
  durable stop, since it survives a later start.

## 9. What this runbook does not cover

- Creating the application or the first machine. Both are operator acts that no
  decision record authorises implicitly (D-033, D-034).
- Setting or rotating secrets.
- Starting the worker to run a job. That is the founder console (self-test §7),
  and it is the step that spends.
- Worker health monitoring, alerting and operator recovery, which remain open
  (`CURRENT_STATUS.md` §9 item 11).

## 10. Record of deploys

Append one row per production deploy. An unrecorded deploy leaves the next reader
unable to tell what the running machine carries.

| Date | Commit | Machine ID before → after | State after | Slots / runtime observed | Notes |
|------|--------|---------------------------|-------------|--------------------------|-------|
| _(none yet)_ | | | | | D-036 not yet in effect |
