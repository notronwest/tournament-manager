-- 20260621000000_waitlists.sql
--
-- Waitlist feature (#42 [DB] sub-issue #437).
-- Additive-only: new enum values, one new column, new/modified functions.
--
-- What ships here:
--   • registration_status gains 'waitlisted_pending_payment' and 'waitlisted'
--   • event_registrations gains waitlist_position
--   • is_event_full(event_id)          — capacity check (stable, readable by all)
--   • join_waitlist(event_id)          — player RPC: join, get charged next
--   • waitlist_effective_position(reg_id) — player RPC: how far back am I?
--   • promote_from_waitlist(event_id)  — service_role: promote lowest → paid
--   • compute_checkout_total           — updated to include waitlisted_pending_payment
--   • refund_compute                   — updated: waitlisted → full refund always
--   • withdraw_self                    — updated: calls promote_from_waitlist on free

set search_path = public;

-- ── 1. New registration_status values ─────────────────────────────────────────
-- The 'waitlisted_pending_payment' and 'waitlisted' enum values are added in a
-- SEPARATE, earlier migration (20260622035000_waitlist_enum_values.sql) so they
-- are committed before this migration uses them. Postgres rejects using a new
-- enum value in the same transaction that adds it (SQLSTATE 55P04).

-- ── 2. waitlist_position column ────────────────────────────────────────────────

alter table event_registrations
  add column if not exists waitlist_position integer;

comment on column event_registrations.waitlist_position is
  'Monotonically increasing per-event position assigned at join time (1 = first). '
  'Null after promotion to paid or after leaving the waitlist. Effective display '
  'position is computed by counting lower-position active waitlist entries + 1.';

create index if not exists idx_event_regs_waitlist_pos
  on event_registrations (event_id, waitlist_position)
  where status = 'waitlisted' and deleted_at is null;

-- ── 3. is_event_full ──────────────────────────────────────────────────────────
-- True when the count of confirmed (paid) spots has reached max_teams.
-- Doubles: paired rows count once → ceil(paid_rows / 2).
-- Singles: paid_rows count directly.
-- NULL max_teams → uncapped → never full.

create or replace function public.is_event_full(p_event_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_max  smallint;
  v_fmt  event_format;
  v_used integer;
begin
  select max_teams, format
    into v_max, v_fmt
    from events
   where id = p_event_id and deleted_at is null;

  if not found or v_max is null then
    return false;
  end if;

  if v_fmt = 'doubles' then
    select ceil(count(*)::numeric / 2)::integer
      into v_used
      from event_registrations
     where event_id = p_event_id
       and status = 'paid'
       and deleted_at is null;
  else
    select count(*)::integer
      into v_used
      from event_registrations
     where event_id = p_event_id
       and status = 'paid'
       and deleted_at is null;
  end if;

  return coalesce(v_used, 0) >= v_max;
end;
$$;

comment on function public.is_event_full(uuid) is
  'True when confirmed (paid) spots reach max_teams. NULL max_teams → false.';

-- Readable by players and the public (event pages show capacity state).
grant execute on function public.is_event_full(uuid) to authenticated, anon;

-- ── 4. join_waitlist RPC ──────────────────────────────────────────────────────
-- Player self-joins the waitlist. Creates a waitlisted_pending_payment
-- registration that the standard checkout can charge immediately.
-- Guards: auth'd + player record exists, event exists and is full,
-- no duplicate active registration.

create or replace function public.join_waitlist(p_event_id uuid)
returns table (
  reg_id   uuid,
  position integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player uuid;
  v_fmt    event_format;
  v_pos    integer;
  v_reg    uuid;
  v_pstat  partner_status;
begin
  select id into v_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  select format into v_fmt
    from events
   where id = p_event_id and deleted_at is null;
  if not found then raise exception 'event_not_found'; end if;

  -- Enforce: event must be full (if a spot exists, redirect to normal register).
  if not is_event_full(p_event_id) then
    raise exception 'event_not_full';
  end if;

  -- Guard duplicate.
  if exists (
    select 1 from event_registrations
     where event_id = p_event_id
       and player_id = v_player
       and status not in ('cancelled', 'withdrawn', 'refunded')
       and deleted_at is null
  ) then
    raise exception 'already_registered';
  end if;

  -- Assign next position (gap-tolerant; effective position is computed
  -- dynamically by waitlist_effective_position below).
  select coalesce(max(waitlist_position), 0) + 1
    into v_pos
    from event_registrations
   where event_id = p_event_id
     and status in ('waitlisted_pending_payment', 'waitlisted')
     and deleted_at is null;

  v_pstat := case when v_fmt = 'doubles'
                  then 'seeking'::partner_status
                  else 'solo'::partner_status end;

  insert into event_registrations (
    event_id, player_id, event_fee_cents,
    status, partner_status, waitlist_position
  ) values (
    p_event_id, v_player, 0,
    'waitlisted_pending_payment', v_pstat, v_pos
  )
  returning id into v_reg;

  reg_id   := v_reg;
  position := v_pos;
  return next;
end;
$$;

comment on function public.join_waitlist(uuid) is
  'Player self-joins the waitlist for a full event. Creates a '
  'waitlisted_pending_payment registration for the standard checkout to charge. '
  'SECURITY DEFINER; auth.uid() ownership and event-full checks.';

grant execute on function public.join_waitlist(uuid) to authenticated;

-- ── 5. waitlist_effective_position RPC ────────────────────────────────────────
-- Returns the player's 1-indexed display position in the waitlist
-- (i.e. how many confirmed waitlisted players are ahead of them + 1).
-- Returns NULL if the reg doesn't belong to the caller or isn't waitlisted.

create or replace function public.waitlist_effective_position(p_reg_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player uuid;
  v_event  uuid;
  v_pos    integer;
  v_count  integer;
begin
  select id into v_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then return null; end if;

  select event_id, waitlist_position
    into v_event, v_pos
    from event_registrations
   where id = p_reg_id
     and player_id = v_player
     and status in ('waitlisted_pending_payment', 'waitlisted')
     and deleted_at is null;
  if not found then return null; end if;

  -- Count waitlisted entries ahead (strictly lower position, or lower id if same pos).
  select count(*)::integer + 1
    into v_count
    from event_registrations
   where event_id = v_event
     and status = 'waitlisted'
     and deleted_at is null
     and waitlist_position < coalesce(v_pos, 2147483647);

  return v_count;
end;
$$;

comment on function public.waitlist_effective_position(uuid) is
  'Returns the caller''s 1-indexed display position in the waitlist (people ahead + 1). '
  'NULL if not the caller''s reg or reg is not waitlisted.';

grant execute on function public.waitlist_effective_position(uuid) to authenticated;

-- ── 6. promote_from_waitlist ──────────────────────────────────────────────────
-- Promotes the lowest-position waitlisted registration to paid when a
-- confirmed spot opens (called by withdraw_self and stripe-refund resolve).
-- Idempotent: no-op when the waitlist is empty.
-- Returns the promoted reg_id + player_id so the caller can send email.

create or replace function public.promote_from_waitlist(p_event_id uuid)
returns table (
  promoted_reg_id    uuid,
  promoted_player_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg    uuid;
  v_player uuid;
begin
  -- Find earliest waitlisted entry.
  select id, player_id
    into v_reg, v_player
    from event_registrations
   where event_id = p_event_id
     and status = 'waitlisted'
     and deleted_at is null
   order by waitlist_position asc nulls last, registered_at asc
   limit 1;

  if not found then return; end if;

  -- Atomically promote.
  update event_registrations
     set status            = 'paid',
         waitlist_position = null,
         updated_at        = now()
   where id = v_reg
     and status = 'waitlisted';

  if not found then return; end if;  -- concurrent promote already ran

  promoted_reg_id    := v_reg;
  promoted_player_id := v_player;
  return next;
end;
$$;

comment on function public.promote_from_waitlist(uuid) is
  'Promotes the lowest-position waitlisted player to paid when a spot opens. '
  'Returns promoted reg_id + player_id for email notification. '
  'No-op (no rows returned) when the waitlist is empty. '
  'Called by withdraw_self and the stripe-refund edge function resolve mode.';

-- Only callable by service_role (edge function) and the SECURITY DEFINER
-- withdraw_self (which runs as superuser and bypasses this grant anyway).
revoke all on function public.promote_from_waitlist(uuid) from public, anon, authenticated;
grant execute on function public.promote_from_waitlist(uuid) to service_role;

-- ── 7. compute_checkout_total (updated) ───────────────────────────────────────
-- Include waitlisted_pending_payment alongside pending_payment so waitlist-
-- joiners pay in the same checkout basket as regular registrations.
-- Also treat 'waitlisted' as "already paid" for the first-event fee check.

create or replace function public.compute_checkout_total(
  p_player_id     uuid,
  p_tournament_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier        public.tournament_pricing_tiers;
  v_first       integer := 0;
  v_add         integer := 0;
  v_already_paid boolean := false;
  v_items       jsonb := '[]'::jsonb;
  v_total       integer := 0;
  r             record;
begin
  select * into v_tier from public.current_pricing_tier(p_tournament_id, now());
  if found then
    v_first := coalesce(v_tier.first_event_fee_cents, 0);
    v_add   := coalesce(v_tier.additional_event_fee_cents, 0);
  end if;

  -- Already has a paid or waitlisted reg → no first-event rate for new picks.
  select exists (
    select 1
      from public.event_registrations er
      join public.events e on e.id = er.event_id
     where e.tournament_id = p_tournament_id
       and er.player_id = p_player_id
       and er.status in ('paid', 'waitlisted')
       and er.deleted_at is null
  ) into v_already_paid;

  -- Walk the pending picks (both regular and waitlisted) ranked by price DESC.
  for r in
    with pend as (
      select er.id   as reg_id,
             e.id    as event_id,
             e.name  as event_name,
             e.event_fee_cents as override_cents,
             case when e.event_fee_cents > 0 then e.event_fee_cents else v_first end as full_price
        from public.event_registrations er
        join public.events e on e.id = er.event_id
       where e.tournament_id = p_tournament_id
         and er.player_id = p_player_id
         and er.status in ('pending_payment', 'waitlisted_pending_payment')
         and er.deleted_at is null
         and e.deleted_at is null
    )
    select reg_id, event_id, event_name, override_cents, full_price,
           row_number() over (order by full_price desc, reg_id) as rn
      from pend
  loop
    declare
      v_label  text;
      v_amount integer;
    begin
      if r.override_cents > 0 then
        v_label := 'override';
        v_amount := r.override_cents;
      elsif r.rn = 1 and not v_already_paid then
        v_label := 'first';
        v_amount := v_first;
      else
        v_label := 'additional';
        v_amount := v_add;
      end if;

      v_total := v_total + v_amount;
      v_items := v_items || jsonb_build_object(
        'event_registration_id', r.reg_id,
        'event_id', r.event_id,
        'description', r.event_name,
        'amount_cents', v_amount,
        'tier', v_label
      );
    end;
  end loop;

  return jsonb_build_object('total_cents', v_total, 'line_items', v_items);
end;
$$;

comment on function public.compute_checkout_total(uuid, uuid) is
  'Authoritative checkout total + line items for a player''s pending_payment '
  'and waitlisted_pending_payment regs in a tournament. Mirrors web/src/lib/pricing.ts. '
  'SECURITY DEFINER, service_role only (Stripe edge function).';

revoke all on function public.compute_checkout_total(uuid, uuid) from public, anon, authenticated;
grant execute on function public.compute_checkout_total(uuid, uuid) to service_role;

-- ── 8. refund_compute (updated) ───────────────────────────────────────────────
-- Waitlisted registrations always get a full refund (no cancellation policy —
-- the player paid to secure a waitlist spot; if they leave or are never promoted,
-- they always get everything back).

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

  if not found then return; end if;

  reg_status     := v_status;
  partner_reg_id := v_partner_reg;

  select t.cancellation_policy_preset, t.starts_at
    into v_preset, v_starts_at
    from tournaments t
   where t.id = v_tournament_id;
  preset := v_preset;

  -- ── Waitlisted: always full refund (no policy check) ──────────────────────
  if v_status = 'waitlisted' then
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

    if v_pay_id is null or paid_cents <= 0 then
      decision := 'manual_required'; refund_cents := 0; return next; return;
    end if;

    decision := 'full';
    refund_cents := paid_cents;
    return next; return;
  end if;

  -- ── Unpaid (pending_payment) ───────────────────────────────────────────────
  if v_status = 'pending_payment' then
    decision := 'unpaid'; refund_cents := 0; return next; return;
  end if;

  -- ── Terminal (already refunded / withdrawn / cancelled) ───────────────────
  if v_status <> 'paid' then
    decision := 'none'; refund_cents := 0; return next; return;
  end if;

  -- ── Paid: money context ───────────────────────────────────────────────────
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

  if v_pay_id is null or paid_cents <= 0 then
    decision := 'manual_required'; refund_cents := 0; return next; return;
  end if;

  select exists(
           select 1 from payment_line_items
            where payment_id = v_pay_id and amount_cents < 0
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

comment on function public.refund_compute(uuid) is
  'Read-only refund decision for one event registration. '
  'Waitlisted registrations always get a full refund (no policy check). '
  'Paid registrations use the tournament cancellation policy. '
  'Called by the stripe-refund edge function for dry_run and execute.';

revoke all on function public.refund_compute(uuid) from public;
grant execute on function public.refund_compute(uuid) to service_role;

-- ── 9. withdraw_self (updated) ────────────────────────────────────────────────
-- After withdrawing a paid registration (which frees a confirmed spot),
-- call promote_from_waitlist to move the next person up.
-- New return columns: promoted_reg_id + promoted_player_id (null if empty waitlist).

create or replace function public.withdraw_self(p_reg_id uuid)
returns table (
  new_status          registration_status,
  entitled_cents      integer,
  promoted_reg_id     uuid,
  promoted_player_id  uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_player  uuid;
  v_player_id    uuid;
  v_event_id     uuid;
  v_status       registration_status;
  v_partner_id   uuid;
  v_new_status   registration_status;
  v_decision     text;
  v_refund_cents integer;
  v_entitled     integer;
  v_promo_reg    uuid;
  v_promo_player uuid;
begin
  select id into v_auth_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  select er.player_id, er.event_id, er.status, er.partner_registration_id
    into v_player_id, v_event_id, v_status, v_partner_id
    from event_registrations er
   where er.id = p_reg_id and er.deleted_at is null;
  if not found then raise exception 'registration_not_found'; end if;

  if v_player_id <> v_auth_player then raise exception 'forbidden'; end if;

  if v_status not in ('paid', 'pending_payment') then
    raise exception 'not_withdrawable';
  end if;

  v_new_status := case v_status
    when 'pending_payment' then 'cancelled'::registration_status
    else 'withdrawn'::registration_status
  end;

  v_entitled := null;
  if v_status = 'paid' then
    select r.decision, r.refund_cents
      into v_decision, v_refund_cents
      from refund_compute(p_reg_id) r;

    v_entitled := case
      when v_decision is null or v_decision = 'manual_required' then null
      else v_refund_cents
    end;
  end if;

  update event_registrations
     set status                = v_new_status,
         entitled_refund_cents = v_entitled,
         updated_at            = now()
   where id = p_reg_id and status = v_status;

  if v_partner_id is not null then
    update event_registrations
       set partner_registration_id = null,
           partner_status          = 'seeking',
           updated_at              = now()
     where id = v_partner_id;
    update event_registrations
       set partner_registration_id = null,
           updated_at              = now()
     where id = p_reg_id;
  end if;

  -- When a confirmed spot is freed, promote the next waitlisted player.
  v_promo_reg    := null;
  v_promo_player := null;
  if v_new_status = 'withdrawn' then
    select p.promoted_reg_id, p.promoted_player_id
      into v_promo_reg, v_promo_player
      from promote_from_waitlist(v_event_id) p;
  end if;

  new_status          := v_new_status;
  entitled_cents      := v_entitled;
  promoted_reg_id     := v_promo_reg;
  promoted_player_id  := v_promo_player;
  return next;
end;
$$;

comment on function public.withdraw_self(uuid) is
  'Player self-withdraw: paid → withdrawn (entitled_refund_cents snapshotted), '
  'pending_payment → cancelled. Unpaids partner. On paid withdraw, calls '
  'promote_from_waitlist to fill the freed spot. Returns promoted_reg_id + '
  'promoted_player_id (null if no one was waiting). SECURITY DEFINER.';

grant execute on function public.withdraw_self(uuid) to authenticated;
