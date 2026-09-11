-- 20260911120000_sweep_stale_pending_regs_cron.sql
--
-- The stale-pending sweep finally gets a scheduler — and becomes team-safe.
--
-- Background (2026-09-11): supabase/functions/sweep-stale-pending-regs was written
-- (2026-05-25) "to be invoked on a schedule", but nothing ever scheduled it — no
-- pg_cron on the project, no caller anywhere in the repo. PROD carried
-- pending_payment registrations 4–29 days old, two of them the unpaid half of a
-- team whose partner had paid. The edge function as written would also have
-- soft-deleted those rows WITHOUT unpairing the partner (leaving a paid player
-- pointing at a deleted registration) and WITHOUT promoting the next waitlisted
-- player into the freed spot.
--
-- What ships here:
--   • pg_cron enabled (available on Supabase; was never created here).
--   • sweep_stale_pending_regs(p_hold_minutes) — ONE implementation, in SQL:
--       soft-deletes pending_payment regs idle longer than the hold window
--       (never admin-invoiced ones), cancels their outbound partner invites,
--       UNPAIRS their partner (→ seeking, mirrors withdraw_self), and calls
--       promote_from_waitlist once per freed spot. Returns the counts + the
--       promoted reg ids so a caller can notify (auto-promotions are not
--       emailed today — same as withdraw_self; see the story).
--   • cron job 'sweep-stale-pending-regs' every 5 minutes → that function.
--     The edge function now calls the same RPC, so a manual run == the job.
--
-- Change the hold window without a deploy (default 30 min):
--   select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'sweep-stale-pending-regs'),
--                         command := 'select public.sweep_stale_pending_regs(120)');
-- Pause it:  select cron.alter_job((select jobid from cron.job where jobname='sweep-stale-pending-regs'), active := false);
-- History:   select * from cron.job_run_details order by start_time desc limit 20;
--
-- ⚠️ First run on PROD will sweep every pending_payment row older than the
-- window that is not admin-invoiced. Reconcile any you want to keep (admin
-- Manage → record payment, or set admin_invoiced_at) BEFORE merging.

set search_path = public;

-- ── 1. pg_cron ────────────────────────────────────────────────────────────────
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;

-- ── 2. The sweep, in SQL ──────────────────────────────────────────────────────
create or replace function public.sweep_stale_pending_regs(p_hold_minutes integer default 30)
returns table (
  cancelled_regs    integer,
  cancelled_invites integer,
  unpaired_partners integer,
  promoted          integer,
  promoted_reg_ids  uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minutes  integer := greatest(coalesce(p_hold_minutes, 30), 1);
  v_cutoff   timestamptz := now() - make_interval(mins => v_minutes);
  v_regs     integer := 0;
  v_invites  integer := 0;
  v_unpaired integer := 0;
  v_promoted uuid[] := '{}';
  v_promo    uuid;
  v_n        integer;
  r          record;
begin
  for r in
    select er.id, er.event_id, er.player_id, er.partner_registration_id
      from event_registrations er
     where er.status = 'pending_payment'
       and er.deleted_at is null
       -- Admin "register-with-balance" invoices are intentional; they persist
       -- until the player pays online (20260803000000). Never sweep them.
       and er.admin_invoiced_at is null
       -- updated_at, not registered_at: a row touched recently (checkout
       -- opened, partner edited) gets a fresh window.
       and er.updated_at < v_cutoff
     order by er.updated_at
       for update skip locked
  loop
    -- Soft-delete (same semantic the edge function used: status stays
    -- pending_payment, deleted_at set). Drop the partner link on our side.
    update event_registrations
       set deleted_at              = now(),
           partner_registration_id = null
     where id = r.id
       and deleted_at is null;
    if not found then continue; end if;
    v_regs := v_regs + 1;

    -- Unpair the partner (mirrors withdraw_self): they keep their spot and
    -- go back to seeking, instead of pointing at a deleted registration.
    update event_registrations
       set partner_registration_id = null,
           partner_status          = 'seeking',
           updated_at              = now()
     where partner_registration_id = r.id
       and deleted_at is null;
    get diagnostics v_n = row_count;
    v_unpaired := v_unpaired + v_n;

    -- Orphaned outbound invites confuse the invitee — cancel them.
    update partner_invites
       set status = 'cancelled'
     where event_id          = r.event_id
       and inviter_player_id = r.player_id
       and status            = 'pending';
    get diagnostics v_n = row_count;
    v_invites := v_invites + v_n;

    -- The freed spot goes to the next waitlisted player (no-op if nobody is
    -- waiting). promote_from_waitlist carries a confirmed partner along.
    v_promo := null;
    select p.promoted_reg_id into v_promo from promote_from_waitlist(r.event_id) p;
    if v_promo is not null then
      v_promoted := v_promoted || v_promo;
    end if;
  end loop;

  cancelled_regs    := v_regs;
  cancelled_invites := v_invites;
  unpaired_partners := v_unpaired;
  promoted          := coalesce(array_length(v_promoted, 1), 0);
  promoted_reg_ids  := v_promoted;
  return next;
end;
$$;

comment on function public.sweep_stale_pending_regs(integer) is
  'Soft-deletes pending_payment registrations idle longer than p_hold_minutes '
  '(default 30; never admin-invoiced ones), cancels their outbound partner invites, '
  'unpairs their partner (→ seeking) and promotes the next waitlisted player per '
  'freed spot. Idempotent. Run by the pg_cron job ''sweep-stale-pending-regs'' and by '
  'the sweep-stale-pending-regs edge function. SECURITY DEFINER, service_role/postgres only.';

revoke all on function public.sweep_stale_pending_regs(integer) from public, anon, authenticated;
grant execute on function public.sweep_stale_pending_regs(integer) to service_role;

-- ── 3. Schedule: every 5 minutes ──────────────────────────────────────────────
-- Idempotent: drop any previous job of the same name before scheduling.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'sweep-stale-pending-regs';
end;
$$;

select cron.schedule(
  'sweep-stale-pending-regs',
  '*/5 * * * *',
  $$select public.sweep_stale_pending_regs(30)$$
);
