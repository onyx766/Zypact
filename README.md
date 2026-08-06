# Zypact

AI visibility diagnostics for B2B SaaS marketing teams. Zypact tests real buyer
questions against AI search and reports where a brand is recommended, where it
is absent, and which competitors appear instead.

## Getting started

Run all commands from the repository root.

```bash
npm install
cp .env.example .env.local   # then fill in the values you need locally
npm run dev
```

## Validation

```bash
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
```

Targeted suites are registered in `package.json` under `test:*`, for example:

```bash
npm run test:snapshot-adapter-rpc-writes
npm run test:snapshot-worker-dml-revocation-contract
npm run test:snapshot-artifact-cascade-contract
```

The PostgreSQL Level 2 concurrency harness runs in CI against a disposable
PostgreSQL service container. It is triggered by changes to
`supabase/migrations/**`, the harness script, or its workflow file.

## Documentation

| Document | Contents |
| --- | --- |
| `DATABASE_SCHEMA.md` | Tables, columns, constraints, and the snapshot-report RPC surface |
| `docs/PR8_PRODUCTION_ROLLOUT.md` | Record of the RPC-only snapshot-report rollout |
| `docs/MVP_VALIDATION_REPORT.md` | Internal validation history |
| `docs/MVP-OPERATOR-RUNBOOK.md` | Operator procedures |
| `MVP_SCOPE.md`, `AGENT_PIPELINE.md` | Product scope and pipeline design |

## Database

Production and Preview are both at migration `0033`. Snapshot report writes go
through approved `SECURITY DEFINER` RPCs only — direct table writes to
`snapshot_requests` and `snapshot_report_artifacts` are revoked. See
`DATABASE_SCHEMA.md` for the full contract.
