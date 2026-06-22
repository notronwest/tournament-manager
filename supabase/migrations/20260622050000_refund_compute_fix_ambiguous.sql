-- 20260622050000_refund_compute_fix_ambiguous.sql
-- (Renumbered from 20260622020000 to stay AFTER the renumbered waitlists
--  migration, since both define refund_compute() and this one is the fix that
--  must win. CREATE OR REPLACE → re-applying to TEST is a no-op.)
--
-- Bug fix: withdrawing a PAID registration failed with
--   "column reference \"payment_id\" is ambiguous"
-- refund_compute() declares an OUT column named `payment_id`, and the
-- coupon-check subquery referenced an unqualified `payment_id` against
-- payment_line_items — Postgres couldn't tell the OUT param from the column.
-- This broke withdraw_self() (which calls refund_compute for paid regs), so
-- ALL paid withdrawals errored — on both the My Tournaments and register-page
-- paths. (Surfaced once register-page Unregister started routing through
-- withdraw_self in #427.)
--
-- Fix: qualify the column (payment_line_items pli → pli.payment_id). Function
-- body is otherwise identical to 20260611120000_refund_compute.sql.

set search_path = public;

create or replace function public.refund_compute(p_event_registration_id uuid)
returns table (
  decision        text,
  paid_cents      integer,
  refund_cents    integer,
  reg_status      registration_status,
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
  decision     := 'manual_required';
  paid_cents   := 0;
  refund_cents := 0;

  select er.status, er.partner_registration_id, er.registered_at, e.tournament_id
    into v_status, v_partner_reg, v_registered_at, v_tournament_id
    from event_registrations er
    join events e on e.id = er.event_id
   where er.id = p_event_registration_id
     and er.deleted_at is null;

  if not found then
    return;
  end if;

  reg_status     := v_status;
  partner_reg_id := v_partner_reg;

  select t.cancellation_policy_preset, t.starts_at
    into v_preset, v_starts_at
    from tournaments t
   where t.id = v_tournament_id;
  preset := v_preset;

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

  if v_status = 'pending_payment' then
    decision := 'unpaid'; refund_cents := 0; return next; return;
  end if;

  if v_status <> 'paid' then
    decision := 'none'; refund_cents := 0; return next; return;
  end if;

  if v_pay_id is null or paid_cents <= 0 then
    decision := 'manual_required'; refund_cents := 0; return next; return;
  end if;

  -- Coupon on the covering payment makes the per-event line item overstate
  -- what the player NET paid → review rather than risk over-refunding.
  -- (payment_id qualified as pli.payment_id to avoid colliding with the
  --  OUT parameter of the same name — the bug this migration fixes.)
  select exists(
           select 1 from payment_line_items pli
            where pli.payment_id = v_pay_id and pli.amount_cents < 0
         )
    into v_has_coupon;
  if v_has_coupon then
    decision := 'manual_required'; refund_cents := 0; return next; return;
  end if;

  v_days_to_start := extract(epoch from (v_starts_at - now())) / 86400.0;
  v_reg_age_days  := extract(epoch from (now() - v_registered_at)) / 86400.0;

  if v_preset = 'generous' then
    if v_days_to_start > 7 then decision := 'full'; else decision := 'none'; end if;

  elsif v_preset = 'standard' then
    if v_reg_age_days <= 7 then
      decision := 'full';
    elsif v_days_to_start >= 7 then
      decision := 'partial';
    else
      decision := 'none';
    end if;

  elsif v_preset = 'strict' then
    decision := 'none';

  else
    decision := 'manual_required';
  end if;

  if decision = 'full' then
    refund_cents := paid_cents;
  elsif decision = 'partial' then
    refund_cents := round(paid_cents::numeric / 2.0)::int;
  else
    refund_cents := 0;
  end if;

  if refund_cents < 0 then refund_cents := 0; end if;
  if refund_cents > paid_cents then refund_cents := paid_cents; end if;

  return next;
end;
$$;

revoke all on function public.refund_compute(uuid) from public;
grant execute on function public.refund_compute(uuid) to service_role;
