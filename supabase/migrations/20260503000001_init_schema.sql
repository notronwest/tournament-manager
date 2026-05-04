-- 20260503000001_init_schema.sql
-- Tournament Manager — initial schema.
--
-- Design decisions baked in:
--   * Multi-tenant: organizations are tenants; every domain table is scoped
--     by organization_id (directly or transitively via tournament).
--   * Players are SHARED (not org-scoped) — one record per human, used
--     across orgs. DUPR / PB Vision / WMPC ratings follow the player.
--     auth_user_id is nullable; organizers can pre-create player records
--     before those players claim accounts.
--   * Email is soft-unique on players (indexed for lookup, NOT a unique
--     constraint — supports parent+child sharing one email).
--   * Doubles teams: ONE event_registrations row per player; pair via
--     partner_registration_id self-FK. Each player pays their own fee.
--   * Soft delete via deleted_at on long-lived entities (players,
--     organizations, tournaments, events, registrations).
--   * RLS enabled on every table; helper functions is_org_member() /
--     has_org_role() / current_player_id() centralize the auth checks.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;   -- gen_random_uuid(), gen_random_bytes()
create extension if not exists citext;     -- case-insensitive email

-- ─────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────

create type org_role              as enum ('owner', 'admin', 'staff');
create type org_stripe_status     as enum ('not_connected', 'pending', 'active', 'restricted');

create type player_gender         as enum ('M', 'F', 'X');
create type rating_source         as enum ('dupr', 'pbvision', 'wmpc_rating_hub');

create type tournament_status     as enum ('draft', 'published', 'closed', 'completed', 'cancelled');

create type event_format          as enum ('singles', 'doubles');
create type event_gender          as enum ('men', 'women', 'mixed');
create type bracket_type          as enum ('round_robin', 'single_elim', 'double_elim', 'pool_then_bracket');

create type registration_status   as enum ('pending_payment', 'paid', 'refunded', 'cancelled', 'withdrawn');
create type partner_status        as enum ('solo', 'pending', 'confirmed', 'declined');
create type partner_invite_status as enum ('pending', 'accepted', 'declined', 'cancelled', 'expired');

