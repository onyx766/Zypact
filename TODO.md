# Website Content Handoff v1

Branch: `feat/website-content-handoff-v1`

## Approved implementation checklist

- [x] Add the public `/about` page with approved copy and metadata.
- [x] Add the public `/method` page with approved copy and metadata.
- [x] Add `/about` and `/method` to suitable site navigation and footer links.
- [x] Add both routes to the indexable-paths list and sitemap.
- [x] Remove `/about` from the legacy 410 route map.
- [ ] Audit and preserve individual handling for stale routes such as `/how-it-works` and `/blog`.
- [x] Clarify the homepage synthetic `0.27` demonstration and distinguish it from customer impact or a universal threshold.
- [x] Verify the existing Newcombe calculation, classification rules, and failed/excluded-run treatment against public copy.
- [ ] Add the two approved optional `/scan` fields only after confirming storage and admin visibility requirements.
- [ ] Update database, validation, API, adapter, and admin presentation for those optional fields if storage is approved.
- [ ] Add/update SEO and route contract tests.
- [ ] Run focused tests, typecheck, and build; review the final diff for unintended scope.

## Scope guardrails

- Keep `/scan` as the request route.
- Do not change existing required fields, schemas, notifications, or submission semantics except for the approved optional fields.
- Do not add `/trials`, `/lab`, or unpublished comparison-page links.
- Do not change measurement methodology or product behavior to fit the illustrative copy.
- Do not handle G2 removal as a website code task.
