-- 20260504200000_delete_policies.sql
-- Fills in the missing DELETE policies on event_registrations,
-- registrations, and partner_invites. The init migration defined
-- separate FOR SELECT / FOR INSERT / FOR UPDATE policies on these
-- tables but no FOR DELETE — and Postgres RLS denies anything that
-- isn't explicitly permitted. supabase-js returns {error: null,
-- data: []} on a fully-RLS-filtered DELETE, so the failure was
-- silent: the Remove-team flow appeared to succeed while leaving
-- the rows in place, just with their partner FKs cleared (UPDATE
-- worked, DELETE didn't).
--
-- Mirrors the existing UPDATE policies — same caller surface
-- (player on their own row, or org staff on any row in the event's
-- org).

set search_path = public;

create policy "event_regs delete by player or org staff" on event_registrations
  for delete using (
    player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = event_registrations.event_id
        and has_org_role(t.organization_id, 'staff')
    )
  );

create policy "registrations delete by player or org staff" on registrations
  for delete using (
    player_id = current_player_id()
    or exists (
      select 1 from tournaments t
      where t.id = registrations.tournament_id
        and has_org_role(t.organization_id, 'staff')
    )
  );

create policy "invites delete by sender, recipient, or org" on partner_invites
  for delete using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
    or exists (
      select 1 from events e
      join tournaments t on t.id = e.tournament_id
      where e.id = partner_invites.event_id
        and is_org_member(t.organization_id)
    )
  );