create type payment_status        as enum ('pending', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded');

-- ─────────────────────────────────────────────────────────────────────
-- updated_at trigger function (reused on every table with updated_at)
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- organizations (tenants)
-- ─────────────────────────────────────────────────────────────────────

create table organizations (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique,
  name                     text not null,
  contact_email            citext,
  stripe_account_id        text,
  stripe_account_status    org_stripe_status not null default 'not_connected',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);
create index organizations_active_idx on organizations (deleted_at) where deleted_at is null;

create trigger orgs_updated_at before update on organizations
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- organization_members (links auth.users → organizations)
-- ─────────────────────────────────────────────────────────────────────

create table organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            org_role not null default 'staff',
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on organization_members (user_id);

-- ─────────────────────────────────────────────────────────────────────
-- players (shared global record, not org-scoped)
-- ─────────────────────────────────────────────────────────────────────

create table players (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  email           citext,
  phone           text,
  first_name      text not null,
  last_name       text not null,
  dob             date,
  gender          player_gender,
  city            text,
  state           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
-- Name lookup for partner search / dedup UI.
create index players_name_idx on players (lower(last_name), lower(first_name));
-- Soft-unique email — indexed for fast lookup, NOT a unique constraint.
create index players_email_idx on players (email);
create index players_active_idx on players (deleted_at) where deleted_at is null;

create trigger players_updated_at before update on players
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- player_ratings (history; one row per (player, source) snapshot)
-- ─────────────────────────────────────────────────────────────────────

create table player_ratings (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players(id) on delete cascade,
  source          rating_source not null,
  score           numeric(4,2),
  category        text,        -- 'singles'/'doubles'/'mixed' — varies by source
  as_of           date not null,
  raw             jsonb,
  created_at      timestamptz not null default now()
);
create index player_ratings_lookup_idx on player_ratings (player_id, source, as_of desc);

-- ─────────────────────────────────────────────────────────────────────
-- tournaments
-- ─────────────────────────────────────────────────────────────────────

create table tournaments (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organizations(id) on delete restrict,
  slug                     text not null,
  name                     text not null,
  description              text,
  location_name            text,
  location_address         text,
  starts_at                timestamptz not null,
  ends_at                  timestamptz not null,
  registration_opens_at    timestamptz,
  registration_closes_at   timestamptz,
  entry_fee_cents          integer not null default 0,
  status                   tournament_status not null default 'draft',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (organization_id, slug),
  check (ends_at >= starts_at),
  check (entry_fee_cents >= 0)
);
create index tournaments_org_status_idx on tournaments (organization_id, status, starts_at desc);
create index tournaments_published_idx on tournaments (status, starts_at) where deleted_at is null;

create trigger tournaments_updated_at before update on tournaments
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- events (skill/age/gender brackets within a tournament)
-- ─────────────────────────────────────────────────────────────────────

create table events (
  id                  uuid primary key default gen_random_uuid(),
  tournament_id       uuid not null references tournaments(id) on delete cascade,
  name                text not null,
  format              event_format not null,
  gender              event_gender not null,
  min_age             smallint,
  max_age             smallint,
  min_rating          numeric(4,2),
  max_rating          numeric(4,2),
  rating_source       rating_source,
  bracket_type        bracket_type not null default 'round_robin',
  event_fee_cents     integer not null default 0,
  max_teams           smallint,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  check (event_fee_cents >= 0),
  check (min_age is null or max_age is null or min_age <= max_age),
  check (min_rating is null or max_rating is null or min_rating <= max_rating)
);
create index events_tournament_idx on events (tournament_id) where deleted_at is null;

create trigger events_updated_at before update on events
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- registrations (tournament-level — entry fee captured here)
-- ─────────────────────────────────────────────────────────────────────

create table registrations (
  id                  uuid primary key default gen_random_uuid(),
  tournament_id       uuid not null references tournaments(id) on delete restrict,
  player_id           uuid not null references players(id) on delete restrict,
  entry_fee_cents     integer not null,
  status              registration_status not null default 'pending_payment',
  registered_at       timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (tournament_id, player_id)
);
create index registrations_player_idx on registrations (player_id);

create trigger registrations_updated_at before update on registrations
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- event_registrations (one row per player per event; pair via self-FK)
-- ─────────────────────────────────────────────────────────────────────

create table event_registrations (
  id                       uuid primary key default gen_random_uuid(),
  event_id                 uuid not null references events(id) on delete restrict,
  player_id                uuid not null references players(id) on delete restrict,
  partner_registration_id  uuid references event_registrations(id) on delete set null,
  partner_status           partner_status not null default 'solo',
  event_fee_cents          integer not null,
  status                   registration_status not null default 'pending_payment',
  seed                     smallint,
  registered_at            timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (event_id, player_id)
);
create index event_registrations_event_idx on event_registrations (event_id) where deleted_at is null;
create index event_registrations_player_idx on event_registrations (player_id);
create index event_registrations_partner_idx on event_registrations (partner_registration_id);

create trigger event_regs_updated_at before update on event_registrations
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- partner_invites (doubles partner accept/decline flow)
-- ─────────────────────────────────────────────────────────────────────

create table partner_invites (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references events(id) on delete cascade,
  inviter_player_id   uuid not null references players(id) on delete cascade,
  invitee_player_id   uuid not null references players(id) on delete cascade,
  invitee_email       citext,
  status              partner_invite_status not null default 'pending',
  token               text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  expires_at          timestamptz,
  responded_at        timestamptz,
  created_at          timestamptz not null default now(),
  check (inviter_player_id <> invitee_player_id)
);
create index partner_invites_invitee_idx on partner_invites (invitee_player_id, status);
create index partner_invites_inviter_idx on partner_invites (inviter_player_id);

-- ─────────────────────────────────────────────────────────────────────
-- payments (Stripe Connect — destination charge model)
-- ─────────────────────────────────────────────────────────────────────

create table payments (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null references organizations(id) on delete restrict,
  player_id                     uuid not null references players(id) on delete restrict,
  registration_id               uuid references registrations(id) on delete set null,
  stripe_payment_intent_id      text unique,
  stripe_charge_id              text,
  stripe_connected_account_id   text,
  amount_cents                  integer not null,
  platform_fee_cents            integer not null default 0,
  status                        payment_status not null default 'pending',
  failure_message               text,
  raw                           jsonb,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index payments_org_status_idx on payments (organization_id, status);
create index payments_player_idx on payments (player_id);
create index payments_registration_idx on payments (registration_id);

create trigger payments_updated_at before update on payments
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- payment_line_items (one payment can cover entry + multiple events)
-- ─────────────────────────────────────────────────────────────────────

create table payment_line_items (
  id                       uuid primary key default gen_random_uuid(),
  payment_id               uuid not null references payments(id) on delete cascade,
  event_registration_id    uuid references event_registrations(id) on delete restrict,
  description              text not null,    -- "Entry fee" / "Event: Men's 4.0 Doubles"
  amount_cents             integer not null
);
create index payment_line_items_payment_idx on payment_line_items (payment_id);
create index payment_line_items_event_reg_idx on payment_line_items (event_registration_id);

-- ─────────────────────────────────────────────────────────────────────
-- audit_log (generic admin event log)
-- ─────────────────────────────────────────────────────────────────────

create table audit_log (
  id              bigserial primary key,
  organization_id uuid references organizations(id) on delete cascade,
  actor_user_id   uuid references auth.users(id) on delete set null,
  entity_type     text not null,
  entity_id       uuid,
  action          text not null,
  data            jsonb,
  created_at      timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (organization_id, created_at desc);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

-- ─────────────────────────────────────────────────────────────────────
-- Helper functions used by RLS policies
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org and user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(org uuid, min_role org_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org
      and user_id = auth.uid()
      and case min_role
            when 'staff' then true
            when 'admin' then role in ('admin', 'owner')
            when 'owner' then role = 'owner'
          end
  );
$$;

-- Returns the players.id linked to the current auth user, or NULL.
create or replace function public.current_player_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from players where auth_user_id = auth.uid() limit 1;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Auto-add the org creator as 'owner' on insert
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.add_org_creator_as_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    insert into organization_members (organization_id, user_id, role)
    values (new.id, auth.uid(), 'owner')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger orgs_add_creator after insert on organizations
  for each row execute function public.add_org_creator_as_owner();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — enable on every table
-- ─────────────────────────────────────────────────────────────────────

alter table organizations         enable row level security;
alter table organization_members  enable row level security;
alter table players               enable row level security;
alter table player_ratings        enable row level security;
alter table tournaments           enable row level security;
alter table events                enable row level security;
alter table registrations         enable row level security;
alter table event_registrations   enable row level security;
alter table partner_invites       enable row level security;
alter table payments              enable row level security;
alter table payment_line_items    enable row level security;
alter table audit_log             enable row level security;

-- ─────────────────────────────────────────────────────────────────────
-- RLS — policies
-- Note: multiple policies for the same action are OR'd together. Keep
-- this surface small and explicit; tighten as features land.
-- payments INSERT/UPDATE intentionally have NO policy — all writes go
-- through edge functions using the service_role key (which bypasses RLS).
-- ─────────────────────────────────────────────────────────────────────

-- organizations
create policy "orgs read public" on organizations
  for select using (deleted_at is null);
create policy "orgs insert authenticated" on organizations
  for insert to authenticated with check (true);
create policy "orgs update by admins" on organizations
  for update using (has_org_role(id, 'admin'));

-- organization_members
create policy "members read own orgs" on organization_members
  for select using (is_org_member(organization_id));
create policy "members managed by admins" on organization_members
  for all using (has_org_role(organization_id, 'admin'))
         with check (has_org_role(organization_id, 'admin'));

-- players (basic info readable; updates limited to self or org members
-- with a registration relationship)
create policy "players read public" on players
  for select using (deleted_at is null);
create policy "players insert authenticated" on players
  for insert to authenticated with check (true);
create policy "players update by self or related org" on players
  for update using (
    auth_user_id = auth.uid()
    or exists (
      select 1 from event_registrations er
      join events e on e.id = er.event_id
      join tournaments t on t.id = e.tournament_id
      where er.player_id = players.id
        and is_org_member(t.organization_id)
    )
  );

-- player_ratings (publicly readable; writes limited to authenticated for
-- now — tighten when we wire DUPR / PB Vision sync edge functions)
create policy "ratings read public" on player_ratings
  for select using (true);
create policy "ratings insert authenticated" on player_ratings
  for insert to authenticated with check (true);

-- tournaments (published readable to anyone; drafts only to org members)
create policy "tournaments read published or by org" on tournaments
  for select using (
    deleted_at is null
    and (status in ('published', 'closed', 'completed') or is_org_member(organization_id))
  );
create policy "tournaments write by org admins" on tournaments
  for all using (has_org_role(organization_id, 'admin'))
         with check (has_org_role(organization_id, 'admin'));

-- events (inherit from parent tournament's visibility)
create policy "events read by parent visibility" on events
  for select using (
    deleted_at is null
    and exists (
      select 1 from tournaments t
      where t.id = events.tournament_id
        and t.deleted_at is null
        and (t.status in ('published', 'closed', 'completed') or is_org_member(t.organization_id))
    )
  );
create policy "events write by org admins" on events
  for all using (
    exists (
      select 1 from tournaments t
      where t.id = events.tournament_id and has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from tournaments t
      where t.id = events.tournament_id and has_org_role(t.organization_id, 'admin')
    )
  );

-- registrations (player sees own; org sees all of theirs)
create policy "registrations read by player or org" on registrations
  for select using (
    player_id = current_player_id()
    or exists (
      select 1 from tournaments t
      where t.id = registrations.tournament_id and is_org_member(t.organization_id)
    )
  );
create policy "registrations insert by player or org staff" on registrations
  for insert to authenticated with check (
    player_id = current_player_id()
    or exists (
      select 1 from tournaments t
      where t.id = registrations.tournament_id and has_org_role(t.organization_id, 'staff')
    )
  );
create policy "registrations update by player or org staff" on registrations
  for update using (
    player_id = current_player_id()
    or exists (
      select 1 from tournaments t
      where t.id = registrations.tournament_id and has_org_role(t.organization_id, 'staff')
    )
  );

-- event_registrations (same pattern as registrations)
create policy "event_regs read by player or org" on event_registrations
  for select using (
    player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id and is_org_member(t.organization_id)
    )
  );
create policy "event_regs insert by player or org staff" on event_registrations
  for insert to authenticated with check (
    player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id and has_org_role(t.organization_id, 'staff')
    )
  );
create policy "event_regs update by player or org staff" on event_registrations
  for update using (
    player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id and has_org_role(t.organization_id, 'staff')
    )
  );

-- partner_invites
create policy "invites read by sender, recipient, or org" on partner_invites
  for select using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = partner_invites.event_id and is_org_member(t.organization_id)
    )
  );
