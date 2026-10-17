-- 20261006120000_player_club_affiliations.sql
--
-- "Plays at <org>" — which players belong to an organization's home club, so
-- org-facing reports (the tournament summary) can mark home-club teams with a
-- ★. Players are a shared global table (locked decision #2), so the flag can't
-- live on `players`: membership is per organization.
--
-- One row = this player is a member of this org's club. Source today is the
-- club's CourtReserve member list (matched by email, then name); `manual` is
-- for a desk correction. No row = not known to be a member.
--
-- RLS: org members read their org's rows; admins+ write. Nothing public — the
-- public results pages don't show it.

set search_path = public;

create table if not exists public.player_club_affiliations (
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  player_id           uuid not null references public.players(id) on delete cascade,
  source              text not null default 'manual'
                        check (source in ('courtreserve', 'manual')),
  -- The club system's own id for the member (CourtReserve member id), when known.
  external_member_id  text,
  -- e.g. the CourtReserve membership type, for the desk's reference only.
  membership_label    text,
  verified_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (organization_id, player_id)
);

create index if not exists player_club_affiliations_player_idx
  on public.player_club_affiliations (player_id);

comment on table public.player_club_affiliations is
  'Players who belong to an organization''s home club (e.g. WMPC members). Drives the ★ on org reports. One row per (org, player); no row = not a known member.';

drop trigger if exists player_club_affiliations_updated_at on public.player_club_affiliations;
create trigger player_club_affiliations_updated_at
  before update on public.player_club_affiliations
  for each row execute function public.set_updated_at();

alter table public.player_club_affiliations enable row level security;

create policy "player_club_affiliations read by org members"
  on public.player_club_affiliations
  for select using (is_org_member(organization_id));

create policy "player_club_affiliations insert by org admins"
  on public.player_club_affiliations
  for insert with check (has_org_role(organization_id, 'admin'));

create policy "player_club_affiliations update by org admins"
  on public.player_club_affiliations
  for update using (has_org_role(organization_id, 'admin'))
  with check (has_org_role(organization_id, 'admin'));

create policy "player_club_affiliations delete by org admins"
  on public.player_club_affiliations
  for delete using (has_org_role(organization_id, 'admin'));
