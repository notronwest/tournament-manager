-- 20261027120000_guardian_registrations.sql
--
-- Issue #1174 — the DB half of #1169 ("a parent registers their child").
--
-- Today a minor can only get onto a roster by creating their own account with
-- their own email address, because registration is hard-wired to the logged-in
-- user's single player row: players.auth_user_id is UNIQUE and
-- current_player_id() is `select id from players where auth_user_id = auth.uid()`,
-- so there is no actor/subject split anywhere. Every RLS policy on
-- event_registrations has exactly two branches — "me" or "org staff".
--
-- This migration adds the missing third party: a GUARDIAN acting for a
-- DEPENDENT. Four pieces:
--
--   1. player_guardians — the guardian↔dependent link (many-to-many, soft
--      delete), plus is_guardian_of() as the single predicate every policy
--      calls.
--   2. event_registrations.registered_by_player_id — who performed the act, so
--      the organizer's Attendees page can say which parent signed a child up.
--   3. A guardian branch on the event_registrations SELECT/INSERT/UPDATE
--      policies and on the players UPDATE policy.
--   4. The age gate in enforce_event_eligibility(), and a family-aware
--      compute_checkout_total() so a parent can pay a child's balance.
--
-- ─── Why RLS and not a service-role edge function ────────────────────
--
-- admin-register-contact already registers an arbitrary player server-side
-- with the service-role key, so a guardian sibling of it was the obvious
-- alternative. It is the wrong shape here, for one decisive reason:
-- enforce_event_eligibility() RETURNS EARLY when auth.uid() is null, so a
-- service-role insert is never eligibility-checked. admin-register-contact
-- WANTS that — org staff are deliberately exempt so an organizer can
-- hand-place a player. A guardian must NOT be exempt: the whole point of this
-- card is that the age gate binds them. Registering through RLS keeps the
-- caller's JWT, so the trigger below runs on a guardian's insert exactly as it
-- runs on a self-registration, and the age rule has ONE implementation at the
-- trust boundary instead of a second copy inside a function.
--
-- ─── How tight the guardian link is ─────────────────────────────────
--
-- `players` INSERT is `with check (true)`, so anyone can create a player row,
-- and a guardian link grants read AND write over that player's registrations
-- and profile. So "which rows may I claim as my dependent?" is the security
-- question for this whole feature, and a table-level INSERT policy cannot
-- answer it: no condition on an existing row proves the CALLER created it
-- (an organizer-created contact is account-less and registration-less too).
--
-- Therefore authenticated users get NO insert on player_guardians. The only
-- way to create a link is add_dependent(), a SECURITY DEFINER function that
-- inserts the child's players row AND the link in one call, with
-- guardian_player_id = current_player_id(). A caller can never be linked to a
-- row they did not create in that same call. Service role (support tooling)
-- may still insert directly.
--
-- Known limit, deliberate: there is no self-service way to add a second
-- guardian to an existing child. The table models many guardians per
-- dependent — no unique constraint on dependent_player_id — so the schema is
-- ready; the "invite my co-parent" flow is its own card.

set search_path = public;

-- ─── 1. The guardian ↔ dependent link ───────────────────────────────

create table if not exists player_guardians (
  id                   uuid primary key default gen_random_uuid(),
  guardian_player_id   uuid not null references players(id) on delete restrict,
  dependent_player_id  uuid not null references players(id) on delete restrict,
  -- Free text for the organizer's benefit ("mother", "grandparent"). Never
  -- used in a policy or a gate; the link itself is the authorization.
  relationship         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint player_guardians_not_self check (guardian_player_id <> dependent_player_id)
);

comment on table player_guardians is
  'Guardian→dependent links (#1169). A guardian may have many dependents and a '
  'dependent many guardians. Soft delete via deleted_at, per the house '
  'convention for long-lived entities. Authorization predicate: is_guardian_of().';

-- One ACTIVE link per pair; a soft-deleted link does not block re-adding.
create unique index if not exists player_guardians_active_pair_uidx
  on player_guardians (guardian_player_id, dependent_player_id)
  where deleted_at is null;

create index if not exists player_guardians_guardian_idx
  on player_guardians (guardian_player_id) where deleted_at is null;
create index if not exists player_guardians_dependent_idx
  on player_guardians (dependent_player_id) where deleted_at is null;

