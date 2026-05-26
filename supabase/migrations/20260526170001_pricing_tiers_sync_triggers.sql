-- 20260526170001_pricing_tiers_sync_triggers.sql
--
-- Forward-sync triggers: keep tier 1 in lock-step with the legacy
-- tournaments.entry_fee_cents + additional_event_fee_cents columns
-- for single-pattern tournaments.
--
-- ─── Why this exists ────────────────────────────────────────────
--
-- After 20260526170000_pricing_tiers.sql, the new source of truth
-- for pricing is the tournament_pricing_tiers table, and the public
-- + checkout pages read from there. But the existing admin form
-- (TournamentFormPage) still writes to the legacy entry_fee_cents
-- / additional_event_fee_cents columns. Without these triggers, an
-- admin saving a price change in the existing form would silently
-- diverge from what players see on the public page.
--
-- Forward triggers keep the system consistent until the new
-- multi-tier wizard ships:
--
--   INSERT on tournaments  →  create tier 1 mirroring the new row
--   UPDATE on tournaments  →  update tier 1 to match if the legacy
--                             fee columns changed and pattern='single'
--
-- For multi-tier patterns (early_bird, early_bird_plus_late,
-- custom), the triggers DON'T fire on UPDATE — those tournaments
-- own their tiers directly and the legacy columns are ignored.
-- The new wizard, when it ships, will write to tiers directly and
-- leave the legacy columns alone.
--
-- ─── Eventual cleanup ───────────────────────────────────────────
--
-- A future migration drops the legacy columns once every read path
-- has moved to tiers. At that point these triggers also get dropped
-- (they're targeting columns that no longer exist).

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- AFTER INSERT — create tier 1 for new tournaments
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.create_single_tier_on_tournament_insert()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Defensive guard: if a tier row already exists for this tournament
  -- (e.g. inserted in the same transaction via the new wizard), don't
  -- create a duplicate. This lets the trigger live alongside the new
  -- wizard's direct-tier writes without conflict.
  if exists (
    select 1 from public.tournament_pricing_tiers
    where tournament_id = NEW.id
  ) then
    return NEW;
  end if;

  insert into public.tournament_pricing_tiers (
    tournament_id, sort_order, label, starts_at, ends_at,
    first_event_fee_cents, additional_event_fee_cents
  ) values (
    NEW.id, 1, 'Standard', null, null,
    coalesce(NEW.entry_fee_cents, 0),
    coalesce(NEW.additional_event_fee_cents, 0)
  );
  return NEW;
end;
$$;

create trigger tournaments_create_single_tier
  after insert on public.tournaments
  for each row execute function public.create_single_tier_on_tournament_insert();

-- ─────────────────────────────────────────────────────────────────────
-- AFTER UPDATE — keep tier 1 in sync with legacy fee column edits
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.sync_single_tier_on_tournament_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Only sync for single-pattern tournaments. Multi-tier patterns
  -- own their tiers directly; legacy column edits on those would be
  -- a programming error to begin with (and shouldn't happen — the
  -- new wizard won't touch legacy columns).
  if NEW.pricing_pattern <> 'single' then
    return NEW;
  end if;

  -- Only fire if a legacy fee column actually changed. Avoids
  -- spurious tier updates on unrelated tournament edits (name,
  -- description, etc.).
  if OLD.entry_fee_cents is not distinct from NEW.entry_fee_cents
     and OLD.additional_event_fee_cents is not distinct from NEW.additional_event_fee_cents
  then
    return NEW;
  end if;

  update public.tournament_pricing_tiers
     set first_event_fee_cents = coalesce(NEW.entry_fee_cents, 0),
         additional_event_fee_cents = coalesce(NEW.additional_event_fee_cents, 0),
         updated_at = now()
   where tournament_id = NEW.id
     and sort_order = 1;
  return NEW;
end;
$$;

create trigger tournaments_sync_single_tier
  after update on public.tournaments
  for each row execute function public.sync_single_tier_on_tournament_update();
