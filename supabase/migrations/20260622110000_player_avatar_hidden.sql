-- 20260622110000_player_avatar_hidden.sql
--
-- Moderation lever: let a platform admin HIDE a player's profile image
-- (e.g. someone uploads something cheeky) without deleting it. Reversible.
--
--   1. players.avatar_hidden — NEW boolean, default false. When true, any
--      avatar display surface should fall back to the initials placeholder
--      (treat avatar_path as null for OTHER viewers). The image file is kept
--      so an admin can review it and un-hide later.
--   2. A guard trigger so the flag is a real moderation control: only the
--      service_role (i.e. the admin-update-player edge function) may change
--      avatar_hidden. A player editing their own row via RLS cannot flip it
--      back to false. Normal profile saves don't touch the column, so they're
--      unaffected (old = new → trigger no-ops).
--
-- Additive; no RLS policy change (reads stay public; admin writes go through
-- service_role which bypasses RLS but still runs this trigger).

set search_path = public;

-- ── 1. column ─────────────────────────────────────────────────────────
alter table public.players
  add column if not exists avatar_hidden boolean not null default false;

comment on column public.players.avatar_hidden is
  'Admin moderation flag. true = hide this player''s avatar from other '
  'viewers (UI shows the initials placeholder); the avatar_path file is '
  'preserved so it can be reviewed / un-hidden. Only the service_role may '
  'change this (see guard_avatar_hidden trigger).';

-- ── 2. guard: only service_role may change avatar_hidden ──────────────
create or replace function public.guard_avatar_hidden()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.avatar_hidden is distinct from old.avatar_hidden
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception
      'avatar_hidden can only be changed by an administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_avatar_hidden on public.players;
create trigger trg_guard_avatar_hidden
  before update on public.players
  for each row
  execute function public.guard_avatar_hidden();
