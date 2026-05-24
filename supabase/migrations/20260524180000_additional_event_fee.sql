-- 20260524180000_additional_event_fee.sql
--
-- Two-tier pricing for tournaments: first event at one rate,
-- additional events at a (usually cheaper) rate, plus optional
-- per-event overrides for special cases. Standard PickleballBrackets
-- structure — e.g. "$50 first event, $25 each additional."
--
-- Naming + semantics:
--
--   tournaments.entry_fee_cents              ← treated as "first
--                                              event fee" going
--                                              forward. Existing
--                                              column, no rename
--                                              (keeps RLS / types
--                                              stable and avoids
--                                              breaking any callers
--                                              that still read it).
--
--   tournaments.additional_event_fee_cents   ← NEW. Per-additional-
--                                              event surcharge.
--                                              Default 0 so existing
--                                              tournaments behave
--                                              identically to before
--                                              this migration: total
--                                              = entry_fee + sum of
--                                              per-event overrides.
--
--   events.event_fee_cents                   ← unchanged. Now an
--                                              optional per-event
--                                              OVERRIDE: when > 0,
--                                              this event always
--                                              costs exactly this
--                                              amount and is exempt
--                                              from the
--                                              first/additional
--                                              treatment. When 0,
--                                              the event uses the
--                                              tournament's first /
--                                              additional defaults
--                                              based on its position
--                                              in the player's
--                                              selection.
--
-- Pricing algorithm (computed client-side; see web/src/lib/pricing.ts):
--   1. For each selected event compute fullPrice + additionalPrice:
--        override     →  fullPrice = additionalPrice = override
--        no override  →  fullPrice = entry_fee, additionalPrice = additional
--   2. Sort selected events by fullPrice DESC.
--   3. First event in the sort → charged fullPrice.
--   4. Every other event → charged additionalPrice.
--   5. Total = sum.
--
-- The "sort by fullPrice DESC" rule gives the player the maximum
-- discount across their picks. Doing this client-side keeps the DB
-- write path simple — registrations still store the cents charged
-- per row in event_registrations.event_fee_cents, so the historical
-- record survives any future pricing changes.

set search_path = public;

alter table public.tournaments
  add column if not exists additional_event_fee_cents integer
    not null default 0
    check (additional_event_fee_cents >= 0);

comment on column public.tournaments.entry_fee_cents is
  'Fee for a player''s first event in the tournament. Default fallback when an event has no override.';

comment on column public.tournaments.additional_event_fee_cents is
  'Fee for each event AFTER the first. Default 0 means "additional events are free with entry." Per-event overrides on events.event_fee_cents bypass this.';

comment on column public.events.event_fee_cents is
  'Optional per-event override. When > 0, this exact fee applies regardless of how many events the player picks. When 0, the tournament''s entry_fee_cents / additional_event_fee_cents defaults apply.';