drop trigger if exists player_guardians_updated_at on player_guardians;
create trigger player_guardians_updated_at before update on player_guardians
  for each row execute function public.set_updated_at();

alter table player_guardians enable row level security;

-- The policies above are the restriction; these are the table privileges that
-- let a signed-in player reach them at all (the house pattern — see
-- account_credits / campaign_events). No INSERT grant: links are created only
-- by add_dependent() below. No grant to `anon`: a guardian link is
-- meaningless without a player row, and there is no public view of a family.
grant select, update on public.player_guardians to authenticated;

-- The one predicate every guardian branch calls. SECURITY DEFINER so a policy
-- on another table can consult the link without needing a read policy on it —
-- same shape as current_player_id() / is_org_member().
create or replace function public.is_guardian_of(p_player_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from player_guardians g
     where g.dependent_player_id = p_player_id
       and g.guardian_player_id = current_player_id()
       and g.deleted_at is null
       -- The authority holds only while the dependent is still account-less.
       -- Once the real person claims the row (auth_user_id set) the link goes
       -- inert, so a link made against an unclaimed contact cannot be used to
       -- reach that person's registrations or profile after they sign up.
       and exists (
         select 1 from players d
          where d.id = g.dependent_player_id
            and d.auth_user_id is null
            and d.deleted_at is null
       )
  );
$$;

comment on function public.is_guardian_of(uuid) is
  'True when the calling auth user''s player row holds an active guardian link '
  'over p_player_id (#1169). The authorization predicate for every guardian '
  'branch in RLS.';

-- Create a child and the guardian link to them, atomically, for the caller.
-- SECURITY DEFINER so it can insert the link that no client policy permits;
-- the link's guardian is always the caller's own player row, and the
-- dependent is always the row inserted here, so no one can be linked to a
-- player they did not just create.
create or replace function public.add_dependent(
  p_first_name   text,
  p_last_name    text,
  p_dob          date,
  p_relationship text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_guardian  uuid := current_player_id();
  v_dependent uuid;
begin
  if v_guardian is null then
    raise exception 'add_dependent: sign in with a player profile first'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_first_name, '')), '') is null
     or nullif(btrim(coalesce(p_last_name, '')), '') is null then
    raise exception 'add_dependent: first and last name are required'
      using errcode = '22023';
  end if;

  insert into players (first_name, last_name, dob)
  values (btrim(p_first_name), btrim(p_last_name), p_dob)
  returning id into v_dependent;

  insert into player_guardians (guardian_player_id, dependent_player_id, relationship)
  values (v_guardian, v_dependent, nullif(btrim(coalesce(p_relationship, '')), ''));

  return v_dependent;
end;
$$;

comment on function public.add_dependent(text, text, date, text) is
  'Creates an account-less player row for a child and links the caller as its '
  'guardian, atomically (#1169). The only way a player_guardians row is made '
  'by a client, so a caller can never be linked to a row they did not create.';

revoke all on function public.add_dependent(text, text, date, text) from public, anon;
grant execute on function public.add_dependent(text, text, date, text) to authenticated, service_role;

-- Only the two people in the link can see it. Org staff deliberately CANNOT:
-- the Attendees page names the registering guardian through
-- event_registrations.registered_by_player_id (a publicly readable players
-- row), so showing who signed a child up needs no view of the family itself.
drop policy if exists "player_guardians read by guardian or dependent" on player_guardians;
create policy "player_guardians read by guardian or dependent" on player_guardians
  for select using (
    guardian_player_id = current_player_id()
    or dependent_player_id = current_player_id()
  );

-- No INSERT policy: links are created by add_dependent() only (see header).

-- A guardian maintains their own links (the soft delete runs through here).
-- with check pins the guardian end so an update cannot hand the link to
-- someone else.
drop policy if exists "player_guardians update by guardian" on player_guardians;
create policy "player_guardians update by guardian" on player_guardians
  for update using (guardian_player_id = current_player_id())
  with check (guardian_player_id = current_player_id());

-- No DELETE policy: these are long-lived rows, retired with deleted_at.

-- ─── 2. Who performed the registration ──────────────────────────────

-- NULL means "the player registered themselves", which is every row that
-- exists today — so no backfill, and the column reads honestly.
alter table event_registrations
  add column if not exists registered_by_player_id uuid references players(id) on delete set null;

