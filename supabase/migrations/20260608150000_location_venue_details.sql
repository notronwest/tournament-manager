-- 20260608150000_location_venue_details.sql
--
-- Structured venue-detail fields on public.locations (issue #120, spun
-- out of #18). Lets an org record court configuration for a saved venue
-- so players/organizers can judge facility fit before registering or
-- scheduling.
--
-- All fields are NULLABLE and additive — an existing location row, and
-- the venue add/edit form with every detail left blank, both continue
-- to save without error (AC #3). No RLS change: these columns inherit
-- the locations table's existing policies.
--
-- Enum vs text: net_type is a genuinely fixed pair, and surface_type
-- carries an `other` escape hatch backed by surface_notes — so both use
-- enums (house style; 11 enums already) for validation + to drive the
-- admin select lists, while `other` + notes keeps unusual surfaces
-- recordable without a future ALTER TYPE.

set search_path = public;

-- Enums ---------------------------------------------------------------
create type net_type as enum ('permanent', 'moveable');

create type surface_type as enum (
  'concrete',
  'asphalt',
  'cushion_core',
  'hardwood',
  'polycarbonate',
  'polyurethane',
  'other'
);

-- Columns -------------------------------------------------------------
alter table public.locations
  add column court_count           integer,
  add column net_type              net_type,
  add column surface_type          surface_type,
  add column surface_notes         text,
  add column ceiling_height_min_ft numeric(5, 2),
  add column ceiling_height_max_ft numeric(5, 2);

comment on column public.locations.court_count is
  'Number of courts at this venue (informational; nullable).';
comment on column public.locations.surface_notes is
  'Free-text detail, surfaced in the UI when surface_type = ''other''.';
comment on column public.locations.ceiling_height_min_ft is
  'Indoor ceiling clearance, feet. Min/max bound the lowest and highest points.';

-- Sanity checks (all permissive when the field is null) ---------------
alter table public.locations
  add constraint locations_court_count_range
    check (court_count is null or (court_count > 0 and court_count <= 200)),
  add constraint locations_ceiling_min_positive
    check (ceiling_height_min_ft is null or ceiling_height_min_ft > 0),
  add constraint locations_ceiling_max_positive
    check (ceiling_height_max_ft is null or ceiling_height_max_ft > 0),
  add constraint locations_ceiling_min_le_max
    check (
      ceiling_height_min_ft is null
      or ceiling_height_max_ft is null
      or ceiling_height_min_ft <= ceiling_height_max_ft
    );
