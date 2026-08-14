# Zypact Roadmap — V1, V2, V3

Scope boundaries for Zypact as an AI Buyer Journey Intelligence product. The
authoritative scope definition is
[`Zypact_V1_Engineering_Audit_Brief.md`](./Zypact_V1_Engineering_Audit_Brief.md).
This file is the short form.

Nothing here asserts that a listed item is implemented. Implementation status
lives in [`CURRENT_STATUS.md`](./CURRENT_STATUS.md), which is graded against
repository evidence.

## V1 — controlled scan

**Promise:** run a controlled scan, see where the brand loses an AI-assisted
buyer decision, inspect the evidence, choose the first fix worth testing, and
retest the same question.

V1 is a *controlled, founder-reviewed* workflow. It is not continuous and not
predictive.

| Area | V1 scope |
| --- | --- |
| Account | Account, login, basic profile, one company/workspace, one owner role |
| Onboarding | Company name, domain, category, audience, primary competitors |
| Mirror Profile | Site-derived profile with provenance, reviewable before it drives prompts |
| Buyer questions | Text, intent, priority, approval status, version, optional journey stage |
| Approval | Founder/user approves questions before any paid AI call |
| AI testing | Perplexity Sonar, same approved question run three times by default |
| Evidence | Exact outbound request and exact raw response preserved per run |
| Scoring | Mention, recommendation, position, verdict, cited-as-source, competitors, sources — all derived from stored runs |
| Competitors | Detected only from the relevant stored runs; aliases normalized without merging distinct products |
| Gap Map | Lost/partial/won per question, tied to exact questions and observed competitors |
| Fix | One controlled first action, `needs_evidence` when unverified |
| Retest | Same approved question, preserving prompt identity and version |
| Before/after | Dates, run counts, positions, competitors, citations, sampling caveats |
| Report | Client-facing report from canonical stored evidence, founder-reviewed before client-ready |
| Reliability | Budget reservation, run limits, fail-closed configuration, no duplicate paid runs, recoverable stages |

**Journey stages recommended for the V1 data model:** `discovery`, `research`,
`evaluation`, `comparison`, `decision`.

**V1 is done only when** a user can complete the core journey without a
developer editing the database or code; every result links to exact raw
evidence; brand, competitors, counts, verdicts and reports agree across the
system; insufficient evidence produces a limitation rather than invented
confidence; the same question can be retested and compared honestly; the
founder can review and approve the client-facing report; critical tests pass
through a documented repeatable command; and deployment plus rollback are
documented.

## V2 — continuous monitoring

Quoted separately. Not part of V1 pricing and not to be described as V1.

- Continuous weekly/monthly monitoring and configurable schedules
- Broader multi-platform AI coverage beyond the V1 Perplexity Sonar path
- Advanced AI Buyer Journey Intelligence and automatic journey expansion
- Historical visibility trends, movement analytics, and measured fix impact
- Continuous competitor intelligence
- Advanced automated evidence management
- Teams, roles, comments, and tasks
- CRM, Slack, and HubSpot integrations; public API; white-label; enterprise SSO
- Advanced/custom reporting, advanced alerts, advanced billing
- Native mobile application

## V3 — predictive buyer intelligence

Direction only. Not scoped, not estimated.

- Emerging decision risks before they show up as lost questions
- Competitor momentum
- Expected-impact prioritization of possible fixes

## Boundary rules

1. Continuous and predictive functionality must never be described as V1.
2. Multi-platform parity must not be implied while the live path is Perplexity
   Sonar only.
3. Anything in V2/V3 is excluded from V1 claims and V1 pricing unless quoted as
   a separate, explicitly listed option.
