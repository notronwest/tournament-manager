-- 20260529190001_seed_platform_admin_ron.sql
--
-- One-time seed: add Ron as the first platform admin. Looks up the
-- auth.users row by email so the migration is reproducible across
-- environments (the user_id varies per env).
--
-- Idempotent: ON CONFLICT DO NOTHING so re-running doesn't error.
-- No-op when the email doesn't exist (a brand-new env with no auth
-- user yet); that env will need to run the seed snippet from
-- 20260529190000_platform_admins.sql manually after the first user
-- signs up.

set search_path = public;

insert into public.platform_admins (user_id)
select id from auth.users where lower(email) = 'ron@whitemountainpickleball.com'
on conflict (user_id) do nothing;
