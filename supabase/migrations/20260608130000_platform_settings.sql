-- 20260608130000_platform_settings.sql
--
-- Platform-wide settings the site super-admin can edit WITHOUT code
-- (issue #20 decision: platform fee is a no-code admin setting, not an
-- env var). v1 holds just the platform fee for Stripe Connect
-- destination charges; more global knobs can be added as columns later.
--
-- Singleton table: a one-row config enforced by a boolean PK that can
-- only be true. The Stripe create-payment-intent edge function reads
-- this row (service_role) to compute application_fee_amount; platform
-- admins read + write it through the platform settings UI.

set search_path = public;

-- Helper: is the current user a platform (super) admin? Mirrors the
-- read-self gate on platform_admins, reusable in policies.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = auth.uid()
  );
$$;

comment on function public.is_platform_admin() is
  'True if the current auth user is in platform_admins. SECURITY DEFINER so it can be called from RLS policies on other tables.';

create table public.platform_settings (
  id                      boolean primary key default true,
  -- Platform fee on each registration payment (Connect destination
  -- charge). application_fee_amount = round(total * bps / 10000) + fixed.
  platform_fee_bps        integer not null default 0,
  platform_fee_fixed_cents integer not null default 0,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id),
  constraint platform_settings_singleton check (id = true),
  constraint platform_fee_bps_range check (platform_fee_bps between 0 and 10000),
  constraint platform_fee_fixed_nonneg check (platform_fee_fixed_cents >= 0)
);

comment on table public.platform_settings is
  'Single-row global platform config (issue #20). Holds the Stripe platform fee; editable by platform admins via the platform settings UI, read by the create-payment-intent edge function.';

-- Seed the singleton row (fee 0 until Ron sets it in the UI).
insert into public.platform_settings (id) values (true)
  on conflict (id) do nothing;

-- RLS ----------------------------------------------------------------
alter table public.platform_settings enable row level security;

-- Platform admins read + write the single row. The edge function reads
-- via service_role (bypasses RLS). No other roles need access.
create policy "platform_settings read by platform admin" on public.platform_settings
  for select using (is_platform_admin());

create policy "platform_settings write by platform admin" on public.platform_settings
  for update using (is_platform_admin()) with check (is_platform_admin());