create policy "invites insert by sender" on partner_invites
  for insert to authenticated with check (inviter_player_id = current_player_id());
create policy "invites update by sender or recipient" on partner_invites
  for update using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
  );

-- payments (read-only via API; writes via edge functions w/ service_role)
create policy "payments read by player or org" on payments
  for select using (
    player_id = current_player_id() or is_org_member(organization_id)
  );

-- payment_line_items (inherit from parent payment visibility)
create policy "line_items read by payment visibility" on payment_line_items
  for select using (
    exists (
      select 1 from payments p
      where p.id = payment_line_items.payment_id
        and (p.player_id = current_player_id() or is_org_member(p.organization_id))
    )
  );

-- audit_log (org members only)
create policy "audit_log read by org members" on audit_log
  for select using (organization_id is null or is_org_member(organization_id));

-- ─────────────────────────────────────────────────────────────────────
-- Seed: WMPC organization
-- ─────────────────────────────────────────────────────────────────────
-- Inserted with no members. After your first auth user signs up, claim
-- ownership by running (substitute your auth.users.id):
--
--   insert into organization_members (organization_id, user_id, role)
--   select id, '<your-auth-uid>', 'owner'
--     from organizations where slug = 'wmpc';

insert into organizations (slug, name, contact_email)
values ('wmpc', 'White Mountain Pickleball Club', null)
on conflict (slug) do nothing;