comment on column event_registrations.registered_by_player_id is
  'The player who performed this registration when it was not the registrant '
  'themselves — a guardian acting for a dependent (#1169). NULL = self-registered.';

create index if not exists event_registrations_registered_by_idx
  on event_registrations (registered_by_player_id)
  where registered_by_player_id is not null;

-- ─── 3. Guardian branches on the existing policies ──────────────────
--
-- Each policy below is the CURRENT definition verbatim plus one
-- `or is_guardian_of(player_id)` branch. Dropped and recreated because
-- Postgres has no "add a branch" DDL.
--
-- The tournament-level `registrations` table is deliberately NOT widened:
-- nothing in the public registration flow writes it (the only reference left
-- in the app is a count on the organizer's tournament list), so a guardian
-- branch there would be dead policy surface.

drop policy if exists "event_regs read by player or org" on event_registrations;
create policy "event_regs read by player or org" on event_registrations
  for select using (
    player_id = current_player_id()
    or is_guardian_of(player_id)
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id and is_org_member(t.organization_id)
    )
  );

-- registered_by_player_id is pinned to the caller whenever it is set, and is
-- REQUIRED when someone other than the registrant is acting and is not org
-- staff (a guardian), so a guardian's signup always leaves an attribution
-- record. Self-registrations and staff placements may leave it NULL.
drop policy if exists "event_regs insert by player or org staff" on event_registrations;
create policy "event_regs insert by player or org staff" on event_registrations
  for insert to authenticated with check (
    (
      player_id = current_player_id()
      or is_guardian_of(player_id)
      or exists (
        select 1 from events e
        join tournaments t on t.id = e.tournament_id
        where e.id = event_registrations.event_id and has_org_role(t.organization_id, 'staff')
      )
    )
    and (
      registered_by_player_id is null
      or registered_by_player_id = current_player_id()
    )
    and (
      player_id = current_player_id()
      or registered_by_player_id = current_player_id()
      or exists (
        select 1 from events e
        join tournaments t on t.id = e.tournament_id
        where e.id = event_registrations.event_id and has_org_role(t.organization_id, 'staff')
      )
    )
  );

drop policy if exists "event_regs update by player or org staff" on event_registrations;
create policy "event_regs update by player or org staff" on event_registrations
  for update using (
    player_id = current_player_id()
    or is_guardian_of(player_id)
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id and has_org_role(t.organization_id, 'staff')
    )
  );

-- registered_by_player_id is write-once. The INSERT policy pins it to the
-- caller, but an UPDATE policy cannot compare against the OLD row, so any
-- permitted updater could otherwise rewrite who "signed this child up". A
-- trigger keeps the inserted value, whoever updates (a `with check` mirroring
-- `using` would instead block the dependent or staff from updating a row a
-- guardian created).
create or replace function public.keep_registered_by_player_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.registered_by_player_id := old.registered_by_player_id;
  return new;
end;
$$;

drop trigger if exists keep_registered_by_player_id on event_registrations;
create trigger keep_registered_by_player_id
  before update on event_registrations
  for each row execute function public.keep_registered_by_player_id();

-- DELETE is NOT widened. A guardian withdraws a dependent through the
-- withdrawal columns (an UPDATE), the same route a player has for themselves;
-- hard-deleting a registration row stays with the player and org staff.

-- A guardian maintains their dependent's profile — the name they typed and,
-- the reason this branch has to exist, the date of birth the age gate reads.
--
-- This policy previously had no `with check`, so Postgres reused `using` as
-- the post-update check. It now has an explicit one that mirrors `using`
-- branch for branch, with one addition: a guardian may only leave the
-- dependent ACCOUNT-LESS. Without that, "I may update my dependent's row"
-- would include writing auth_user_id, which would bind someone else's login to
-- that player row. Linking an account to a player is the claim flow's job, and
-- that runs as the claiming user.
--
-- The three pre-existing branches behave exactly as before. In particular the
-- orphan-claim branch still works: its `using` arm matches the OLD row
-- (auth_user_id is null, email matches the JWT) and the NEW row then satisfies
-- the `auth_user_id = auth.uid()` arm of the check, which is how it passed when
-- `using` was being reused.
drop policy if exists "players update by self or related org" on players;
create policy "players update by self or related org" on players
  for update using (
    -- the player's own linked record
    auth_user_id = auth.uid()
    -- claim: an unlinked record whose email is the caller's own
    or (
      auth_user_id is null
      and email is not null
      and lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    )
    -- a guardian maintaining a dependent's profile
    or is_guardian_of(players.id)
    -- org staff managing a registrant in one of their tournaments
    or exists (
      select 1 from event_registrations er
      join events e on e.id = er.event_id
      join tournaments t on t.id = e.tournament_id
      where er.player_id = players.id
        and is_org_member(t.organization_id)
    )
  )
  with check (
    auth_user_id = auth.uid()
    or (
      auth_user_id is null
      and email is not null
      and lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    )
    -- a guardian may never bind an account to the row they maintain
    or (is_guardian_of(players.id) and auth_user_id is null)
    or exists (
      select 1 from event_registrations er
      join events e on e.id = er.event_id
      join tournaments t on t.id = e.tournament_id
      where er.player_id = players.id
        and is_org_member(t.organization_id)
    )
  );

