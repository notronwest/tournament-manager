-- Per-ORGANIZATION platform-fee override — the middle tier of a three-level
-- fee resolution.
--
-- Before this migration there were two levels: the global default
-- (platform_settings, 20260608130000) and a per-tournament override
-- (tournaments.platform_fee_*, 20260702170000). Setting one rate for an
-- organizer meant hand-editing every one of their tournaments, and a new
-- tournament silently fell back to the global default instead of that
-- organizer's agreed rate.
--
-- Resolution order, most specific wins (see
-- supabase/functions/_shared/platformFee.ts — resolvePlatformFee is the single
-- implementation the edge function and the admin UI both call):
--
--   tournament override  →  organization override  →  global default
--
-- Money-path safety: the platform fee is the PLATFORM's cut, so an org admin
-- must NOT be able to set or zero it on their own organization. A BEFORE
-- trigger restricts changes to the fee columns to platform admins, mirroring
-- trg_enforce_tournament_fee_admin. The trigger only fires when a fee column
-- actually changes, so ordinary organization edits by org admins pass through
-- untouched.

-- ── Columns ───────────────────────────────────────────────────────────
-- Both null → inherit the global default. Both set → applies to every
-- tournament in the org that has no override of its own.
alter table public.organizations
  add column if not exists platform_fee_bps         integer,
  add column if not exists platform_fee_fixed_cents integer;

comment on column public.organizations.platform_fee_bps is
  'Per-organization platform-fee percent in basis points. NULL = inherit the platform_settings default. Set together with platform_fee_fixed_cents. Overridden by tournaments.platform_fee_bps. Platform-admin-only (enforced by trg_enforce_org_fee_admin).';
comment on column public.organizations.platform_fee_fixed_cents is
  'Per-organization fixed platform fee in cents. NULL = inherit the platform_settings default. Set together with platform_fee_bps. Overridden by tournaments.platform_fee_fixed_cents. Platform-admin-only.';

-- ── Constraints ───────────────────────────────────────────────────────
-- Dropped first so a re-run re-adds them rather than erroring: ALTER TABLE
-- has no `add constraint if not exists`.
alter table public.organizations
  drop constraint if exists org_platform_fee_both_or_neither,
  drop constraint if exists org_platform_fee_bps_range,
  drop constraint if exists org_platform_fee_fixed_nonneg;

alter table public.organizations
  -- both-or-neither: no half-set (ambiguous) override.
  add constraint org_platform_fee_both_or_neither
    check ((platform_fee_bps is null) = (platform_fee_fixed_cents is null)),
  -- same ranges platform_settings and tournaments enforce.
  add constraint org_platform_fee_bps_range
    check (platform_fee_bps is null or platform_fee_bps between 0 and 10000),
  add constraint org_platform_fee_fixed_nonneg
    check (platform_fee_fixed_cents is null or platform_fee_fixed_cents >= 0);

-- ── Platform-admin-only guard ─────────────────────────────────────────
-- "May this caller set the platform's own cut?" — true for a platform admin
-- acting through the client, and for the privileged DB roles (service_role
-- already bypasses RLS by design, so refusing it buys no safety and only
-- blocks a legitimate backfill or edge-function fix-up). What it keeps out is
-- the actual threat: an ORG admin zeroing the platform's cut on their own org.
--
-- DELIBERATELY *NOT* security definer, and neither are the triggers that call
-- it. Inside a SECURITY DEFINER function current_user is the function's OWNER
-- (postgres) — so a `current_user in ('postgres', …)` test there is always
-- true, and an ordinary org owner would sail straight through. Verified: the
-- definer version returned true for a plain org owner. As a plain invoker
-- function reached from an invoker trigger, current_user is the real caller
-- ('authenticated' / 'service_role'). is_platform_admin() stays definer (it
-- needs to read platform_admins past RLS) and resolves auth.uid() from the
-- request GUC either way, so nothing is lost by dropping definer here.
create or replace function public.may_set_platform_fee()
returns boolean
language sql
stable
set search_path = public
as $$
  select current_user in ('postgres', 'service_role', 'supabase_admin')
      or public.is_platform_admin();
$$;

comment on function public.may_set_platform_fee() is
  'True when the caller may write a platform-fee column: a platform admin, or a privileged DB role (service_role/postgres). Used by the organization and tournament fee-column guards.';

create or replace function public.enforce_org_fee_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if (new.platform_fee_bps is not null or new.platform_fee_fixed_cents is not null)
       and not public.may_set_platform_fee() then
      raise exception 'Only platform admins can set an organization platform-fee override'
        using errcode = 'check_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.platform_fee_bps is distinct from old.platform_fee_bps
        or new.platform_fee_fixed_cents is distinct from old.platform_fee_fixed_cents)
       and not public.may_set_platform_fee() then
      raise exception 'Only platform admins can change an organization platform-fee override'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.enforce_org_fee_admin() is
  'Restricts changes to organizations.platform_fee_* to callers may_set_platform_fee() allows. Deliberately SECURITY INVOKER so current_user is the real caller.';

drop trigger if exists trg_enforce_org_fee_admin on public.organizations;
create trigger trg_enforce_org_fee_admin
  before insert or update on public.organizations
  for each row execute function public.enforce_org_fee_admin();

-- ── Align the per-TOURNAMENT guard with the same rule ─────────────────
-- 20260702170000 gated the tournament fee columns on is_platform_admin()
-- alone, which also refuses service_role and postgres (auth.uid() is null
-- there, so is_platform_admin() is false). That has been harmless only
-- because create-payment-intent merely READS those columns — but it means a
-- backfill or a server-side fix-up of a tournament's fee fails, and it is
-- the opposite of the intent: service_role bypasses RLS anyway. Same
-- function, same rule, both levels. It also drops SECURITY DEFINER for the
-- reason spelled out on may_set_platform_fee(): under definer, current_user is
-- the owner, so the privileged-role test would hold for everyone.
create or replace function public.enforce_tournament_fee_admin()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if (new.platform_fee_bps is not null or new.platform_fee_fixed_cents is not null)
       and not public.may_set_platform_fee() then
      raise exception 'Only platform admins can set a tournament platform-fee override'
        using errcode = 'check_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.platform_fee_bps is distinct from old.platform_fee_bps
        or new.platform_fee_fixed_cents is distinct from old.platform_fee_fixed_cents)
       and not public.may_set_platform_fee() then
      raise exception 'Only platform admins can change a tournament platform-fee override'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
