-- 20261011110000_server_only_functions_revoke_client_roles.sql
--
-- SECURITY FIX. Three SECURITY DEFINER functions that their own comments
-- describe as server-only are callable by `anon` on PROD today — including one
-- that WRITES THE MONEY LEDGER.
--
--   account_credit_balance(uuid, uuid)   "service_role only"
--   redeem_account_credit(...)           "service_role only" — writes account_credits
--   redeem_coupon(uuid)                  "not exposed to clients"
--
-- ── The trap, so nobody re-lays it ──────────────────────────────────────
--
-- Each of those did the natural thing:
--
--     revoke all on function public.<fn>(...) from public;
--
-- That revokes from the PUBLIC pseudo-role. It does NOT touch `anon` or
-- `authenticated`, because Supabase ships an
-- `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
-- authenticated`, which grants those two roles DIRECTLY at create time.
-- A direct grant is not removed by revoking from PUBLIC. So the line reads
-- like a lock and is not one.
--
-- **A server-only function must name the client roles explicitly:**
--
--     revoke all on function public.<fn>(...) from anon, authenticated;
--
-- ── Impact ──────────────────────────────────────────────────────────────
--
-- The anon key is public by design (it ships in the browser bundle), so
-- "callable by anon" means callable by anyone on the internet:
--
--   * redeem_account_credit — write a redemption row against ANY player and
--     destroy credit they hold. SECURITY DEFINER, so it bypasses RLS, and the
--     ledger is append-only, so a bogus redemption cannot simply be deleted.
--   * redeem_coupon — burn a coupon's uses until it is exhausted, denying real
--     customers their discount.
--   * account_credit_balance — read any player's balance given org + player id.
--
-- Verified on PROD 2026-10-11: all three `has_function_privilege('anon', …,
-- 'execute')` = true. Also true on TEST.
--
-- ── Why this was not yet a loss ─────────────────────────────────────────
--
-- `account_credits` had **0 rows** and `coupons` **0 rows** on PROD when this
-- was found, so there was nothing to destroy. That is timing, not safety: the
-- Leaf Peeper recap funnel went live the same day and the first signup grants
-- $20, which arms the ledger. Fixed before that happened rather than after.
--
-- Found while building the D-0120 campaign report: a new assertion written for
-- that migration failed on its own functions, which is what exposed the shared
-- root cause in these three.

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- The fix: name the client roles.
-- ─────────────────────────────────────────────────────────────────────

revoke all on function public.account_credit_balance(uuid, uuid)
  from anon, authenticated;

revoke all on function public.redeem_account_credit(uuid, uuid, integer, uuid, text)
  from anon, authenticated;

revoke all on function public.redeem_coupon(uuid)
  from anon, authenticated;

-- Belt and braces: PUBLIC too, in case a future default privilege grants it.
revoke all on function public.account_credit_balance(uuid, uuid) from public;
revoke all on function public.redeem_account_credit(uuid, uuid, integer, uuid, text) from public;
revoke all on function public.redeem_coupon(uuid) from public;

-- ─────────────────────────────────────────────────────────────────────
-- The invariant, asserted on every apply.
--
-- This is the part that stops a recurrence. Add a function here when you
-- add a server-only one; the apply then fails loudly instead of shipping a
-- lock that is not a lock.
-- ─────────────────────────────────────────────────────────────────────

do $$
declare
  server_only text[] := array[
    'account_credit_balance(uuid, uuid)',
    'redeem_account_credit(uuid, uuid, integer, uuid, text)',
    'redeem_coupon(uuid)',
    -- Already correct today; listed so they stay that way.
    'compute_checkout_total(uuid, uuid)',
    'find_user_by_email(text)'
  ];
  fn text;
begin
  foreach fn in array server_only loop
    -- Skip anything not present in this database, so the assertion does not
    -- fail a branch where a function has a different signature.
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.oid = to_regprocedure('public.' || fn)
    ) then
      continue;
    end if;

    if has_function_privilege('anon', 'public.' || fn, 'execute') then
      raise exception 'server-only function % is executable by anon — revoke from anon, authenticated (not just from public)', fn;
    end if;
    if has_function_privilege('authenticated', 'public.' || fn, 'execute') then
      raise exception 'server-only function % is executable by authenticated — revoke from anon, authenticated (not just from public)', fn;
    end if;
  end loop;
end $$;

-- The deliberately-public ones must KEEP working — this fix must not have
-- over-revoked. A registration flow that cannot validate a coupon is its own
-- outage.
do $$
begin
  if not has_function_privilege('anon', 'public.validate_coupon(uuid, text, integer)', 'execute')
     and to_regprocedure('public.validate_coupon(uuid, text, integer)') is not null then
    raise exception 'validate_coupon must remain callable by anon — the checkout quotes discounts with it';
  end if;
  if not has_function_privilege('authenticated', 'public.grant_account_credit(text)', 'execute') then
    raise exception 'grant_account_credit must remain callable by authenticated — signup grants the campaign credit with it';
  end if;
  if not has_function_privilege('anon', 'public.record_campaign_event(text, text, text, text)', 'execute') then
    raise exception 'record_campaign_event must remain callable by anon — the public recap page writes the funnel with it';
  end if;
end $$;
