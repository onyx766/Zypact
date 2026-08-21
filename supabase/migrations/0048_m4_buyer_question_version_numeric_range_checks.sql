-- M4 — buyer_question_versions numeric-scale range CHECK constraints.
--
-- DRAFT. Not applied to any database as of authoring. Requires a
-- separate, explicit authorization before `supabase db push`.
--
-- Context: migration 0047 declared commercial_value, winnability, and
-- priority as bare `integer not null` columns with NO range CHECK
-- constraint at all. A real staging incident (2026-08-21) sent a
-- 0.7/0.5 float fixture that Postgres rejected only via the plain
-- `integer` type check (error 22P02) — the intended 1..5/1..5/1..25
-- range contract was never enforced by the database itself, only by
-- the application-layer validator added afterward
-- (lib/db/validate-buyer-question-version-fields.ts, unchanged and
-- kept as a complementary, faster, clearer-message defense — this
-- migration does not replace it, it adds the same rule at the layer
-- the application validator cannot reach: any future direct SQL write,
-- a migration backfill, or a bug in a not-yet-written third adapter).
--
-- Confirmed before drafting this migration (read-only, staging
-- bfqpkfqsonixdnfiodwk):
--   select count(*) from buyer_question_versions;  -- => 0
-- The table is empty on staging, so adding these CHECK constraints
-- requires no backfill and cannot fail against any existing row.
--
-- Canonical contract (unchanged, matches
-- validateBuyerQuestionVersionNumericFields exactly):
--   - commercial_value: integer, 1..5
--   - winnability:      integer, 1..5   (never 1..25 — that is
--                                        priority's range, not
--                                        winnability's; do not
--                                        transpose them)
--   - priority:         integer, 1..25
--
-- Migration 0047 is NOT modified by this file — its 4 tables, 5 RPCs,
-- existing constraints, indexes, RLS, and grants are all untouched.
-- No backfill, no data write, no DELETE, no UPDATE anywhere below.

alter table public.buyer_question_versions
  add constraint buyer_question_versions_commercial_value_range_check
  check (commercial_value between 1 and 5);

alter table public.buyer_question_versions
  add constraint buyer_question_versions_winnability_range_check
  check (winnability between 1 and 5);

alter table public.buyer_question_versions
  add constraint buyer_question_versions_priority_range_check
  check (priority between 1 and 25);
