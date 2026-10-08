-- 20261008150000_account_credits.sql
--
-- The $20 org-scoped account credit (issue #1102, D-0077 §2): an append-only
-- ledger, granted server-side at signup for a live campaign, redeemed on the
-- coupon rail at checkout. See the decision doc for the full rationale —
-- this migration builds exactly the shape it already decided.
--
-- Two tables:
--   credit_campaigns  — config: which campaign grants how much, for which
--                        org, and whether it's currently live. Not exposed
--                        to the client at all (no grant/policy for anon or
--                        authenticated) — grant_account_credit() is the only
--                        reader, via SECURITY DEFINER.
--   account_credits    — the ledger itself. One row per grant/redemption/
--                        refund_restore. Append-only: no update/delete
--                        policy for anyone but service_role, no deleted_at.
--                        Balance = sum(amount_cents) over unexpired grants
--                        net of redemptions, per (organization_id, player_id).
--
-- Three functions:
--   grant_account_credit(campaign)            — client-callable (signup).
--   account_credit_balance(org, player)       — service_role only; the
--                                                authoritative balance read
--                                                used at checkout.
--   redeem_account_credit(org, player, ...)   — service_role only; the
--                                                atomic write at payment
--                                                success (or immediately for
--                                                a $0 free checkout).
--
-- Never cash: there is no function anywhere in this migration that pays out,
-- transfers, or refunds credit to a card. A refund that restores credit
-- writes a 'refund_restore' row (handled by whatever refunds the payment,
-- outside this issue's scope — not supabase/functions/stripe-refund/**,
-- which D-0077's own scope line excludes).

set search_path = public;

-- ─────────────────────────────────────────────────────────────────────
-- credit_campaigns — which live campaign grants how much, to which org.
-- ─────────────────────────────────────────────────────────────────────

create table public.credit_campaigns (
  campaign        text primary key,
  organization_id uuid not null references public.organizations(id),
  amount_cents    integer not null,
  starts_at       timestamptz,
  ends_at         timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint credit_campaigns_amount_positive check (amount_cents > 0)
);

comment on table public.credit_campaigns is
  'Config for which live campaign grants how much account credit, to which organization (issue #1102). Never exposed to the client — grant_account_credit() is the only reader.';

-- No policy for anyone, including authenticated — this table is read only by
-- the SECURITY DEFINER function below (which bypasses RLS).
alter table public.credit_campaigns enable row level security;
revoke all on public.credit_campaigns from anon, authenticated;

-- Seed the one live campaign (the Leaf Peeper thank-you email, D-0077).
insert into public.credit_campaigns (campaign, organization_id, amount_cents, active)
select 'leaf-peeper-2026', o.id, 2000, true
from public.organizations o
where o.slug = 'wmpc'
on conflict (campaign) do nothing;

-- ─────────────────────────────────────────────────────────────────────
-- account_credits — the append-only ledger.
-- ─────────────────────────────────────────────────────────────────────

create table public.account_credits (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id),
  player_id         uuid not null references public.players(id),
  amount_cents      integer not null,
  kind              text not null check (kind in ('grant', 'redemption', 'refund_restore')),
  campaign          text,
  expires_at        timestamptz,
  registration_id   uuid references public.event_registrations(id),
  payment_intent_id text,
  note              text,
  created_at        timestamptz not null default now(),
  constraint account_credits_amount_sign check (
    (kind = 'grant' and amount_cents > 0)
    or (kind = 'redemption' and amount_cents < 0)
    or (kind = 'refund_restore' and amount_cents > 0)
  )
);

comment on table public.account_credits is
  'Append-only ledger for org-scoped account credit (issue #1102, D-0077 §2): one row per grant/redemption/refund_restore, never a mutable balance column. Balance = sum(amount_cents) over unexpired grants net of redemptions, per (organization_id, player_id). qbo-api reads this as deferred revenue (D-0012) — a grant is a liability until redeemed or expired. Never cash: no code path here withdraws, transfers between players, or refunds a grant to a card.';

create index account_credits_org_player_idx
  on public.account_credits (organization_id, player_id);

-- Enforces the grant's idempotency at the DB level (same campaign + player →
-- one row), not just in the function body — so a genuine race (e.g. a
-- double-submit) can't double-grant even if two calls interleave.
create unique index account_credits_grant_once_idx
  on public.account_credits (campaign, player_id)
  where kind = 'grant';

