-- 20260529150000_clear_event_fee_overrides.sql
--
-- One-time data normalization: clear per-event fee overrides.
--
-- events.event_fee_cents is an OPTIONAL per-event override — when
-- it's > 0, that event is charged a flat fee that BYPASSES the
-- tournament's entry-fee model entirely (first event = registration
-- fee, each additional = +additional fee). See migration
-- 20260524180000 and web/src/lib/pricing.ts.
--
-- In practice this trips organizers up: setting a per-event "fee"
-- that looks like the event's price actually overrides the whole
-- tournament-entry model, so a player registering for one event
-- pays the flat override instead of the (usually higher)
-- registration fee. Early test tournaments ended up with every
-- event carrying a redundant override equal to the additional-event
-- fee, which silently disabled the entry fee.
--
-- The intended model is: pay the tournament registration fee for
-- your first event (date-based via pricing tiers), +the additional
-- fee for each event after that. Per-event overrides are a rare
-- advanced case (e.g. a premium "Elite" division priced
-- differently) — they should be opt-in, not the default.
--
-- This migration zeroes every existing override so all events fall
-- through to their tournament's tier pricing. The override
-- CAPABILITY stays in the schema + pricing logic; organizers can
-- re-add a deliberate override per event from the events editor.
-- (Reversible: just re-enter a per-event price where one is wanted.)

set search_path = public;

update public.events
   set event_fee_cents = 0,
       updated_at = now()
 where event_fee_cents > 0
   and deleted_at is null;
