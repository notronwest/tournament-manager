-- 20260613000000_withdraw_self_rpc.sql
--
-- Two SECURITY DEFINER RPCs for the revised player withdraw + request-refund
-- flow (#289). Both carry an explicit auth.uid() ownership check.
--
-- withdraw_self(reg_id)
--   Player clicks Withdraw → ConfirmModal → calls this RPC.
--   paid → withdrawn (entitled refund snapshotted via refund_compute).
--   pending_payment → cancelled.
--   Unpaids the doubles partner. No Stripe call. No auto-refund.
--
-- file_refund_request(reg_id, reason)
--   Player clicks "Request refund" on a withdrawn reg → calls this.
--   Stamps withdrawal_requested_at + withdrawal_reason. Idempotent
--   (re-filing returns false).
--
-- Also adds entitled_refund_cents (nullable int) to event_registrations:
-- the policy refund amount frozen at the moment of withdrawal so that an
-- organizer's delay cannot shrink it.
--
-- Note: withdraw_self calls refund_compute() internally. refund_compute is
-- REVOKE'd from public and granted only to service_role, but a SECURITY
-- DEFINER function owned by the postgres superuser can execute it regardless
-- of that grant (superuser bypasses privilege checks).

set search_path = public;

-- ── New column ───────────────────────────────────────────────────────────────

alter table event_registrations
  add column if not exists entitled_refund_cents integer;

comment on column event_registrations.entitled_refund_cents is
  'Policy refund amount (cents) frozen at the moment the player withdrew. '
  'NULL for manual_required / unpaid regs (organizer decides the amount); '
  '0 for policy-no-refund cases (strict or past the window). '
  'Set atomically by withdraw_self() so an organizer delay cannot shrink it.';

-- ── withdraw_self ────────────────────────────────────────────────────────────

create or replace function public.withdraw_self(p_reg_id uuid)
returns table (
  new_status     registration_status,
  entitled_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_player  uuid;
  v_player_id    uuid;
  v_status       registration_status;
  v_partner_id   uuid;
  v_new_status   registration_status;
  v_decision     text;
  v_refund_cents integer;
  v_entitled     integer;
begin
  -- Resolve calling user → player record.
  select id into v_auth_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  -- Load the registration.
  select er.player_id, er.status, er.partner_registration_id
    into v_player_id, v_status, v_partner_id
    from event_registrations er
   where er.id = p_reg_id and er.deleted_at is null;
  if not found then raise exception 'registration_not_found'; end if;

  -- Ownership check.
  if v_player_id <> v_auth_player then raise exception 'forbidden'; end if;

  -- Only paid / pending_payment are withdrawable.
  if v_status not in ('paid', 'pending_payment') then
    raise exception 'not_withdrawable';
  end if;

  -- Determine target status.
  v_new_status := case v_status
    when 'pending_payment' then 'cancelled'::registration_status
    else 'withdrawn'::registration_status
  end;

  -- For paid regs: snapshot the entitled refund NOW (while status is still
  -- 'paid') so the amount is frozen to the withdrawal moment.
  v_entitled := null;
  if v_status = 'paid' then
    select r.decision, r.refund_cents
      into v_decision, v_refund_cents
      from refund_compute(p_reg_id) r;

    -- manual_required or missing payment → null (organizer determines amount).
    -- none → 0 (policy denies refund; still shown transparently to player).
    -- full / partial → the computed amount.
    v_entitled := case
      when v_decision is null or v_decision = 'manual_required' then null
      else v_refund_cents
    end;
  end if;

  -- Flip status + snapshot entitled_refund_cents atomically.
  update event_registrations
     set status                = v_new_status,
         entitled_refund_cents = v_entitled,
         updated_at            = now()
   where id = p_reg_id and status = v_status;

  -- Unpair partner: restore them to "seeking" state.
  if v_partner_id is not null then
    update event_registrations
       set partner_registration_id = null,
           partner_status          = 'seeking',
           updated_at              = now()
     where id = v_partner_id;
    -- Clear our own partner pointer (entitled_refund_cents update already ran above).
    update event_registrations
       set partner_registration_id = null,
           updated_at              = now()
     where id = p_reg_id;
  end if;

  new_status     := v_new_status;
  entitled_cents := v_entitled;
  return next;
end;
$$;

comment on function public.withdraw_self(uuid) is
  'Player self-withdraw: paid → withdrawn (entitled_refund_cents snapshotted '
  'from refund_compute), pending_payment → cancelled. Unpaids the doubles '
  'partner. No Stripe call. SECURITY DEFINER; auth.uid() ownership check '
  'is explicit.';

grant execute on function public.withdraw_self(uuid) to authenticated;

-- ── file_refund_request ──────────────────────────────────────────────────────

create or replace function public.file_refund_request(
  p_reg_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_player uuid;
  v_player_id   uuid;
  v_status      registration_status;
  v_already     boolean;
begin
  -- Resolve calling user → player record.
  select id into v_auth_player
    from players
   where auth_user_id = auth.uid() and deleted_at is null;
  if not found then raise exception 'player_not_found'; end if;

  -- Load the registration.
  select er.player_id,
         er.status,
         (er.withdrawal_requested_at is not null) as already_filed
    into v_player_id, v_status, v_already
    from event_registrations er
   where er.id = p_reg_id and er.deleted_at is null;
  if not found then raise exception 'registration_not_found'; end if;

  -- Ownership check.
  if v_player_id <> v_auth_player then raise exception 'forbidden'; end if;

  -- Must be in withdrawn state (was previously paid).
  if v_status <> 'withdrawn' then raise exception 'not_withdrawn'; end if;

  -- Idempotent: if already filed, no-op.
  if v_already then return false; end if;

  update event_registrations
     set withdrawal_requested_at = now(),
         withdrawal_reason       = left(coalesce(p_reason, ''), 2000),
         updated_at              = now()
   where id = p_reg_id
     and withdrawal_requested_at is null;

  return true;
end;
$$;

comment on function public.file_refund_request(uuid, text) is
  'Player files a refund request on an already-withdrawn reg: stamps '
  'withdrawal_requested_at and (optional) withdrawal_reason. Idempotent — '
  're-filing returns false. Feeds the organizer decision queue (#200). '
  'SECURITY DEFINER; auth.uid() ownership check is explicit.';

grant execute on function public.file_refund_request(uuid, text) to authenticated;