-- ─── 4a. The age gate (trust boundary) ──────────────────────────────
--
-- events.min_age / max_age have existed since the init schema and were checked
-- NOWHERE — not in this trigger, not in the client. An 11-year-old could enter
-- a 50+ bracket and a 40-year-old a 12-and-under one. This adds the gate here,
-- the trust boundary; web/src/lib/eligibility.ts carries the matching friendly
-- message (the deliberate double implementation this function's header
-- describes).
--
-- TWO DECISIONS, both mirrored exactly by the client:
--
--   * AGE IS MEASURED AT THE TOURNAMENT'S START, not today. "18 & under" is a
--     statement about the day of play: a player who turns 19 three weeks before
--     the tournament is not an 18-and-under entrant, however old they are the
--     day they register. Measuring at registration time would also make
--     eligibility drift as a bracket sits open. Both sides read the UTC
--     calendar date of tournaments.starts_at so they cannot disagree by a day
--     over a timezone.
--
--   * A NULL dob IS INELIGIBLE FOR AN AGE-RESTRICTED EVENT, and irrelevant
--     everywhere else. This is the rule the rating gate three lines up already
--     uses ("a NULL self-rating for that format is ineligible"), and an
--     age-restricted bracket must not be enterable by someone who has not said
--     how old they are. The guard that keeps this from locking anyone out is
--     that it only fires when the event actually sets a bound — every player
--     row in production has dob = NULL today (nothing but the seed tool has
--     ever written it), and all of them stay eligible for every unrestricted
--     event. The client's message names the fix: add a date of birth.

create or replace function public.enforce_event_eligibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ev            events%rowtype;
  pl            players%rowtype;
  org_id        uuid;
  player_rating numeric(4,2);
  rating_label  text;
  range_label   text;
  as_of         date;
  player_age    integer;
  reasons       text[] := '{}';
