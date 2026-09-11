-- Migration: install_pg_net_extension
--
-- pg_net was never created on this project (confirmed missing on PROD via
-- `select extname from pg_extension`), so the fire-and-forget HTTP calls in
-- handle_user_email_confirmed (20260614120000_welcome_email_trigger.sql) and
-- notify_quote_customer_revision (20260804190000_quote_response_notify.sql)
-- have been silently no-ops — both wrap net.http_post in EXCEPTION WHEN OTHERS
-- and only RAISE WARNING, so no email ever went out and nothing surfaced as
-- an error. Those migrations' comments assumed pg_net ships pre-installed;
-- it ships available (0.20.0) but still has to be created explicitly.
--
-- This does not address the second prerequisite those triggers read at
-- runtime, app.settings.supabase_url — that is a per-project ALTER DATABASE
-- run by hand in the SQL editor (documented in DEPLOYMENT.md), not something
-- a migration can carry, since the value differs per project and ALTER
-- DATABASE needs privileges beyond the migration role.

create extension if not exists pg_net with schema extensions;
