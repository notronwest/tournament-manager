-- supabase/seed.sql
--
-- LOCAL DEV / OFFLINE-EVENT SEED ONLY.
--
-- Applied automatically by `supabase start` (first boot of a fresh local
-- database) and `supabase db reset`, per [db.seed] in supabase/config.toml.
-- The Supabase CLI never runs seed.sql against a linked/remote project
-- (`supabase db push` does not execute it) -- nothing in this file ever
-- reaches the hosted TEST or PROD database.
--
-- Creates one hardcoded "tournament director" login for the offline event
-- runtime (issue #734, epic #732 -- run Bert & Erne with Wi-Fi off). At the
-- venue, hosted Supabase Auth (OAuth, magic-link email) is unreachable, so
-- the director signs in against the LOCAL GoTrue instance instead -- same
-- schema/RLS as production, zero external network calls (per Ron's Sep 9
-- decision on #732/#733 to keep local Postgres + Auth, not re-derive it).
-- web/src/auth/AuthProvider.tsx auto-signs-in as this exact user whenever
-- the app is built in offline mode, so nobody types credentials at the
-- tournament desk. The credential is not a secret: it only ever
-- authenticates against a throwaway local Postgres instance on the
-- director's own laptop, never against a hosted project.

set search_path = public, auth, extensions;

do $$
declare
  v_user_id uuid := '00000000-0000-0000-0000-0000000d1234';
  v_org_id  uuid;
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated',
    'director@offline.local',
    extensions.crypt('bert-and-erne-offline', extensions.gen_salt('bf')),
    now(), '', '', '', '', now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    false
  )
  on conflict (id) do nothing;

  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider, created_at, updated_at
  )
  values (
    gen_random_uuid(), v_user_id::text, v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', 'director@offline.local'),
    'email', now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  -- Player record so the director shows up like any other player-linked
  -- account; org membership so every org-scoped admin screen is reachable
  -- immediately (the 'wmpc' org is seeded by the init migration).
  -- The dob is load-bearing, not decoration: the public register card only
  -- takes its "Register a child" route when the signed-in player is refused
  -- for their AGE, and a null dob is refused for being blank instead -- which
  -- turned every juniors bracket into a link to the viewer's own profile and
  -- left the youth flow unreachable from a fresh seed. An adult dob is what
  -- makes the director an adult. Rating and gender stay blank on purpose:
  -- they are the blanks the card's "Add a rating and a gender to register"
  -- advice names.
  insert into public.players (auth_user_id, first_name, last_name, email, dob)
  values (v_user_id, 'Tournament', 'Director', 'director@offline.local', '1980-01-01')
  on conflict (auth_user_id) do nothing;

  select id into v_org_id from public.organizations where slug = 'wmpc';

  if v_org_id is not null then
    insert into public.organization_members (organization_id, user_id, role)
    values (v_org_id, v_user_id, 'owner')
    on conflict (organization_id, user_id) do nothing;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- DESIGN-GATE FIXTURES: the register card's branches, and one registered
-- player.
--
-- These exist because three design gradings in a row could not RENDER what
-- they were grading. The register card's "Add <blanks> to register →" branch
-- needs a bracket whose refusal is fixable on the viewer's OWN profile, and
-- every bracket a critic could reach paired its rating bound with an age cap
-- — which routes the card to "Register a child" instead (the aged-out check
-- runs first, PublicTournamentPage.tsx). Twice the branch went ungraded; the
-- third time it was reached only by hand-editing this database, and it turned
-- out to carry a real defect (an 18px tap target where the card's only action
-- lives). So a bracket with a rating bound and NO age cap is not decoration:
-- it is the difference between a branch being graded and being guessed at.
--
-- Likewise /admin/players/:playerId: admin-get-player grants an org-scoped
-- director access only to a player who has a non-deleted registration in one
-- of that org's own tournaments (_shared/playerOrgAccess.ts). With no
-- registration anywhere in the wmpc fixture, the page answered "Not
-- authorized to view this player." for every id reachable offline, three
-- gradings running. One registered pair fixes that.
--
-- Everything here is LOCAL-ONLY, same as the block above: seed.sql never runs
-- against a linked project. Dates are relative to now() so the tournament is
-- always in the future and registration is always open, however long after
-- this was written the stack is brought up.
do $$
declare
  v_org_id   uuid;
  v_tour     uuid := '00000000-0000-0000-0000-0000000f1000';
  v_ev_jr_sk uuid := '00000000-0000-0000-0000-0000000f1001';
  v_ev_jr    uuid := '00000000-0000-0000-0000-0000000f1002';
  v_ev_open  uuid := '00000000-0000-0000-0000-0000000f1003';
  v_ev_sr    uuid := '00000000-0000-0000-0000-0000000f1004';
  v_ev_mx    uuid := '00000000-0000-0000-0000-0000000f1005';
  v_ev_wm    uuid := '00000000-0000-0000-0000-0000000f1006';
  v_pl_a     uuid := '00000000-0000-0000-0000-0000000f1201';
  v_pl_b     uuid := '00000000-0000-0000-0000-0000000f1202';
  v_reg_a    uuid := '00000000-0000-0000-0000-0000000f1301';
  v_reg_b    uuid := '00000000-0000-0000-0000-0000000f1302';
begin
  select id into v_org_id from public.organizations where slug = 'wmpc';
  if v_org_id is null then
    raise notice 'seed: no wmpc org — skipping design-gate fixtures.';
    return;
  end if;

  -- Published, registration open, no pricing tiers (so every entry is free
  -- and nothing here reaches a checkout). The slug is the one every past
  -- verdict names, so a grading can follow an old verdict's URL.
  insert into public.tournaments (
    id, organization_id, name, slug, status,
    starts_at, ends_at, registration_opens_at, registration_closes_at,
    location_name, description
  )
  values (
    v_tour, v_org_id,
    'Youth Chooser Test', 'youth-chooser-test', 'published',
    now() + interval '30 days', now() + interval '31 days',
    now() - interval '7 days', now() + interval '21 days',
    'WMPC Indoor Courts',
    'Local design-gate fixture. Each bracket below exists to render one '
      || 'branch of the public register card; see supabase/seed.sql.'
  )
  on conflict (id) do nothing;

  -- One bracket per branch of the register card, for a signed-in adult with
  -- no rating, no gender and no date of birth on file (which is exactly the
  -- seeded director above):
  --
  --   Juniors 4.5-5.0  max_age 18 + rating  → "Register a child" (aged out
  --                                            first, whatever else is blank)
  --   Juniors          max_age 18           → "Register a child"
  --   Open Singles     no bounds            → "Register" (the happy path)
  --   Seniors 60+      min_age 60 + rating  → plain refusal, NO link: filling
  --                                            the rating in leaves the age
  --                                            gate refusing, so advising it
  --                                            would be a move the gate
  --                                            rejects. The minimum is above
  --                                            the director's own age on
  --                                            purpose -- that is what makes
  --                                            the refusal unfixable.
  --   Open Doubles     rating, NO age cap   → "Add a rating to register →"
  --                                            (the short label)
  --   Women's Doubles  rating + women, NO   → "Add a rating and a gender to
  --                    age cap                 register →" (the long label,
  --                                            the one that wraps at 390px)
  --
  -- The last two are the rows the gradings were missing. Keep their age
  -- bounds NULL: an age cap sends the card down the "Register a child" route
  -- and the self-fix link becomes unreachable again.
  insert into public.events (
    id, tournament_id, name, format, gender,
    min_rating, max_rating, min_age, max_age, event_fee_cents
  )
  values
    (v_ev_jr_sk, v_tour, 'Juniors 18 & Under Doubles 4.5-5.0',
       'doubles', 'mixed', 4.5, 5.0, null, 18, 0),
    (v_ev_jr,    v_tour, 'Juniors 18 & Under Doubles',
       'doubles', 'mixed', null, null, null, 18, 0),
    (v_ev_open,  v_tour, 'Open Singles (no age limits)',
       'singles', 'open', null, null, null, null, 0),
    (v_ev_sr,    v_tour, 'Seniors 60+ Doubles 3.0-4.0',
       'doubles', 'mixed', 3.0, 4.0, 60, null, 0),
    (v_ev_mx,    v_tour, 'Open Doubles 3.0-4.0 (no age cap)',
       'doubles', 'mixed', 3.0, 4.0, null, null, 0),
    (v_ev_wm,    v_tour, 'Women''s Doubles 3.5-4.5 (no age cap)',
       'doubles', 'women', 3.5, 4.5, null, null, 0)
  on conflict (id) do nothing;

  -- Two players with a confirmed doubles pairing in the open 3.0-4.0 bracket.
  -- A pair rather than a lone entrant so the organizer's player page has a
  -- partner name to render and the public roster has a team to show. Both
  -- carry a full profile (gender, dob, ratings, city) so that page is graded
  -- populated rather than empty, and both ratings sit inside the bracket's
  -- range so enforce_event_eligibility() would accept these rows even if a
  -- person entered them through the UI.
  insert into public.players (
    id, first_name, last_name, email, phone, gender, dob,
    self_rating_doubles, self_rating_mixed, self_rating_singles, city, state
  )
  values
    (v_pl_a, 'Marta', 'Kowalski', 'marta.kowalski@offline.local',
       '603-555-0142', 'F', '1986-04-17', 3.5, 3.5, 3.5, 'North Conway', 'NH'),
    (v_pl_b, 'Dev', 'Ramaswamy', 'dev.ramaswamy@offline.local',
       '603-555-0188', 'M', '1982-11-02', 3.5, 3.5, 3.0, 'Jackson', 'NH')
  on conflict (id) do nothing;

  -- status 'paid' deliberately: the pending-payment sweeper (pg_cron, every 5
  -- minutes locally) deletes stale pending_payment rows, and a fixture that
  -- disappears half an hour into a grading is worse than no fixture.
  insert into public.event_registrations (
    id, event_id, player_id, event_fee_cents, status, partner_status
  )
  values
    (v_reg_a, v_ev_mx, v_pl_a, 0, 'paid', 'confirmed'),
    (v_reg_b, v_ev_mx, v_pl_b, 0, 'paid', 'confirmed')
  on conflict (id) do nothing;

  -- partner_registration_id is a self-FK, so the pairing is a second pass.
  update public.event_registrations set partner_registration_id = v_reg_b
    where id = v_reg_a and partner_registration_id is null;
  update public.event_registrations set partner_registration_id = v_reg_a
    where id = v_reg_b and partner_registration_id is null;
end $$;