-- Backs redeem_account_credit's idempotency check on a re-delivered webhook.
create index account_credits_payment_intent_idx
  on public.account_credits (payment_intent_id)
  where payment_intent_id is not null;

alter table public.account_credits enable row level security;

-- A player reads only their own rows. Nobody but service_role writes —
-- there is no insert/update/delete policy for anon or authenticated, and
-- update/delete are revoked outright (append-only; service_role bypasses
-- RLS and grants both, but there's nothing here for it to need a policy
-- for).
create policy "account_credits_select_own" on public.account_credits
  for select
  using (player_id = current_player_id());

revoke all on public.account_credits from anon, authenticated;
grant select on public.account_credits to authenticated; -- RLS above restricts to own rows
-- anon gets nothing: no grant at all.

-- Automated check, run on every apply: fails the migration if anon can ever
-- select this table (same pattern as campaign_events' own check).
do $$
begin
  if has_table_privilege('anon', 'account_credits', 'select') then
    raise exception 'account_credits must not be selectable by anon';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- grant_account_credit — the one write path a signed-in client may call.
-- ─────────────────────────────────────────────────────────────────────
--
-- Called once, right after a brand-new player row is inserted (see
-- ProfilePage.tsx's recordSignupEvent() call site — this mirrors it
-- exactly). player_id is stamped server-side from the caller's own
-- session via current_player_id(), never taken as an argument, so a
-- client can never name whose account gets credited. The amount and the
-- organization both come from credit_campaigns, never from the client,
-- so a client can never name how much or which org.
--
-- "Player is new" is enforced here, not trusted from the call site: any
-- signed-in player can call this RPC directly (it's granted to
-- authenticated), so the function itself checks the player has no prior
-- event_registrations or payments rows before granting — an existing
-- player can't claim a fresh campaign just because they hadn't used it
-- before.
--
-- Idempotent per (campaign, player_id): a second call for the same pair
-- is a no-op (covers a retried/duplicate client call). Best-effort by
-- design at the call site — a failure here must never block signup —
-- but this function itself raises no exceptions for the ordinary "not
-- live" / "already granted" / "not new" cases; it just reports why
-- nothing happened.

create or replace function public.grant_account_credit(p_campaign text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_campaign  public.credit_campaigns%rowtype;
begin
  v_player_id := current_player_id();
  if v_player_id is null then
    return jsonb_build_object('granted', false, 'reason', 'no_player');
  end if;

  select * into v_campaign
  from public.credit_campaigns
  where campaign = p_campaign;

  if not found then
    return jsonb_build_object('granted', false, 'reason', 'unknown_campaign');
  end if;

  if not v_campaign.active
    or (v_campaign.starts_at is not null and now() < v_campaign.starts_at)
    or (v_campaign.ends_at is not null and now() > v_campaign.ends_at)
  then
    return jsonb_build_object('granted', false, 'reason', 'campaign_not_live');
  end if;

  if exists (
    select 1 from public.account_credits
    where campaign = p_campaign and player_id = v_player_id and kind = 'grant'
  ) then
    return jsonb_build_object('granted', false, 'reason', 'already_granted');
  end if;

  -- "Player is new" (D-0077 §2 / issue #1102) — enforced here, server-side,
  -- not trusted from the call site: a player with any prior registration or
  -- payment has history, campaign or not, so this is an objective check
  -- rather than a time window on created_at (which a delayed call could miss).
  if exists (
    select 1 from public.event_registrations where player_id = v_player_id
  ) or exists (
    select 1 from public.payments where player_id = v_player_id
  ) then
    return jsonb_build_object('granted', false, 'reason', 'not_new_player');
  end if;

  begin
    insert into public.account_credits
      (organization_id, player_id, amount_cents, kind, campaign, expires_at)
    values
      (v_campaign.organization_id, v_player_id, v_campaign.amount_cents, 'grant',
       p_campaign, now() + interval '12 months');
  exception
    -- account_credits_grant_once_idx caught a genuine race (e.g. a
    -- double-submit) that the exists-check above missed — same outcome as
    -- the ordinary already_granted path, not an error.
    when unique_violation then
      return jsonb_build_object('granted', false, 'reason', 'already_granted');
  end;

  return jsonb_build_object(
    'granted', true,
    'organization_id', v_campaign.organization_id,
    'amount_cents', v_campaign.amount_cents
  );
end;
$$;

comment on function public.grant_account_credit(text) is
  'Server-side grant of account credit for a live campaign, called once right after a brand-new player row is created (issue #1102). player_id comes from current_player_id(), never a client argument. Checks the player is new (no prior event_registrations/payments) before granting — not trusted from the call site. Idempotent per (campaign, player_id). Best-effort by design: never raises for the ordinary not-live/already-granted/not-new cases.';

revoke all on function public.grant_account_credit(text) from public;
grant execute on function public.grant_account_credit(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- account_credit_balance — the authoritative balance read, server-only.
-- ─────────────────────────────────────────────────────────────────────
--
-- NOT granted to anon/authenticated — only service_role (which bypasses
-- function grants entirely) calls this, from create-payment-intent, to
-- compute how much credit is available before creating the Stripe
-- intent. Explicit org + player params because the caller is the
-- edge function's service-role admin client, which has no user session
-- for current_player_id() to resolve.

create or replace function public.account_credit_balance(
  p_organization_id uuid,
  p_player_id       uuid
)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(amount_cents), 0)::integer
  from public.account_credits
  where organization_id = p_organization_id
    and player_id = p_player_id
    and (kind <> 'grant' or expires_at is null or expires_at > now());
$$;

comment on function public.account_credit_balance(uuid, uuid) is
  'Authoritative account-credit balance for one (org, player): unexpired grants net of redemptions and refund_restores. Server-only (not granted to anon/authenticated) — called from create-payment-intent with explicit params since the edge function has no user session.';

revoke all on function public.account_credit_balance(uuid, uuid) from public;

-- ─────────────────────────────────────────────────────────────────────
-- redeem_account_credit — the atomic write at payment success.
-- ─────────────────────────────────────────────────────────────────────
--
-- Server-only (not granted to anon/authenticated), called from
-- stripe-webhook's handleSucceeded (and immediately, inline, for a $0
-- free checkout in create-payment-intent — there is no webhook for a
-- free registration). Mirrors redeem_coupon()'s shape: idempotent and
-- race-safe.
--
-- Race safety: an advisory xact lock on (organization_id, player_id)
-- serializes concurrent redemptions for the same player (e.g. two
-- browser tabs), so the balance it reads can't be stale by the time it
-- inserts. Idempotency: a redemption already recorded for this exact
-- payment_intent_id is a no-op (covers a re-delivered webhook, on top
-- of handleSucceeded's own payment.status guard).
--
-- Clamps to the available balance — it can never take the ledger below
-- zero, and it redeems AT MOST p_amount_cents (the remainder after any
-- coupon), never more. Returns the amount actually redeemed (cents),
-- which may be less than requested if the balance was smaller.

create or replace function public.redeem_account_credit(
  p_organization_id   uuid,
  p_player_id         uuid,
  p_amount_cents      integer,
  p_registration_id   uuid,
  p_payment_intent_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance   integer;
  v_to_redeem integer;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_player_id::text, 0));

  if exists (
    select 1 from public.account_credits
    where payment_intent_id = p_payment_intent_id and kind = 'redemption'
  ) then
    return 0; -- already redeemed for this payment intent (re-delivered webhook)
  end if;

  v_balance := public.account_credit_balance(p_organization_id, p_player_id);
  v_to_redeem := least(p_amount_cents, v_balance);
  if v_to_redeem <= 0 then
    return 0;
  end if;

  insert into public.account_credits
    (organization_id, player_id, amount_cents, kind, registration_id, payment_intent_id)
  values
    (p_organization_id, p_player_id, -v_to_redeem, 'redemption', p_registration_id, p_payment_intent_id);

  return v_to_redeem;
end;
$$;

comment on function public.redeem_account_credit(uuid, uuid, integer, uuid, text) is
  'Atomically redeem up to p_amount_cents of account credit (clamped to the available balance; race-safe via an advisory lock). Server-only. Idempotent per payment_intent_id. Call at payment success (stripe-webhook) or immediately for a $0 free checkout (create-payment-intent) — never from the client.';

revoke all on function public.redeem_account_credit(uuid, uuid, integer, uuid, text) from public;
