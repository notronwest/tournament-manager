-- 20260619140000_custom_domains.sql
--
-- Custom domains → tournament (issue #408, bespoke first instance).
-- Maps an organizer-owned hostname (e.g. pickleballangels.com) to the
-- tournament it should serve at its root. The frontend reads this at page
-- load (anon, before any auth) to resolve which tournament a custom host
-- renders. The actual TLS/hostname wiring is done in Cloudflare (Pages
-- custom domain) out-of-band; this table is just the routing map.
--
-- v1 is bespoke: one row, seeded here. The self-serve version (#408) adds
-- org-admin writes + Cloudflare-for-SaaS hostname provisioning later.

set search_path = public;

create table if not exists public.custom_domains (
  host          text primary key,
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  created_at    timestamptz not null default now()
);

comment on table public.custom_domains is
  'Maps a custom hostname to the tournament it serves at root (issue #408). Publicly readable (needed at page load, pre-auth); not sensitive. Writes are server-only for now (seeded by migration); self-serve org-admin writes come with the full feature.';

create index if not exists custom_domains_tournament_idx
  on public.custom_domains (tournament_id);

-- RLS ----------------------------------------------------------------
alter table public.custom_domains enable row level security;

-- Public read: the host→tournament mapping must resolve for anonymous
-- visitors landing on a custom domain. It exposes nothing sensitive (a
-- hostname and the tournament it points to — both already public).
create policy "custom_domains public read" on public.custom_domains
  for select using (true);

-- No INSERT/UPDATE/DELETE policy — writes go through service_role only
-- (seeded here; admin self-serve writes are a follow-up).

-- ── Seed: pickleballangels.com → pickleball-angels / seacoast ────────
-- Resolved by slug so we don't hard-code UUIDs. A no-op on any database
-- where that tournament doesn't exist (e.g. TEST), so it's safe everywhere.
insert into public.custom_domains (host, tournament_id)
select 'pickleballangels.com', t.id
from public.tournaments t
join public.organizations o on o.id = t.organization_id
where o.slug = 'pickleball-angels'
  and t.slug = 'seacoast'
  and t.deleted_at is null
on conflict (host) do nothing;