begin
  -- Trusted backends (service_role, edge functions, seed tools) carry no
  -- end-user JWT subject. Nothing to enforce against — let them through.
  if auth.uid() is null then
    return new;
  end if;

  select * into ev from events where id = new.event_id;
  if not found then
    -- Let the FK constraint produce the error rather than masking it here.
    return new;
  end if;

  -- Resolve the owning org so staff can hand-place players.
  select t.organization_id into org_id
    from tournaments t where t.id = ev.tournament_id;

  if org_id is not null and has_org_role(org_id, 'staff') then
    return new;
  end if;

  select * into pl from players where id = new.player_id;
  if not found then
    return new;  -- FK will reject; don't mask it.
  end if;

  -- ── Rating gate ──────────────────────────────────────────────────
  if ev.min_rating is not null or ev.max_rating is not null then
    if ev.format = 'singles' then
      player_rating := pl.self_rating_singles;
      rating_label  := 'singles';
    elsif ev.format = 'doubles' and ev.gender = 'mixed' then
      player_rating := pl.self_rating_mixed;
      rating_label  := 'mixed doubles';
    else
      player_rating := pl.self_rating_doubles;
      rating_label  := 'doubles';
    end if;

    if player_rating is null then
      reasons := reasons || format('no %s self-rating on file', rating_label);
    elsif (ev.min_rating is not null and player_rating < ev.min_rating)
       or (ev.max_rating is not null and player_rating > ev.max_rating) then
      if ev.min_rating is not null and ev.max_rating is not null then
        range_label := format_rating(ev.min_rating) || '–' || format_rating(ev.max_rating);
      elsif ev.min_rating is not null then
        range_label := '≥' || format_rating(ev.min_rating);
      else
        range_label := '≤' || format_rating(ev.max_rating);
      end if;
      reasons := reasons || format('needs rating %s', range_label);
    end if;
  end if;

  -- ── Gender gate ──────────────────────────────────────────────────
  -- Only the two single-gender divisions gate on gender; mixed and open are
  -- open to any pairing. Written as an explicit pair rather than `<> 'mixed'`
  -- so a future enum value cannot fall into the women's arm — which is how
  -- `open` came to reject every player who was not female on the client
  -- (#1170); this function always had it right.
  if ev.gender in ('men', 'women') then
    if (ev.gender = 'men'   and pl.gender is distinct from 'M'::player_gender)
    or (ev.gender = 'women' and pl.gender is distinct from 'F'::player_gender) then
      reasons := reasons || (case when ev.gender = 'men'
                                  then 'men''s event'
                                  else 'women''s event' end);
    end if;
  end if;

  -- ── Age gate ─────────────────────────────────────────────────────
  if ev.min_age is not null or ev.max_age is not null then
    select (t.starts_at at time zone 'UTC')::date into as_of
      from tournaments t where t.id = ev.tournament_id;

    if pl.dob is null then
      -- Cast required: `text[] || <untyped literal>` makes Postgres try to
      -- parse the literal AS an array ("malformed array literal"). The arms
      -- above get away with a bare expression because format() already
      -- returns text.
      reasons := reasons || 'needs a date of birth on file'::text;
    elsif as_of is not null then
      player_age := extract(year from age(as_of, pl.dob))::integer;
      if (ev.min_age is not null and player_age < ev.min_age)
         or (ev.max_age is not null and player_age > ev.max_age) then
        if ev.min_age is not null and ev.max_age is not null then
          range_label := ev.min_age || '–' || ev.max_age;
        elsif ev.min_age is not null then
          range_label := ev.min_age || '+';
        else
          range_label := ev.max_age || ' or under';
        end if;
        reasons := reasons || format('needs age %s', range_label);
      end if;
    end if;
  end if;

  if array_length(reasons, 1) > 0 then
    raise exception 'Not eligible for "%": %', ev.name, array_to_string(reasons, '; ')
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_event_eligibility() is
  'Trust-boundary check (issue #56, age gate #1169): rejects ineligible '
  'event_registrations inserts by self-service players, guardians included. '
  'Rating, gender and age. Age is measured at the tournament''s UTC start date; '
  'a NULL dob is ineligible for an age-restricted event only. Mirrors '
  'web/src/lib/eligibility.ts. Exempts service_role (auth.uid() null) and org '
  'staff (has_org_role).';

-- ─── 4b. A family-aware checkout total ──────────────────────────────
--
-- create-payment-intent derives the player from the JWT and scopes the whole
-- total to that one player, so today a parent literally cannot pay a child's
-- entry. This widens the total's SCOPE rather than adding a parallel total:
-- the basket is now the payer's own unpaid registrations PLUS those of their
-- active dependents, and everything downstream already works off the returned
-- line items — create-payment-intent's payable-status guard and free-confirm
-- flip, and stripe-webhook's handleSucceeded, all read
-- payment_line_items.event_registration_id and never the payer's player_id.
-- So no edge-function change is needed for the money to land correctly.
--
-- THE PRICING TIERS STAY PER PLAYER. The tier logic ("first event at the
-- first-event rate, the next N included, the rest at the additional rate") is
-- a statement about one entrant's basket, so the previous body is now run once
-- per player in the family and the results concatenated. A player with no
-- dependents gets a loop of one and a byte-identical result — including
-- v_already_paid, which stays that player's own history. What the family share
-- is one charge, not one entrant's discount.
--
-- A dependent's line item carries their name so a parent's receipt
-- distinguishes two entries in the same bracket.
--
-- NOT widened: account credit (account_credit_balance in create-payment-intent)
-- stays the payer's own balance applied to the whole basket, and payments.player_id
-- stays the payer. Per-entrant attribution lives in the line items.

create or replace function public.compute_checkout_total(
  p_player_id     uuid,
  p_tournament_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier         public.tournament_pricing_tiers;
  v_first        integer := 0;
  v_add          integer := 0;
  v_included     integer := 1;
  v_already_paid boolean := false;
  v_items        jsonb := '[]'::jsonb;
  v_total        integer := 0;
  v_person       record;
  r              record;
begin
  select * into v_tier from public.current_pricing_tier(p_tournament_id, now());
  if found then
    v_first    := coalesce(v_tier.first_event_fee_cents, 0);
    v_add      := coalesce(v_tier.additional_event_fee_cents, 0);
    v_included := greatest(coalesce(v_tier.first_events_included, 1), 1);
  end if;

  -- The payer first, then each active dependent, so the payer's own events
  -- head the basket and the line-item order is stable.
  for v_person in
    select p_player_id as player_id, true as is_payer, null::text as display_name
    union all
    select g.dependent_player_id,
           false,
           nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
      from player_guardians g
      join players p on p.id = g.dependent_player_id
     where g.guardian_player_id = p_player_id
       and g.deleted_at is null
       and p.deleted_at is null
       and p.auth_user_id is null
    order by is_payer desc, display_name
  loop
    -- Each entrant's tiering is their own, so the "has this person already
    -- paid for something in this tournament?" question is asked per person.
    select exists (
      select 1
        from public.event_registrations er
        join public.events e on e.id = er.event_id
       where e.tournament_id = p_tournament_id
         and er.player_id = v_person.player_id
         and er.status = 'paid'
         and er.deleted_at is null
    ) into v_already_paid;

    for r in
      with pend as (
        select er.id   as reg_id,
               e.id    as event_id,
               e.name  as event_name,
               e.event_fee_cents as override_cents,
               case when e.event_fee_cents > 0 then e.event_fee_cents else v_first end as full_price
          from public.event_registrations er
          join public.events e on e.id = er.event_id
         where e.tournament_id = p_tournament_id
           and er.player_id = v_person.player_id
           and er.status in ('pending_payment', 'waitlisted_pending_payment')
           and er.deleted_at is null
           and e.deleted_at is null
      )
      select reg_id, event_id, event_name, override_cents, full_price,
             row_number() over (order by full_price desc, reg_id) as rn
        from pend
    loop
      declare
        v_label  text;
        v_amount integer;
      begin
        if r.override_cents > 0 then
          v_label := 'override';
          v_amount := r.override_cents;
        elsif r.rn = 1 and not v_already_paid then
          v_label := 'first';
          v_amount := v_first;
        elsif r.rn <= v_included and not v_already_paid then
          v_label := 'included';
          v_amount := 0;
        else
          v_label := 'additional';
          v_amount := v_add;
        end if;

        v_total := v_total + v_amount;
        v_items := v_items || jsonb_build_object(
          'event_registration_id', r.reg_id,
          'event_id', r.event_id,
          'player_id', v_person.player_id,
          -- A dependent's row is named on the receipt; the payer's is not, so
          -- a solo checkout reads exactly as it did before.
          'description', case
                           when v_person.is_payer or v_person.display_name is null
                             then r.event_name
                           else r.event_name || ' — ' || v_person.display_name
                         end,
          'amount_cents', v_amount,
          'tier', v_label
        );
      end;
    end loop;
  end loop;

  return jsonb_build_object('total_cents', v_total, 'line_items', v_items);
end;
$$;

comment on function public.compute_checkout_total(uuid, uuid) is
  'Authoritative checkout total + line items for a player''s unpaid regs '
  '(pending_payment + waitlisted_pending_payment) in a tournament, AND those of '
  'their active dependents (#1169) — a guardian pays the family basket in one '
  'charge. Pricing tiers are computed per entrant, so a dependent gets their own '
  'first-event rate. Entry fee covers the first N (first_events_included) events; '
  'picks beyond N get the additional rate. Mirrors web/src/lib/pricing.ts. '
  'SECURITY DEFINER, service_role only (Stripe edge function).';

-- Re-assert the server-only grants. create-or-replace keeps existing grants,
-- but 20261011110000_server_only_functions_revoke_client_roles.sql runs an
-- assertion on every apply that raises if this function is executable by anon
-- or authenticated, so the revoke is restated here rather than assumed.
revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;

-- is_guardian_of is consulted by RLS, so the client roles need it.
grant execute on function public.is_guardian_of(uuid) to anon, authenticated, service_role;
