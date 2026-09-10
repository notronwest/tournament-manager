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
  insert into public.players (auth_user_id, first_name, last_name, email)
  values (v_user_id, 'Tournament', 'Director', 'director@offline.local')
  on conflict (auth_user_id) do nothing;

  select id into v_org_id from public.organizations where slug = 'wmpc';

  if v_org_id is not null then
    insert into public.organization_members (organization_id, user_id, role)
    values (v_org_id, v_user_id, 'owner')
    on conflict (organization_id, user_id) do nothing;
  end if;
end $$;
