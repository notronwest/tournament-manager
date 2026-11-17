-- A guardian's partner invites (#1169 follow-up).
--
-- When a parent registers a child for a doubles event, the registration is
-- written in the child's name (event_registrations already has a guardian
-- branch) and the outbound partner invite is written with the CHILD as the
-- inviter — the partner is the child's partner, not the parent's. But the
-- partner_invites policies only ever allowed `inviter_player_id =
-- current_player_id()`, so the parent's insert was refused, the child's row was
-- left at partner_status 'pending' with no invite, and checkout told the parent
-- "No partner picked" and refused to take payment.
--
-- Fix: the same `or is_guardian_of(...)` branch the guardian migration added to
-- event_registrations, on every partner_invites policy, for whichever side of
-- the invite the policy already lets a player act on. A guardian can then
-- create, read, change and withdraw invites for a child exactly as the child
-- could for themselves — never more. is_guardian_of() requires an active link
-- whose guardian is the caller's own player row.

drop policy if exists "invites insert by sender" on partner_invites;
create policy "invites insert by sender"
  on partner_invites for insert
  with check (
    inviter_player_id = current_player_id()
    or is_guardian_of(inviter_player_id)
  );

drop policy if exists "invites read by sender, recipient, or org" on partner_invites;
create policy "invites read by sender, recipient, or org"
  on partner_invites for select
  using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
    or is_guardian_of(inviter_player_id)
    or is_guardian_of(invitee_player_id)
    or exists (
      select 1
        from events e
        join tournaments t on t.id = e.tournament_id
       where e.id = partner_invites.event_id
         and is_org_member(t.organization_id)
    )
  );

drop policy if exists "invites update by sender or recipient" on partner_invites;
create policy "invites update by sender or recipient"
  on partner_invites for update
  using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
    or is_guardian_of(inviter_player_id)
    or is_guardian_of(invitee_player_id)
  );

drop policy if exists "invites delete by sender, recipient, or org" on partner_invites;
create policy "invites delete by sender, recipient, or org"
  on partner_invites for delete
  using (
    inviter_player_id = current_player_id()
    or invitee_player_id = current_player_id()
    or is_guardian_of(inviter_player_id)
    or is_guardian_of(invitee_player_id)
    or exists (
      select 1
        from events e
        join tournaments t on t.id = e.tournament_id
       where e.id = partner_invites.event_id
         and is_org_member(t.organization_id)
    )
  );
