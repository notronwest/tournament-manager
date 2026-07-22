-- ─────────────────────────────────────────────────────────────────────
-- organization_contacts — an org's marketing/contact list.
--
-- Person data (name/email/phone) stays in the shared global `players`
-- table (locked decision #2 — one row per human, shared across orgs).
-- This table only records the org↔player LINK for people who are NOT
-- otherwise reachable as registrants: imported contacts and manual adds.
--
-- The full contact list an org sees/emails is computed at read time as
--   (rows here)  ∪  (distinct players who registered for the org's tournaments)
-- so existing registrants are never duplicated here and never go stale.
--
-- Also adds organizations.resend_audience_id — the org's Resend Audience,
-- created lazily by the send-contact-broadcast edge function on first send.
-- ─────────────────────────────────────────────────────────────────────

-- Resend Audience id, created lazily on first broadcast. Nullable = not yet created.
alter table organizations
  add column if not exists resend_audience_id text;

create table organization_contacts (
  organization_id   uuid not null references organizations(id) on delete cascade,
  player_id         uuid not null references players(id) on delete cascade,
  -- how this person landed on the list: 'import' (CSV/XLSX) or 'manual' (typed in).
  -- Registrants are NOT stored here — they're derived from `registrations`.
  source            text not null default 'import'
                      check (source in ('import', 'manual')),
  -- org-level opt-out (mirrors Resend's unsubscribe state); NULL = subscribed.
  unsubscribed_at   timestamptz,
  -- the contact's id inside the org's Resend Audience, once synced.
  resend_contact_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (organization_id, player_id)
);

-- Active-list lookups scoped to one org.
create index organization_contacts_org_idx
  on organization_contacts (organization_id)
  where deleted_at is null;
-- Reverse lookup (which orgs list this player) + FK support.
create index organization_contacts_player_idx
  on organization_contacts (player_id);

create trigger organization_contacts_updated_at
  before update on organization_contacts
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────
-- RLS — org members only (no public read). Reuses is_org_member().
-- ─────────────────────────────────────────────────────────────────────
alter table organization_contacts enable row level security;

create policy "org_contacts read by org members" on organization_contacts
  for select using (is_org_member(organization_id));

create policy "org_contacts write by org members" on organization_contacts
  for all using (is_org_member(organization_id))
         with check (is_org_member(organization_id));
