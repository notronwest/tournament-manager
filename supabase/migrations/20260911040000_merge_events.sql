-- 20260911040000_merge_events.sql
--
-- Merge one event into another: every registration in the SOURCE event moves
-- to the TARGET event in one transaction, teams stay paired, the target can be
-- renamed in the same step, and the source is soft-deleted. The desk case is
-- two thin brackets ("Mixed 3.0" with 3 teams, "Mixed 3.5" with 4) becoming
-- one playable one ("Mixed 3.0/3.5").
--
-- Two functions, both SECURITY DEFINER with an explicit org-role check on the
-- events' tournament (so callers cannot merge across tournaments or without
-- staff/admin rights):
--
--   merge_events_preview(source, target) → json   (org STAFF)
--     What would happen: registration / player counts, fee and gender
--     mismatches, and the players who hold an ACTIVE (paid / pending_payment)
--     registration in BOTH events. Those block the merge — the active-unique
--     index (event_id, player_id) would reject the move, and silently dropping
--     a paid registration is never right — so the organizer resolves them
--     first with the registration editor.
--
--   merge_events(source, target, new_name) → json   (org ADMIN)
--     Performs the merge. Rules:
--       * same tournament, same format (singles ↔ doubles never merge), both
--         un-deleted, neither with any matches yet (once a bracket has been
--         drawn, merging it is a different, destructive operation).
--       * blocking conflicts (as above) → raises 'player_conflict'.
--       * a player WAITLISTED in the source who already has any live row in the
--         target keeps the target row; the source waitlist row is cancelled.
--       * remaining source waitlist rows are appended after the target's
--         queue, keeping their relative order.
--       * every other non-deleted source registration moves as-is (status,
--         fee, partner link untouched — money is deliberately not re-priced,
--         same as moving a single registration).
--       * pending partner invites follow to the target event.
--       * the source's court assignments are dropped; the target keeps its own.
--       * target renamed when new_name is non-blank.
--       * source soft-deleted (deleted_at = now()).
--
-- Additive only: no table changes.

set search_path = public;

create or replace function public.merge_events_preview(
  p_source_event_id uuid,
  p_target_event_id uuid
)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_src  events%rowtype;
  v_tgt  events%rowtype;
  v_org  uuid;
  v_out  json;
begin
  if p_source_event_id = p_target_event_id then
    raise exception 'same_event';
  end if;

  select * into v_src from events where id = p_source_event_id and deleted_at is null;
  if not found then raise exception 'source_not_found'; end if;
  select * into v_tgt from events where id = p_target_event_id and deleted_at is null;
  if not found then raise exception 'target_not_found'; end if;
  if v_src.tournament_id <> v_tgt.tournament_id then
    raise exception 'different_tournaments';
  end if;

  select organization_id into v_org from tournaments where id = v_src.tournament_id;
  if not has_org_role(v_org, 'staff') then
    raise exception 'forbidden';
  end if;

  select json_build_object(
    'source', json_build_object(
      'id', v_src.id, 'name', v_src.name, 'format', v_src.format, 'gender', v_src.gender,
      'fee_cents', v_src.event_fee_cents, 'status', v_src.status,
      'registrations', (select count(*) from event_registrations
                          where event_id = v_src.id and deleted_at is null
                            and status in ('paid', 'pending_payment')),
      'waitlisted', (select count(*) from event_registrations
                       where event_id = v_src.id and deleted_at is null
                         and status in ('waitlisted', 'waitlisted_pending_payment')),
      'matches', (select count(*) from matches where event_id = v_src.id)
    ),
    'target', json_build_object(
      'id', v_tgt.id, 'name', v_tgt.name, 'format', v_tgt.format, 'gender', v_tgt.gender,
      'fee_cents', v_tgt.event_fee_cents, 'status', v_tgt.status, 'max_teams', v_tgt.max_teams,
      'registrations', (select count(*) from event_registrations
                          where event_id = v_tgt.id and deleted_at is null
                            and status in ('paid', 'pending_payment')),
      'waitlisted', (select count(*) from event_registrations
                       where event_id = v_tgt.id and deleted_at is null
                         and status in ('waitlisted', 'waitlisted_pending_payment')),
      'matches', (select count(*) from matches where event_id = v_tgt.id)
    ),
    'same_format', v_src.format = v_tgt.format,
    'same_gender', v_src.gender = v_tgt.gender,
    'same_fee',    v_src.event_fee_cents = v_tgt.event_fee_cents,
    -- Players actively registered in BOTH events — these block the merge.
    'conflicts', coalesce((
      select json_agg(json_build_object(
               'player_id', p.id,
               'name', trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
             ) order by p.last_name, p.first_name)
        from players p
       where exists (select 1 from event_registrations s
                      where s.event_id = v_src.id and s.player_id = p.id
                        and s.deleted_at is null and s.status in ('paid', 'pending_payment'))
         and exists (select 1 from event_registrations t
                      where t.event_id = v_tgt.id and t.player_id = p.id
                        and t.deleted_at is null and t.status in ('paid', 'pending_payment'))
    ), '[]'::json)
  ) into v_out;

  return v_out;
end;
$$;

comment on function public.merge_events_preview(uuid, uuid) is
  'Dry run for merge_events: counts, mismatches, and the players actively '
  'registered in both events (which block the merge). Org staff only.';

