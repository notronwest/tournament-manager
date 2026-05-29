-- 20260529190000_platform_admins.sql
--
-- Super-admin / "platform admin" role and the bootstrap plumbing for
-- the create-organization flow.
--
-- The app needs a way to onboard a new organization without running
-- SQL in the Supabase dashboard. We add:
--
--   * `platform_admins` — explicit membership table for users with
--     cross-org super-admin powers. RLS allows reading ONLY your own
--     row, so a non-admin can't enumerate the list. All writes go
--     through service_role (SQL editor or migrations).
--
--   * `find_user_by_email(email)` — SECURITY DEFINER lookup the
--     edge function uses to decide whether an owner email already has
--     an auth.users row (link directly) or needs an invitation
--     (admin.auth.admin.inviteUserByEmail). EXECUTE is restricted to
--     service_role only since email is sensitive.
--
-- The auto-add-creator-as-owner trigger from the init schema
-- (add_org_creator_as_owner) is a no-op when auth.uid() is NULL,
-- which is exactly what happens inside a service-role edge function.
-- So the create-organization edge function has full control of the
-- owner assignment.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- platform_admins
-- ─────────────────────────────────────────────────────────────────────

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is
  'Users with cross-org super-admin powers (e.g. create new organizations from inside the app). Read-self only via RLS; writes are service_role only.';

alter table public.platform_admins enable row level security;

-- A user can read their own platform_admins row (or confirm its
-- absence). The React client uses this to gate super-admin UI.
create policy "platform admins read self"
  on public.platform_admins
  for select using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies — all writes via service_role.

-- ─────────────────────────────────────────────────────────────────────
-- find_user_by_email helper for the create-organization edge function
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.find_user_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

-- Lock down execution to service_role only — email is PII.
revoke execute on function public.find_user_by_email(text) from public, anon, authenticated;
grant execute on function public.find_user_by_email(text) to service_role;

comment on function public.find_user_by_email(text) is
  'Returns the auth.users.id for the given email (case-insensitive), or NULL. Restricted to service_role; used by the create-organization edge function to decide between link-existing and invite-new for org owner provisioning.';

-- ─────────────────────────────────────────────────────────────────────
-- Manual seed snippet (run once after this migration applies)
-- ─────────────────────────────────────────────────────────────────────
--
-- Add yourself as the first platform admin from the SQL editor:
--
--   insert into platform_admins (user_id)
--   select id from auth.users where email = 'ron@whitemountainpickleball.com';
--
-- After that, the "+ Create organization" button appears on /admin
-- for that user and the create-organization edge function accepts
-- their requests.
