-- 20260614140000_quote_studio_p2_rls.sql
--
-- Quote Studio Phase 2: platform-admin INSERT policies + event-size columns.
--
-- P1 created quote tables with anon INSERT only (public estimator).
-- P2 (admin quote builder) needs platform admins to also INSERT: to create
-- admin-sourced quotes and save new revisions from the editor.
--
-- Also adds event-size columns to quotes so the admin editor can recompute
-- organizer revenue and service quantities when working on a quote.

set search_path = public;

-- ── Platform-admin INSERT policies ─────────────────────────────────────────────

create policy "quote_customers platform_admin insert"
  on public.quote_customers
  for insert with check (is_platform_admin());

create policy "quotes platform_admin insert"
  on public.quotes
  for insert with check (is_platform_admin());

create policy "quote_revisions platform_admin insert"
  on public.quote_revisions
  for insert with check (is_platform_admin());

create policy "quote_line_items platform_admin insert"
  on public.quote_line_items
  for insert with check (is_platform_admin());

-- ── Event-size columns on quotes ───────────────────────────────────────────────
--
-- These are the inputs needed to recompute pricing in the admin editor:
-- num_events, num_entries, multi_event_players, and the organizer's own
-- registration fees. The public estimator page collects but does not persist
-- them; the admin editor reads and writes them.
--
-- All columns additive with sensible defaults; NOT NULL with defaults so
-- existing rows remain valid.

alter table public.quotes
  add column num_events            integer not null default 1  check (num_events > 0),
  add column num_entries           integer not null default 0  check (num_entries >= 0),
  add column multi_event_players   integer not null default 0  check (multi_event_players >= 0),
  add column first_event_fee_cents integer not null default 7000 check (first_event_fee_cents >= 0),
  add column additional_event_fee_cents integer not null default 2000 check (additional_event_fee_cents >= 0);
