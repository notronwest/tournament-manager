-- ─────────────────────────────────────────────────────────────────────
-- merge_players — fold a duplicate player record (LOSER) into a kept one
-- (WINNER): re-point every table that references the loser to the winner,
-- resolve the unique-constraint collisions, detach the loser's login, backfill
-- the winner's blank fields, then soft-delete the loser.
--
-- Two functions:
--   merge_players_preview(winner, loser)  — read-only dry run: counts + conflicts.
--   merge_players(winner, loser)          — commits the merge in ONE transaction.
--
-- Both are SECURITY DEFINER and granted to service_role ONLY — the merge is a
-- platform-admin operation driven by the admin-merge-players edge function (which
-- authorizes against platform_admins and writes audit_log). They are NOT callable
-- from a client JWT.
--
-- Tables that reference players(id) and are re-pointed (loser → winner):
--   player_ratings, registrations, event_registrations, partner_invites
--   (inviter + invitee), payments, manual_payments, tournament_change_requests,
--   organization_contacts, contact_broadcast_recipients.
--
-- Collisions handled:
--   * event_registrations active-unique (event_id, player_id): both actively
--     registered for the same event → keep the winner's, soft-delete the loser's
--     dup (and unpair the loser's partner → 'seeking').
--   * registrations unique (tournament_id, player_id) [FULL, counts soft-deleted]:
--     collision → delete the loser's (this table is vestigial in the live flow).
--   * organization_contacts PK (organization_id, player_id): collision → keep the
--     winner's link, delete the loser's.
--   * partner_invites CHECK (inviter <> invitee): an invite between the two →
--     delete it (can't self-invite after the merge).
--   * winner & loser were doubles partners with each other → the pairing is broken
--     (partner_status → 'seeking').
--   * auth_user_id is UNIQUE and is NOT freed by soft-delete → the loser's is
--     always nulled; the winner ends up with its own account, or inherits the
--     loser's if the winner had none.
-- ─────────────────────────────────────────────────────────────────────

set search_path = public, extensions;

-- ── Preview: read-only. What WOULD move, and the conflicts. ──────────────
create or replace function merge_players_preview(p_winner uuid, p_loser uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_winner players%rowtype;
  v_loser  players%rowtype;
  v_result jsonb;
begin
  if p_winner = p_loser then
    raise exception 'winner and loser must differ';
  end if;
  select * into v_winner from players where id = p_winner;
  if not found then raise exception 'winner not found'; end if;
  select * into v_loser  from players where id = p_loser;
  if not found then raise exception 'loser not found'; end if;

  select jsonb_build_object(
    'winner', jsonb_build_object(
      'id', v_winner.id, 'first_name', v_winner.first_name, 'last_name', v_winner.last_name,
      'email', v_winner.email, 'has_account', v_winner.auth_user_id is not null,
      'deleted', v_winner.deleted_at is not null
    ),
    'loser', jsonb_build_object(
      'id', v_loser.id, 'first_name', v_loser.first_name, 'last_name', v_loser.last_name,
      'email', v_loser.email, 'has_account', v_loser.auth_user_id is not null,
      'deleted', v_loser.deleted_at is not null
    ),
    'moves', jsonb_build_object(
      'player_ratings',              (select count(*) from player_ratings where player_id = p_loser),
      'registrations',               (select count(*) from registrations where player_id = p_loser),
      'event_registrations',         (select count(*) from event_registrations where player_id = p_loser and deleted_at is null),
      'partner_invites',             (select count(*) from partner_invites where inviter_player_id = p_loser or invitee_player_id = p_loser),
      'payments',                    (select count(*) from payments where player_id = p_loser),
      'manual_payments',             (select count(*) from manual_payments where player_id = p_loser),
      'tournament_change_requests',  (select count(*) from tournament_change_requests where player_id = p_loser),
      'organization_contacts',       (select count(*) from organization_contacts where player_id = p_loser and deleted_at is null),
      'contact_broadcast_recipients',(select count(*) from contact_broadcast_recipients where player_id = p_loser)
    ),
    'conflicts', jsonb_build_object(
      'both_have_accounts', (v_winner.auth_user_id is not null and v_loser.auth_user_id is not null),
      -- Both actively registered for the SAME event (loser's dup will be dropped).
      'same_event_registrations', coalesce((
        select jsonb_agg(jsonb_build_object('event_id', e.id, 'event_name', e.name, 'tournament', t.name))
        from event_registrations lr
        join events e on e.id = lr.event_id
        join tournaments t on t.id = e.tournament_id
        where lr.player_id = p_loser and lr.deleted_at is null and lr.status in ('pending_payment','paid')
          and exists (
            select 1 from event_registrations wr
            where wr.player_id = p_winner and wr.event_id = lr.event_id
              and wr.deleted_at is null and wr.status in ('pending_payment','paid')
          )
      ), '[]'::jsonb),
      -- Same tournament-level registration (loser's dropped).
      'same_tournament_registrations', coalesce((
        select jsonb_agg(jsonb_build_object('tournament', t.name))
        from registrations lr
        join tournaments t on t.id = lr.tournament_id
        where lr.player_id = p_loser
          and exists (select 1 from registrations wr where wr.player_id = p_winner and wr.tournament_id = lr.tournament_id)
      ), '[]'::jsonb),
      -- Both contacts of the same org (loser's link dropped, winner's kept).
      'same_org_contacts', coalesce((
        select jsonb_agg(jsonb_build_object('organization', o.name))
        from organization_contacts lc
        join organizations o on o.id = lc.organization_id
        where lc.player_id = p_loser
          and exists (select 1 from organization_contacts wc where wc.player_id = p_winner and wc.organization_id = lc.organization_id)
      ), '[]'::jsonb),
      -- Invites directly between the two (deleted on merge).
      'invites_between_them', (
        select count(*) from partner_invites
        where (inviter_player_id = p_loser and invitee_player_id = p_winner)
           or (inviter_player_id = p_winner and invitee_player_id = p_loser)
      ),
      -- They were doubles partners with each other (pairing broken).
      'partners_with_each_other', coalesce((
        select jsonb_agg(distinct jsonb_build_object('event_id', e.id, 'event_name', e.name))
        from event_registrations lr
        join event_registrations wr on wr.id = lr.partner_registration_id
        join events e on e.id = lr.event_id
        where lr.player_id = p_loser and wr.player_id = p_winner and lr.deleted_at is null
      ), '[]'::jsonb)
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ── Commit: the transactional merge. ────────────────────────────────────
create or replace function merge_players(p_winner uuid, p_loser uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_winner players%rowtype;
  v_loser  players%rowtype;
  v_lr      record;
  v_moved   jsonb;
  v_dropped_event_regs int := 0;
begin
  if p_winner = p_loser then
    raise exception 'winner and loser must differ';
  end if;
  -- Lock both rows for the duration of the transaction.
  select * into v_winner from players where id = p_winner for update;
  if not found then raise exception 'winner not found'; end if;
  select * into v_loser  from players where id = p_loser for update;
  if not found then raise exception 'loser not found'; end if;
  if v_loser.deleted_at is not null then
    raise exception 'loser is already deleted';
  end if;

  -- ── event_registrations: re-point where no active collision; else drop
  --    the loser's dup and unpair its partner. Handle non-active rows too. ──
  for v_lr in
    select * from event_registrations where player_id = p_loser
  loop
    if v_lr.deleted_at is null
       and v_lr.status in ('pending_payment','paid')
       and exists (
         select 1 from event_registrations wr
         where wr.player_id = p_winner and wr.event_id = v_lr.event_id
           and wr.deleted_at is null and wr.status in ('pending_payment','paid')
       )
    then
      -- Collision: keep the winner's, drop the loser's dup. First unpair the
      -- loser's partner (if any) so no reg is left pointing at a dead row.
      if v_lr.partner_registration_id is not null then
        update event_registrations
          set partner_registration_id = null, partner_status = 'seeking', updated_at = now()
          where id = v_lr.partner_registration_id;
      end if;
      update event_registrations
        set deleted_at = now(), partner_registration_id = null, updated_at = now()
        where id = v_lr.id;
      v_dropped_event_regs := v_dropped_event_regs + 1;
    else
      -- Safe to re-point. If this reg is partnered with the WINNER'S own reg
      -- (the two were partners with each other), break the pairing instead of
      -- letting the winner become their own partner.
      if v_lr.partner_registration_id is not null
         and exists (select 1 from event_registrations wr
                     where wr.id = v_lr.partner_registration_id and wr.player_id = p_winner)
      then
        update event_registrations
          set partner_registration_id = null, partner_status = 'seeking', updated_at = now()
          where id = v_lr.partner_registration_id;
        update event_registrations
          set player_id = p_winner, partner_registration_id = null, partner_status = 'seeking', updated_at = now()
          where id = v_lr.id;
      else
        update event_registrations
          set player_id = p_winner, updated_at = now()
          where id = v_lr.id;
      end if;
    end if;
  end loop;

  -- ── registrations (tournament-level, vestigial; FULL unique): re-point,
  --    dropping the loser's row where the winner already has one. ──
  delete from registrations lr
    where lr.player_id = p_loser
      and exists (select 1 from registrations wr where wr.player_id = p_winner and wr.tournament_id = lr.tournament_id);
  update registrations set player_id = p_winner, updated_at = now() where player_id = p_loser;

  -- ── organization_contacts (PK org,player): keep winner's link on collision. ──
  delete from organization_contacts lc
    where lc.player_id = p_loser
      and exists (select 1 from organization_contacts wc where wc.player_id = p_winner and wc.organization_id = lc.organization_id);
  update organization_contacts set player_id = p_winner, updated_at = now() where player_id = p_loser;

  -- ── partner_invites: delete invites between the two (CHECK inviter<>invitee),
  --    then re-point the rest. ──
  delete from partner_invites
    where (inviter_player_id = p_loser and invitee_player_id = p_winner)
       or (inviter_player_id = p_winner and invitee_player_id = p_loser);
  update partner_invites set inviter_player_id = p_winner where inviter_player_id = p_loser;
  update partner_invites set invitee_player_id = p_winner where invitee_player_id = p_loser;

  -- ── Straight re-points (no unique collisions). ──
  update player_ratings                set player_id = p_winner where player_id = p_loser;
  update payments                      set player_id = p_winner where player_id = p_loser;
  update manual_payments               set player_id = p_winner where player_id = p_loser;
  update tournament_change_requests    set player_id = p_winner where player_id = p_loser;
  update contact_broadcast_recipients  set player_id = p_winner where player_id = p_loser;

  -- ── Identity: move the login only if the winner has none; always detach the
  --    loser's (auth_user_id UNIQUE is not freed by soft-delete, and
  --    current_player_id() ignores deleted_at). ──
  if v_winner.auth_user_id is null and v_loser.auth_user_id is not null then
    update players set auth_user_id = null where id = p_loser;      -- free the unique slot first
    update players set auth_user_id = v_loser.auth_user_id, updated_at = now() where id = p_winner;
  else
    update players set auth_user_id = null where id = p_loser;
  end if;

  -- ── Backfill the winner's BLANK fields from the loser (never overwrite). ──
  update players w set
    email                = coalesce(w.email, v_loser.email),
    phone                = coalesce(w.phone, v_loser.phone),
    dob                  = coalesce(w.dob, v_loser.dob),
    gender               = coalesce(w.gender, v_loser.gender),
    city                 = coalesce(w.city, v_loser.city),
    state                = coalesce(w.state, v_loser.state),
    self_rating_doubles  = coalesce(w.self_rating_doubles, v_loser.self_rating_doubles),
    self_rating_mixed    = coalesce(w.self_rating_mixed, v_loser.self_rating_mixed),
    self_rating_singles  = coalesce(w.self_rating_singles, v_loser.self_rating_singles),
    avatar_path          = coalesce(w.avatar_path, v_loser.avatar_path),
    updated_at           = now()
  where w.id = p_winner;

  -- ── Soft-delete the loser. ──
  update players set deleted_at = now(), updated_at = now() where id = p_loser;

  v_moved := jsonb_build_object(
    'winner_id', p_winner,
    'loser_id', p_loser,
    'dropped_duplicate_event_registrations', v_dropped_event_regs
  );
  return v_moved;
end;
$$;

revoke all on function merge_players_preview(uuid, uuid) from public, anon, authenticated;
revoke all on function merge_players(uuid, uuid)         from public, anon, authenticated;
grant execute on function merge_players_preview(uuid, uuid) to service_role;
grant execute on function merge_players(uuid, uuid)         to service_role;
