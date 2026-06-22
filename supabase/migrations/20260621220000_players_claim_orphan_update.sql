-- 20260621220000_players_claim_orphan_update.sql
--
-- Fix: a signed-in user could not save their profile when their player
-- record was an organizer-pre-created ORPHAN (auth_user_id IS NULL). The
-- "claim" path in ProfilePage/RegisterPage does
--   update players set auth_user_id = <me>, ... where id = <orphan> ... returning *
-- but the UPDATE policy's USING clause checked `auth_user_id = auth.uid()`
-- against the OLD row value (NULL), so RLS matched 0 rows. PostgREST's
-- `.single()` then surfaced "Cannot coerce the result to a single JSON
-- object" and the save failed.
--
-- This adds an explicit claim branch: an authenticated user may update an
-- unlinked player row IF that row's email matches their own authenticated
-- (JWT) email. The email match is the proof of ownership — the user already
-- authenticated with that address (verified by Supabase / the OAuth
-- provider), so linking the pre-created record to them is safe.
--
-- WITH CHECK is left implicit (Postgres uses USING as the post-update check),
-- which keeps the existing semantics AND blocks abuse: after a claim the row
-- has auth_user_id = auth.uid() (first branch passes); an attempt to set it
-- to SOMEONE ELSE'S uid fails every branch (not self, not a null orphan, not
-- org staff), so a claimer cannot reassign a record away to another account.
--
-- Self-edits (auth_user_id already = uid) and org-staff edits are unchanged.

set search_path = public;

drop policy if exists "players update by self or related org" on players;

create policy "players update by self or related org" on players
  for update using (
    -- the player's own linked record
    auth_user_id = auth.uid()
    -- claim: an unlinked record whose email is the caller's own
    or (
      auth_user_id is null
      and email is not null
      and lower(email) = lower(nullif(auth.jwt() ->> 'email', ''))
    )
    -- org staff managing a registrant in one of their tournaments
    or exists (
      select 1 from event_registrations er
      join events e on e.id = er.event_id
      join tournaments t on t.id = e.tournament_id
      where er.player_id = players.id
        and is_org_member(t.organization_id)
    )
  );
