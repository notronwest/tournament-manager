-- 20260614130000_quote_studio_p1.sql
--
-- Quote Studio Phase 1: service catalog + lead-capture data model.
--
-- New tables:
--   service_catalog    — the priced WMPC services, seeded from the pricing doc
--   quote_customers    — sales leads / prospects (not org tenants)
--   quotes             — one record per proposal conversation
--   quote_revisions    — append-only pricing snapshots per quote
--   quote_line_items   — one row per service in a revision
--
-- RLS posture:
--   service_catalog   : public SELECT (active rows only); writes = platform_admin
--   quote_customers   : anon INSERT; SELECT/UPDATE/DELETE = platform_admin
--   quotes            : anon INSERT; SELECT/UPDATE/DELETE = platform_admin
--   quote_revisions   : anon INSERT; SELECT/UPDATE/DELETE = platform_admin
--   quote_line_items  : anon INSERT; SELECT/UPDATE/DELETE = platform_admin
--
-- is_platform_admin() helper already exists (20260608130000_platform_settings.sql).

set search_path = public;

-- ── Enums ─────────────────────────────────────────────────────────────────────

create type public.quote_status as enum
  ('submitted', 'draft', 'quoted', 'accepted', 'declined');

create type public.quote_source as enum
  ('public', 'admin');

create type public.quote_platform as enum
  ('bertanderne', 'pickleballbrackets');

create type public.service_category as enum
  ('core', 'setup', 'branding', 'awards', 'equipment', 'media');

create type public.service_unit as enum
  ('per_day', 'per_event', 'per_player', 'per_entrant', 'flat', 'each');

create type public.quote_revision_creator as enum
  ('public', 'admin', 'customer');

-- ── service_catalog ───────────────────────────────────────────────────────────

create table public.service_catalog (
  id                     uuid        primary key default gen_random_uuid(),
  key                    text        not null unique,
  name                   text        not null,
  category               service_category not null,
  unit                   service_unit not null,
  unit_price_cents       integer     not null check (unit_price_cents >= 0),
  plus_passthrough_cost  boolean     not null default false,
  active                 boolean     not null default true,
  sort_order             integer     not null default 0,
  notes                  text,
  created_at             timestamptz not null default now()
);

comment on table public.service_catalog is
  'Priced WMPC services available for quotes. Seeded from the pricing doc; admin-editable in P2.';

alter table public.service_catalog enable row level security;

-- Public can read active services (the estimator page needs prices).
create policy "service_catalog public select active"
  on public.service_catalog
  for select using (active = true);

-- Platform admins can read all (including inactive).
create policy "service_catalog platform_admin select all"
  on public.service_catalog
  for select using (is_platform_admin());

create policy "service_catalog platform_admin insert"
  on public.service_catalog
  for insert with check (is_platform_admin());

create policy "service_catalog platform_admin update"
  on public.service_catalog
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "service_catalog platform_admin delete"
  on public.service_catalog
  for delete using (is_platform_admin());

-- ── quote_customers ───────────────────────────────────────────────────────────

create table public.quote_customers (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  email      text        not null,
  phone      text,
  org_name   text,
  notes      text,
  created_at timestamptz not null default now()
);

comment on table public.quote_customers is
  'Sales leads and prospects captured from the public estimator. Not the same as organizations — these are pre-tenant contacts.';

alter table public.quote_customers enable row level security;

-- Anonymous visitors may insert (public submission).
create policy "quote_customers anon insert"
  on public.quote_customers
  for insert to anon with check (true);

create policy "quote_customers platform_admin select"
  on public.quote_customers
  for select using (is_platform_admin());

create policy "quote_customers platform_admin update"
  on public.quote_customers
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "quote_customers platform_admin delete"
  on public.quote_customers
  for delete using (is_platform_admin());

-- ── quotes ────────────────────────────────────────────────────────────────────

create table public.quotes (
  id              uuid          primary key default gen_random_uuid(),
  customer_id     uuid          references public.quote_customers(id) on delete set null,
  status          quote_status  not null default 'submitted',
  source          quote_source  not null default 'public',
  event_name      text,
  event_dates     text,
  num_days        integer       not null check (num_days > 0),
  distance_miles  integer       not null default 0 check (distance_miles >= 0),
  platform        quote_platform not null default 'bertanderne',
  created_at      timestamptz   not null default now()
);

comment on table public.quotes is
  'One record per proposal conversation. Customer_id nullable until the lead is linked to a registered user.';

alter table public.quotes enable row level security;

create policy "quotes anon insert"
  on public.quotes
  for insert to anon with check (true);

create policy "quotes platform_admin select"
  on public.quotes
  for select using (is_platform_admin());

