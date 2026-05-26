-- 20260526170000_pricing_tiers.sql
--
-- Date-based pricing tiers for tournaments. Replaces the
-- single-tier model (tournaments.entry_fee_cents +
-- tournaments.additional_event_fee_cents) with an ordered list
-- of tiers — each with its own window and its own first-event +
-- additional-event fees.
--
-- Four patterns the UI exposes, all driven by the same data:
--
--   Single price            → 1 tier, no dates.
--   Early bird              → 2 tiers, split by one date.
--   Early bird + Late fee   → 3 tiers, split by two dates.
--   Custom                  → N tiers with editable labels.
--
-- Pattern is stored as a separate column (`pricing_pattern`) — not
-- DERIVED from row count + label shape — so the public tournament
-- page knows which status pills to render ("Early Bird Registration
-- Open" / "Registration Open" / "Late Registration Open") without
-- pattern-matching on labels. Custom patterns use the organizer's
-- literal tier name on the public page instead of these preset
-- pills.
--
-- One concept, two surfaces. The tier dates ARE the public
-- lifecycle dates: setting "Early bird through Jun 15"
-- simultaneously (a) determines what a player pays before/after
-- Jun 15 and (b) flips the public status pill from "Early Bird
-- Registration Open" to "Registration Open" on Jun 16.
--
-- ─── Tier-window semantics ──────────────────────────────────────
--
-- starts_at = NULL means "from the beginning of time" (i.e. the
-- first tier in the list). ends_at = NULL means "until registration
-- closes" (i.e. the last tier).
--
-- ends_at is EXCLUSIVE. A tier "through Jun 15" stores
-- ends_at = 2026-06-16 00:00 UTC, and the next tier stores
-- starts_at = 2026-06-16 00:00 UTC. The active-tier helper uses
-- `< ends_at` to pick exactly one tier at any instant. The form
-- layer is responsible for translating the user-friendly "through
-- Jun 15" into "midnight after Jun 15" on save.
--
-- ─── Migration strategy ────────────────────────────────────────
--
-- Auto-collapse: every existing tournament becomes
-- pricing_pattern='single' with one tier holding the current
-- entry_fee_cents + additional_event_fee_cents. The legacy columns
-- stay in place for now; a follow-up migration drops them once all
-- read paths are confirmed on the new tier model.

set search_path = public, extensions;

-- ─────────────────────────────────────────────────────────────────────
-- Enum + column on tournaments
-- ─────────────────────────────────────────────────────────────────────

create type pricing_pattern as enum (
  'single',
  'early_bird',
  'early_bird_plus_late',
  'custom'
);

alter table public.tournaments
  add column pricing_pattern pricing_pattern not null default 'single';

comment on column public.tournaments.pricing_pattern is
  'Which of the four pricing patterns this tournament uses. Drives both the layout of the pricing step in the wizard and the public-status pill rendering on the public tournament page.';

-- ─────────────────────────────────────────────────────────────────────
-- Child table — one row per tier
-- ─────────────────────────────────────────────────────────────────────

create table public.tournament_pricing_tiers (
  id                            uuid primary key default gen_random_uuid(),
  tournament_id                 uuid not null references public.tournaments(id) on delete cascade,
  sort_order                    smallint not null,
  label                         text not null,
  starts_at                     timestamptz,
  ends_at                       timestamptz,
  first_event_fee_cents         integer not null default 0,
  additional_event_fee_cents    integer not null default 0,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  check (first_event_fee_cents >= 0),
  check (additional_event_fee_cents >= 0),
  check (starts_at is null or ends_at is null or starts_at < ends_at),
  unique (tournament_id, sort_order)
);

create index tournament_pricing_tiers_tournament_idx
  on public.tournament_pricing_tiers (tournament_id, sort_order);

create index tournament_pricing_tiers_window_idx
  on public.tournament_pricing_tiers (tournament_id, starts_at, ends_at);

create trigger pricing_tiers_updated_at before update
  on public.tournament_pricing_tiers
  for each row execute function public.set_updated_at();

comment on table public.tournament_pricing_tiers is
  'Ordered list of pricing windows for a tournament. starts_at/ends_at form a half-open interval [starts_at, ends_at). NULL on either end means "open-ended." See migration 20260526170000 for full semantics.';

-- ─────────────────────────────────────────────────────────────────────
-- RLS — mirror the events table's pattern
-- ─────────────────────────────────────────────────────────────────────

alter table public.tournament_pricing_tiers enable row level security;

create policy "pricing tiers read by parent visibility"
  on public.tournament_pricing_tiers
  for select using (
    exists (
      select 1 from public.tournaments t
      where t.id = tournament_pricing_tiers.tournament_id
        and t.deleted_at is null
        and (
          t.status in ('published', 'closed', 'completed')
          or public.is_org_member(t.organization_id)
        )
    )
  );

create policy "pricing tiers write by org admins"
  on public.tournament_pricing_tiers
  for all using (
    exists (
      select 1 from public.tournaments t
      where t.id = tournament_pricing_tiers.tournament_id
        and public.has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from public.tournaments t
      where t.id = tournament_pricing_tiers.tournament_id
        and public.has_org_role(t.organization_id, 'admin')
    )
  );

-- ─────────────────────────────────────────────────────────────────────
-- Backfill — every existing tournament gets a single "Standard" tier
-- holding its current entry_fee_cents + additional_event_fee_cents
-- ─────────────────────────────────────────────────────────────────────

insert into public.tournament_pricing_tiers (
  tournament_id, sort_order, label, starts_at, ends_at,
  first_event_fee_cents, additional_event_fee_cents
)
select
  id, 1, 'Standard', null, null,
  entry_fee_cents, additional_event_fee_cents
from public.tournaments
where not exists (
  select 1 from public.tournament_pricing_tiers t
  where t.tournament_id = tournaments.id
);

-- ─────────────────────────────────────────────────────────────────────
-- Helper — return the tier active for a given tournament + instant.
-- Returns NULL if no tier covers the instant (shouldn't happen if the
-- save flow keeps adjacent tier boundaries matched, but defined as
-- nullable rather than asserting).
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.current_pricing_tier(
  tournament_id_arg uuid,
  as_of timestamptz default now()
)
returns public.tournament_pricing_tiers
language sql
stable
security invoker
set search_path = public
as $$
  select *
    from public.tournament_pricing_tiers
   where tournament_id = tournament_id_arg
     and (starts_at is null or starts_at <= as_of)
     and (ends_at   is null or ends_at   >  as_of)
   order by sort_order
   limit 1;
$$;

comment on function public.current_pricing_tier(uuid, timestamptz) is
  'Returns the pricing tier active for a tournament at the given instant (default now()). Half-open interval semantics: starts_at <= as_of < ends_at.';