grant execute on function public.merge_events_preview(uuid, uuid) to authenticated;


create or replace function public.merge_events(
  p_source_event_id uuid,
  p_target_event_id uuid,
  p_new_name        text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src        events%rowtype;
  v_tgt        events%rowtype;
  v_org        uuid;
  v_conflicts  text;
  v_tgt_maxpos integer;
  v_moved      integer := 0;
  v_cancelled  integer := 0;
  v_invites    integer := 0;
  v_players    integer := 0;
  v_name       text;
begin
  if p_source_event_id = p_target_event_id then
    raise exception 'same_event';
  end if;

  -- Lock both event rows so two admins can't merge the same pair twice.
  select * into v_src from events where id = p_source_event_id and deleted_at is null for update;
  if not found then raise exception 'source_not_found'; end if;
  select * into v_tgt from events where id = p_target_event_id and deleted_at is null for update;
  if not found then raise exception 'target_not_found'; end if;
  if v_src.tournament_id <> v_tgt.tournament_id then
    raise exception 'different_tournaments';
  end if;
  if v_src.format <> v_tgt.format then
    raise exception 'format_mismatch';
  end if;

  select organization_id into v_org from tournaments where id = v_src.tournament_id;
  if not has_org_role(v_org, 'admin') then
    raise exception 'forbidden';
  end if;

  if exists (select 1 from matches where event_id in (v_src.id, v_tgt.id)) then
    raise exception 'bracket_already_drawn';
  end if;

  -- Blocking conflicts: active in both.
  select string_agg(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ', '
                    order by p.last_name, p.first_name)
    into v_conflicts
    from players p
   where exists (select 1 from event_registrations s
                  where s.event_id = v_src.id and s.player_id = p.id
                    and s.deleted_at is null and s.status in ('paid', 'pending_payment'))
     and exists (select 1 from event_registrations t
                  where t.event_id = v_tgt.id and t.player_id = p.id
                    and t.deleted_at is null and t.status in ('paid', 'pending_payment'));
  if v_conflicts is not null then
    raise exception 'player_conflict: %', v_conflicts;
  end if;

  -- Waitlisted in the source but already live in the target → drop the
  -- source waitlist row rather than queue them for an event they're in.
  update event_registrations s
     set status = 'cancelled', waitlist_position = null, updated_at = now()
   where s.event_id = v_src.id
     and s.deleted_at is null
     and s.status in ('waitlisted', 'waitlisted_pending_payment')
     and exists (select 1 from event_registrations t
                  where t.event_id = v_tgt.id and t.player_id = s.player_id
                    and t.deleted_at is null
                    and t.status in ('paid', 'pending_payment', 'waitlisted', 'waitlisted_pending_payment'));
  get diagnostics v_cancelled = row_count;

  -- Append the source's remaining queue after the target's, in order.
  select coalesce(max(waitlist_position), 0) into v_tgt_maxpos
    from event_registrations
   where event_id = v_tgt.id and deleted_at is null and status = 'waitlisted';

  update event_registrations s
     set waitlist_position = v_tgt_maxpos + ranked.rn
    from (select id, row_number() over (order by waitlist_position asc nulls last, registered_at asc) as rn
            from event_registrations
           where event_id = v_src.id and deleted_at is null and status = 'waitlisted') ranked
   where s.id = ranked.id;

  -- Distinct players about to move (for the summary).
  select count(distinct player_id) into v_players
    from event_registrations
   where event_id = v_src.id and deleted_at is null
     and status in ('paid', 'pending_payment', 'waitlisted', 'waitlisted_pending_payment');

  -- Move every non-deleted source registration. Partner links point at rows
  -- that move in the same statement, so teams stay intact.
  update event_registrations
     set event_id = v_tgt.id, updated_at = now()
   where event_id = v_src.id and deleted_at is null;
  get diagnostics v_moved = row_count;

  -- Pending partner invites follow.
  update partner_invites
     set event_id = v_tgt.id
   where event_id = v_src.id;
  get diagnostics v_invites = row_count;

  -- The source's court assignments are meaningless once it has no teams.
  delete from event_courts where event_id = v_src.id;

  -- Rename the surviving event if asked.
  v_name := nullif(trim(coalesce(p_new_name, '')), '');
  if v_name is not null and v_name <> v_tgt.name then
    update events set name = v_name, updated_at = now() where id = v_tgt.id;
  end if;

  -- Retire the source.
  update events set deleted_at = now(), updated_at = now() where id = v_src.id;

  return json_build_object(
    'target_event_id', v_tgt.id,
    'target_name', coalesce(v_name, v_tgt.name),
    'source_event_id', v_src.id,
    'moved_registrations', v_moved,
    'moved_players', v_players,
    'cancelled_duplicate_waitlist', v_cancelled,
    'moved_invites', v_invites
  );
end;
$$;

comment on function public.merge_events(uuid, uuid, text) is
  'Moves every registration from the source event into the target (teams stay '
  'paired, waitlist appended, invites follow), optionally renames the target, '
  'and soft-deletes the source — atomically. Refuses different tournaments, '
  'different formats, events with matches, and players active in both. Org admin only.';

grant execute on function public.merge_events(uuid, uuid, text) to authenticated;
