# Sprint 14A — One-command MVP scan

The Sprint 13C engine is frozen. This command only orchestrates the existing engine.
It should not change scorecard, probe analysis, competitor discovery, Gap Map, Fix Brief, Evidence Bank, asset, or QA logic.

## Dry run

```bash
python3 scripts/run-with-env.py npm run mvp:scan -- \
  --brand "Example" \
  --domain "example.com" \
  --category "B2B SaaS" \
  --userId "a76f133a-b3ef-4440-b418-dddb3e1ea524" \
  --prompts 5 \
  --runs 3 \
  --probe-mode live \
  --budget-usd 2.00 \
  --dry-run
```

## Live scan

```bash
python3 scripts/run-with-env.py npm run mvp:scan -- \
  --brand "Example" \
  --domain "example.com" \
  --category "B2B SaaS" \
  --userId "a76f133a-b3ef-4440-b418-dddb3e1ea524" \
  --prompts 5 \
  --runs 3 \
  --probe-mode live \
  --budget-usd 2.00
```

## Simulated scan

Use this for a free orchestration test. It does not call Perplexity and forces mock LLM mode.

```bash
python3 scripts/run-with-env.py npm run mvp:scan -- \
  --brand "Example" \
  --domain "example.com" \
  --category "B2B SaaS" \
  --probe-mode simulated \
  --prompts 2 \
  --runs 1
```

## Output

By default, reports are written to:

```text
./exports/<brand-slug>-mvp-scan-<YYYYMMDD-HH>.md
```

Use `--out ./custom.md` to override.

At the end, the command prints:

- projectId
- report path
- probe mode
- probes saved
- commercial scorecard
- top competitors
- prioritized gaps
- current Fix Brief type/status
- API cost estimate

## Resume behavior

The runner reuses the latest project for the same `userId + domain` and resumes from stored DB state:

- existing project is reused
- existing Mirror Profile is reused
- existing prompts are reused
- existing Evidence Bank is reused
- existing prompt/run rows are counted so paid probes are not repeated

If a live run is interrupted after some probes, rerun the same command. The runner only runs missing prompt/run combinations.
