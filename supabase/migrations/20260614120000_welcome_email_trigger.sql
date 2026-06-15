-- Migration: welcome_email_trigger
--
-- Creates a Postgres trigger that fires ONCE when a user confirms their
-- email address (auth.users.email_confirmed_at goes NULL → non-NULL).
-- The trigger calls the send-welcome-email Edge Function via pg_net so
-- the HTTP request is fire-and-forget — it never blocks the auth flow.
--
-- REQUIRED ONE-TIME SETUP (Ron — run once per environment in the Supabase
-- SQL editor, not as a migration):
--
--   ALTER DATABASE postgres
--     SET "app.settings.supabase_url" = 'https://<your-project-ref>.supabase.co';
--
-- The trigger function reads this setting at runtime.  If the setting is
-- absent the function exits early and logs a WARNING — confirmation still
-- succeeds (non-fatal per AC#4).
--
-- The edge function is deployed with --no-verify-jwt so no auth header is
-- needed here; the function validates the userId internally via service role.

-- ── Trigger function ──────────────────────────────────────────────────────────
-- pg_net is pre-installed by Supabase in the net schema; no CREATE EXTENSION needed.

CREATE OR REPLACE FUNCTION public.handle_user_email_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _supabase_url text;
BEGIN
  _supabase_url := current_setting('app.settings.supabase_url', true);

  IF _supabase_url IS NULL OR _supabase_url = '' THEN
    RAISE WARNING
      'handle_user_email_confirmed: app.settings.supabase_url not set — '
      'welcome email skipped for user %.  Run the one-time ALTER DATABASE '
      'setup described in 20260614120000_welcome_email_trigger.sql.',
      NEW.id;
    RETURN NEW;
  END IF;

  -- Fire-and-forget HTTP POST via pg_net.  Returns a request_id bigint;
  -- we discard it.  The edge function always returns 200 so pg_net will
  -- not surface an error that could propagate here.
  PERFORM net.http_post(
    url     := _supabase_url || '/functions/v1/send-welcome-email',
    body    := jsonb_build_object('userId', NEW.id::text),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Any unexpected error must not abort the auth confirmation transaction.
  RAISE WARNING
    'handle_user_email_confirmed: unexpected error (%), skipping welcome email for user %.',
    SQLERRM, NEW.id;
  RETURN NEW;
END;
$$;

-- ── Trigger ───────────────────────────────────────────────────────────────────

-- Guard: `email_confirmed_at` goes NULL → non-NULL exactly once per user,
-- so this trigger fires at most once per user under normal Supabase flows.
-- The edge function adds a redundant `welcomed_at` stamp for extra safety.

DROP TRIGGER IF EXISTS on_user_email_confirmed ON auth.users;

CREATE TRIGGER on_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_user_email_confirmed();
