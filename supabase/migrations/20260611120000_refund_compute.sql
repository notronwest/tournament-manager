-- 20260611120000_refund_compute.sql
--
-- refund_compute(p_event_registration_id) — pure, READ-ONLY refund decision
-- for one paid event registration. See docs/REFUNDS.md for the full spec.
--
-- No writes, no Stripe. The `stripe-refund` edge function calls this (as
-- service_role) for BOTH the dry_run preview and the execute step, so the
-- previewed amount and the charged amount are computed by the same code and
-- always agree.
--
-- Refund scope (locked 2026-06-11): event fee only (the entry fee is a
-- separate, non-refundable line item); platform application fee is kept;
-- a "half" window rounds to the nearest cent.

set search_path = public;

create or replace function public.refund_compute(p_event_registration_id uuid)
returns table (
  decision        text,                    -- full | partial | none | unpaid | manual_required
  paid_cents      integer,                  -- event fee paid for this reg (line item sum)
  refund_cents    integer,                  -- amount to refund now
  reg_status      registration_status,      -- current registration status
  preset          cancellation_policy_preset,
  payment_id      uuid,
  payment_intent  text,
  charge_id       text,
  connected_acct  text,
  partner_reg_id  uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_status        registration_status;
  v_partner_reg   uuid;
  v_registered_at timestamptz;
  v_tournament_id uuid;
  v_preset        cancellation_policy_preset;
  v_starts_at     timestamptz;
  v_pay_id        uuid;
  v_intent        text;
  v_charge        text;
  v_acct          text;
  v_paid          integer;
  v_has_coupon    boolean := false;
  v_days_to_start numeric;
  v_reg_age_days  numeric;
begin
  -- Defaults (overwritten below). Conservative: unknown → manual review.
  decision     := 'manual_required';
  paid_cents   := 0;
  refund_cents := 0;

  -- ── Load the registration + its tournament's policy/timing ──────────
  select er.status, er.partner_registration_id, er.registered_at, e.tournament_id
    into v_status, v_partner_reg, v_registered_at, v_tournament_id
    from event_registrations er
    join events e on e.id = er.event_id
   where er.id = p_event_registration_id
     and er.deleted_at is null;

  if not found then
    return;  -- no rows → caller treats as registration_not_found
  end if;

  reg_status     := v_status;
  partner_reg_id := v_partner_reg;

  select t.cancellation_policy_preset, t.starts_at
    into v_preset, v_starts_at
    from tournaments t
   where t.id = v_tournament_id;
  preset := v_preset;

  -- ── Money context: the succeeded payment covering this reg ──────────
  select p.id, p.stripe_payment_intent_id, p.stripe_charge_id,
         p.stripe_connected_account_id, coalesce(sum(li.amount_cents), 0)::int
    into v_pay_id, v_intent, v_charge, v_acct, v_paid
    from payment_line_items li
    join payments p on p.id = li.payment_id
   where li.event_registration_id = p_event_registration_id
     and p.status = 'succeeded'
   group by p.id, p.stripe_payment_intent_id, p.stripe_charge_id,
            p.stripe_connected_account_id
   order by 5 desc
   limit 1;

  payment_id     := v_pay_id;
  payment_intent := v_intent;
  charge_id      := v_charge;
  connected_acct := v_acct;
  paid_cents     := coalesce(v_paid, 0);

  -- ── Short-circuits ──────────────────────────────────────────────────
  -- Unpaid: nothing to refund; the edge fn just cancels.
  if v_status = 'pending_payment' then
    decision := 'unpaid'; refund_cents := 0; return next; return;
  end if;

  -- Anything not currently 'paid' is terminal (already refunded/withdrawn/
  -- cancelled) — nothing to do.
  if v_status <> 'paid' then
    decision := 'none'; refund_cents := 0; return next; return;
  end if;

  -- Paid but we can't find the money (data inconsistency) → human review.
  if v_pay_id is null or paid_cents <= 0 then
    decision := 'manual_required'; refund_cents := 0; return next; return;
  end if;

  -- Coupon on the covering payment makes the per-event line item overstate
  -- what the player NET paid → review rather than risk over-refunding.
  select exists(
           select 1 from payment_line_items
            where payment_id = v_pay_id and amount_cents < 0
         )
    into v_has_coupon;
  if v_has_coupon then
    decision := 'manual_required'; refund_cents := 0; return next; return;
  end if;

  -- ── Policy decision ─────────────────────────────────────────────────
  v_days_to_start := extract(epoch from (v_starts_at - now())) / 86400.0;
  v_reg_age_days  := extract(epoch from (now() - v_registered_at)) / 86400.0;

  if v_preset = 'generous' then
    if v_days_to_start > 7 then decision := 'full'; else decision := 'none'; end if;

  elsif v_preset = 'standard' then
    if v_reg_age_days <= 7 then
      decision := 'full';                       -- registration cooling-off
    elsif v_days_to_start >= 7 then
      decision := 'partial';                    -- half; 7–30d folded into half (see REFUNDS.md)
    else
      decision := 'none';                       -- within 7 days of start
    end if;

  elsif v_preset = 'strict' then
    decision := 'none';                         -- no refund after registration

  else
    decision := 'manual_required';              -- custom or NULL preset
  end if;

  -- ── Amount ──────────────────────────────────────────────────────────
  if decision = 'full' then
    refund_cents := paid_cents;
  elsif decision = 'partial' then
    refund_cents := round(paid_cents::numeric / 2.0)::int;  -- nearest cent
  else
    refund_cents := 0;
  end if;

  -- Clamp into [0, paid_cents].
  if refund_cents < 0 then refund_cents := 0; end if;
  if refund_cents > paid_cents then refund_cents := paid_cents; end if;

  return next;
end;
$$;

comment on function public.refund_compute(uuid) is
  'Read-only refund decision (full/partial/none/unpaid/manual_required) + amount for one event registration, per the tournament cancellation policy. Called by the stripe-refund edge function for dry_run and execute. See docs/REFUNDS.md.';

-- Server-only: the stripe-refund edge function calls this as service_role.
-- It is SECURITY DEFINER (bypasses RLS), so do NOT expose it to clients.
revoke all on function public.refund_compute(uuid) from public;
grant execute on function public.refund_compute(uuid) to service_role;