create policy "quotes platform_admin update"
  on public.quotes
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "quotes platform_admin delete"
  on public.quotes
  for delete using (is_platform_admin());

-- ── quote_revisions ───────────────────────────────────────────────────────────

create table public.quote_revisions (
  id                       uuid                   primary key default gen_random_uuid(),
  quote_id                 uuid                   not null references public.quotes(id) on delete cascade,
  revision_number          integer                not null default 1,
  created_by               quote_revision_creator not null default 'public',
  subtotal_cents           integer                not null default 0,
  estimated_revenue_cents  integer                not null default 0,
  estimated_net_cents      integer                not null default 0,
  is_current               boolean                not null default true,
  notes                    text,
  created_at               timestamptz            not null default now(),

  unique (quote_id, revision_number)
);

comment on table public.quote_revisions is
  'Append-only pricing snapshots. One revision per quote save; is_current=true marks the live version.';

alter table public.quote_revisions enable row level security;

create policy "quote_revisions anon insert"
  on public.quote_revisions
  for insert to anon with check (true);

create policy "quote_revisions platform_admin select"
  on public.quote_revisions
  for select using (is_platform_admin());

create policy "quote_revisions platform_admin update"
  on public.quote_revisions
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "quote_revisions platform_admin delete"
  on public.quote_revisions
  for delete using (is_platform_admin());

-- ── quote_line_items ──────────────────────────────────────────────────────────

create table public.quote_line_items (
  id                     uuid    primary key default gen_random_uuid(),
  revision_id            uuid    not null references public.quote_revisions(id) on delete cascade,
  service_key            text    not null,
  label                  text    not null,
  qty                    integer not null check (qty > 0),
  unit_price_cents       integer not null check (unit_price_cents >= 0),
  passthrough_cost_cents integer not null default 0 check (passthrough_cost_cents >= 0),
  line_total_cents       integer not null check (line_total_cents >= 0)
);

comment on table public.quote_line_items is
  'One row per service line in a quote revision. unit_price_cents is a snapshot — overridable by admin in P2.';

alter table public.quote_line_items enable row level security;

create policy "quote_line_items anon insert"
  on public.quote_line_items
  for insert to anon with check (true);

create policy "quote_line_items platform_admin select"
  on public.quote_line_items
  for select using (is_platform_admin());

create policy "quote_line_items platform_admin update"
  on public.quote_line_items
  for update using (is_platform_admin()) with check (is_platform_admin());

create policy "quote_line_items platform_admin delete"
  on public.quote_line_items
  for delete using (is_platform_admin());

-- ── Seed service_catalog ──────────────────────────────────────────────────────
--
-- Values from the "Tournament Management — Services & Pricing" Google Doc.
-- sort_order matches the table order in the doc.

insert into public.service_catalog
  (key, name, category, unit, unit_price_cents, plus_passthrough_cost, sort_order, notes)
values
  -- Core
  ('onsite_mgmt_day',    'On-site tournament management',            'core',      'per_day',     50000, false,  10, null),
  ('registration_be',    'Registration (BertAndErne)',                'core',      'per_entrant',   200, false,  20, 'WMPC platform fee per event registration on BertAndErne'),
  ('registration_pb',    'Registration (PickleballBrackets)',         'core',      'per_entrant',   500, false,  30, 'WMPC platform fee per event registration on PickleballBrackets'),

  -- Setup
  ('create_tournament',  'Create the tournament',                    'setup',     'flat',        10000, false,  40, null),
  ('configure_event',    'Configure each event/division',            'setup',     'per_event',     500, false,  50, null),

  -- Branding
  ('event_theme',        'Event theme development',                  'branding',  'flat',        10000, false,  60, null),
  ('flyer',              'Tournament flyer',                         'branding',  'flat',        15000, false,  70, null),
  ('logo',               'Tournament logo',                          'branding',  'flat',        20000, false,  80, null),
  ('social_graphic',     'Social media graphic',                     'branding',  'flat',         7500, false,  90, null),

  -- Awards
  ('medals',             'Medals — sourcing & config',               'awards',    'flat',         5000, true,  100, 'Price is $50 + cost of medals; passthrough_cost_cents covers the medal cost'),

  -- Equipment
  ('pa_system',          'PA system',                                'equipment', 'per_day',      7500, false, 110, null),
  ('ball_baskets',       'Ball baskets',                             'equipment', 'flat',          2500, false, 120, null),
  ('pickleballs',        'Pickleballs',                              'equipment', 'each',           200, false, 130, null),

  -- Media
  ('livestream',         'Live stream (up to 2 courts, YouTube)',    'media',     'per_day',     10000, false, 140, null),
  ('video_review',       'Player video review (PPR coach)',          'media',     'per_player',   5000, false, 150, null);
