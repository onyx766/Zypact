> **Superseded historical record — archived 2026-08-16. Do not use this file for current product scope, methodology, engineering estimates, or operating decisions. Use the active canonical documentation listed in the repository README.**

# Zypact MVP Operator Runbook

## Safe order

1. Create a prompts file.
2. Add one buyer prompt per line.
3. Choose 3–5 explicit competitors.
4. Run dry-run first.
5. If the dry-run looks correct, run live.
6. Build package through the one-command flow.
7. Send only if QA passes.

## Create prompts file

Example path:

./exports/client-prompts.txt

Rules:

- One prompt per line
- Use buyer language
- Do not include the client brand in unbranded prompts
- Include one alternatives-style prompt
- Include one best-tool or best-software prompt

## Dry-run command

npx tsx scripts/run-mvp-client-flow.ts \
  --brand "Client Brand" \
  --domain "client.com" \
  --category "Client buying category" \
  --prompts-file ./exports/client-prompts.txt \
  --competitors "Competitor A,Competitor B,Competitor C" \
  --force-new-project \
  --probe-mode live \
  --scan-out ./exports/client-mvp-scan.md \
  --package-out ./exports/client-packages/client-brand \
  --dry-run

Expected:

dry-run complete: no paid probes, no writes.
package: skipped

## Live command

Only run after dry-run:

npx tsx scripts/run-mvp-client-flow.ts \
  --brand "Client Brand" \
  --domain "client.com" \
  --category "Client buying category" \
  --prompts-file ./exports/client-prompts.txt \
  --competitors "Competitor A,Competitor B,Competitor C" \
  --force-new-project \
  --probe-mode live \
  --scan-out ./exports/client-mvp-scan.md \
  --package-out ./exports/client-packages/client-brand

## Required safety checks

A sendable package must show:

- status: page_draft_blocked
- frameConsistency.status: passed
- QA: PASS with 0 failures and 0 warnings

Do not send if:

- frame_mismatch_detected
- frameConsistency.status: skipped
- QA failure
- simulated scan package

## Manual QA

npx tsx scripts/qa-client-package.ts ./exports/client-packages/client-brand

Expected:

Result: PASS (0 failures, 0 warnings)

## Important

Never run the placeholder example for client.com as a real scan.
Replace Client Brand, client.com, category, prompts file, competitors, scan-out, and package-out with the real prospect.

## Current fail-closed guards

The MVP runner now blocks common operator mistakes before a live scan.

### Guard 17A — Missing prompts file

Blocked when:

- `--prompts-file` points to a file that does not exist

Expected message:

Prompts file not found
Create the file first, with one buyer prompt per line.

### Guard 17B — Placeholder live command

Blocked in non-dry-run mode when brand/domain/category/competitors still contain examples such as:

- Client Brand
- Prospect Brand
- client.com
- prospect.com
- Exact buying category
- Competitor A / B / C

Dry-run is still allowed with placeholders.

### Guard 17C — Minimum prompts

Blocked when the prompts file has fewer than 3 usable prompts.

Rules:

- Empty lines are ignored
- Comment lines starting with # are ignored
- Minimum: 3 usable prompts
- Recommended: 5 prompts

### Guard 17D — Minimum competitors

Blocked when fewer than 2 competitors are provided.

Rules:

- Minimum: 2 competitors
- Recommended: 3–5 competitors
- This guard exists in both:
  - scripts/run-mvp-client-flow.ts
  - scripts/mvp-scan.ts

### Guard 17E — Hard placeholder prompts

Blocked in non-dry-run mode when prompts contain hard placeholders:

- [category]
- [buyer]
- [use case]
- {placeholder}
- <placeholder>

Dry-run is still allowed.

Soft generic wording such as “buyer enablement” must not be blocked.

### Guard 17F — Typecheck

Before considering the MVP safe, run:

npx tsc --noEmit && echo "✅ Typecheck passed"

Expected:

✅ Typecheck passed
