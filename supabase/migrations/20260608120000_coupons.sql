-- 20260608120000_coupons.sql
--
-- Coupon codes at checkout (issue #30). v1 scope: coupons are
-- TOURNAMENT-scoped (a code belongs to one tournament). Org-wide promo
-- codes are a follow-up — keeping v1 narrow avoids cross-tournament
-- accounting questions before Stripe charging (#20) even lands.
--
-- Security model:
--   * The coupons table is NOT publicly readable — codes must not be
--     enumerable. Org admins CRUD their tournament's coupons; the public
--     never SELECTs the table.
--   * Players validate a code they already know via validate_coupon()
--     (SECURITY DEFINER, read-only) which returns the authoritative
--     discount — the client can never compute/forge its own discount.
--   * Use-count gating is atomic via redeem_coupon() (SECURITY DEFINER),
--     called server-side from the Stripe intent/webhook edge function
--     at payment success. Validation does NOT increment (so abandoned
--     checkouts and previews don't burn uses).
--
-- The actual Stripe discount application (lowering the PaymentIntent
-- amount) is part of #20's edge function — out of scope here. This
-- migration only provides the schema + the trustworthy discount math.

set search_path = public;

create type coupon_discount_type as enum ('percent', 'fixed_amount');

create table public.coupons (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  code           text not null,
  discount_type  coupon_discount_type not null,
  -- percent: whole-number 1..100. fixed_amount: cents (> 0).
  discount_value integer not null,
  -- null = unlimited uses.
  max_uses       integer,
  uses_count     integer not null default 0,
  starts_at      timestamptz,
  expires_at     timestamptz,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint coupons_discount_value_positive check (discount_value > 0),
  constraint coupons_percent_range check (
    discount_type <> 'percent' or (discount_value between 1 and 100)
  ),
  constraint coupons_max_uses_positive check (max_uses is null or max_uses > 0)
);

comment on table public.coupons is
  'Tournament-scoped discount codes (issue #30). Not publicly readable — validate via validate_coupon(); redeem atomically via redeem_coupon() at payment success.';

-- One live code per tournament, case-insensitive.
create unique index coupons_code_per_tournament
  on public.coupons (tournament_id, lower(code))
  where deleted_at is null;

create index coupons_tournament_live_idx
  on public.coupons (tournament_id)
  where deleted_at is null;

-- RLS ----------------------------------------------------------------
alter table public.coupons enable row level security;

-- Org admins (of the tournament's org) read + manage. No public SELECT
-- policy — codes are validated through the SECURITY DEFINER RPC only,
-- which bypasses RLS for the lookup.
create policy "coupons read by org" on public.coupons
  for select using (
    exists (
      select 1 from public.tournaments t
      where t.id = coupons.tournament_id
        and is_org_member(t.organization_id)
    )
  );

create policy "coupons write by org admins" on public.coupons
  for all using (
    exists (
      select 1 from public.tournaments t
      where t.id = coupons.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from public.tournaments t
      where t.id = coupons.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  );

-- validate_coupon -----------------------------------------------------
-- Read-only validity check + authoritative discount computation.
-- Returns a jsonb: { valid, error, coupon_id, discount_type,
-- discount_cents }. Does NOT mutate uses_count.
create or replace function public.validate_coupon(
  p_tournament_id uuid,
  p_code          text,
  p_subtotal_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c          public.coupons%rowtype;
  v_discount integer;
begin
  if p_subtotal_cents is null or p_subtotal_cents < 0 then
    return jsonb_build_object('valid', false, 'error', 'invalid_subtotal');
  end if;

  select * into c
  from public.coupons
  where tournament_id = p_tournament_id
    and lower(code) = lower(p_code)
    and deleted_at is null
  limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'error', 'not_found');
  end if;

  if not c.active then
    return jsonb_build_object('valid', false, 'error', 'inactive');
  end if;

  if c.starts_at is not null and now() < c.starts_at then
    return jsonb_build_object('valid', false, 'error', 'not_started');
  end if;

  if c.expires_at is not null and now() > c.expires_at then
    return jsonb_build_object('valid', false, 'error', 'expired');
  end if;

  if c.max_uses is not null and c.uses_count >= c.max_uses then
    return jsonb_build_object('valid', false, 'error', 'exhausted');
  end if;

  if c.discount_type = 'percent' then
    v_discount := floor(p_subtotal_cents * c.discount_value / 100.0);
  else
    v_discount := c.discount_value;
  end if;

  -- never discount below zero.
  v_discount := least(v_discount, p_subtotal_cents);

  return jsonb_build_object(
    'valid', true,
    'coupon_id', c.id,
    'discount_type', c.discount_type,
    'discount_cents', v_discount
  );
end;
$$;

comment on function public.validate_coupon(uuid, text, integer) is
  'Read-only coupon validation + authoritative discount math for a tournament checkout. Does not increment uses. SECURITY DEFINER so a known code validates without the coupons table being publicly readable.';

revoke all on function public.validate_coupon(uuid, text, integer) from public;
grant execute on function public.validate_coupon(uuid, text, integer) to anon, authenticated;

-- redeem_coupon -------------------------------------------------------
-- Atomically claim one use. Returns true if a use was claimed, false if
-- the coupon is exhausted/inactive/expired (race-safe via the WHERE
-- guard on the UPDATE). Intended to be called server-side (service_role)
-- from the Stripe edge function on payment success, NOT from the client.
create or replace function public.redeem_coupon(p_coupon_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.coupons
     set uses_count = uses_count + 1,
         updated_at = now()
   where id = p_coupon_id
     and deleted_at is null
     and active
     and (starts_at is null or now() >= starts_at)
     and (expires_at is null or now() <= expires_at)
     and (max_uses is null or uses_count < max_uses);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

comment on function public.redeem_coupon(uuid) is
  'Atomically claim one coupon use (race-safe). Returns false if exhausted/inactive/expired. Call server-side from the Stripe edge function at payment success — not exposed to clients.';

-- Not granted to anon/authenticated: redemption is service_role only.
revoke all on function public.redeem_coupon(uuid) from public;
