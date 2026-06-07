-- 20260607130000_org_locations.sql
--
-- Org-level saved locations (issue #18). An organization keeps a list
-- of reusable venues (name + address); the wizard's Basics step picks
-- one or inline-creates a new one, and one location per org can be the
-- default (pre-selected on every new tournament).
--
-- Migration strategy for the existing free-text location fields:
--   tournaments.location_name / location_address STAY as a fallback so
--   existing tournaments don't break. We add a nullable
--   tournaments.location_id FK; the public page + admin read the joined
--   location row when location_id is set, else fall back to the legacy
--   text fields. A later migration can backfill + drop the legacy
--   columns once every tournament references a location row.
--
-- Soft-delete via deleted_at, consistent with the other long-lived
-- entities. "One default per org" is enforced by a partial unique
-- index over live (non-deleted) rows.

set search_path = public;

create table public.locations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  address         text,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.locations is
  'Reusable org-level venues. Referenced by tournaments.location_id; legacy tournaments.location_name/address remain as a fallback.';

-- At most one default location per org among live rows.
create unique index locations_one_default_per_org
  on public.locations (organization_id)
  where is_default and deleted_at is null;

create index locations_org_live_idx
  on public.locations (organization_id)
  where deleted_at is null;

-- Nullable FK from tournaments. on delete set null is defensive only —
-- locations soft-delete, so a live tournament should never see its
-- location hard-deleted out from under it.
alter table public.tournaments
  add column location_id uuid references public.locations(id) on delete set null;

comment on column public.tournaments.location_id is
  'Optional FK to a saved org location. When set, takes precedence over the legacy location_name/location_address free-text fields.';

-- RLS ----------------------------------------------------------------
alter table public.locations enable row level security;

-- Read: org members see all their org's locations (management page +
-- wizard picker). The public sees a location only when it is attached
-- to a publicly-visible tournament (so the public page can show the
-- venue) — never the org's full venue list.
create policy "locations read by org or via published tournament" on public.locations
  for select using (
    deleted_at is null
    and (
      is_org_member(organization_id)
      or exists (
        select 1 from public.tournaments t
        where t.location_id = locations.id
          and t.deleted_at is null
          and t.status in ('published', 'closed', 'completed')
      )
    )
  );

-- Write: org admins manage the location list. Matches the tournaments
-- write policy, so an admin running the wizard can inline-create.
create policy "locations write by org admins" on public.locations
  for all using (has_org_role(organization_id, 'admin'))
         with check (has_org_role(organization_id, 'admin'));
