-- 20260722130000_contact_broadcast_tracking.sql
--
-- Delivery tracking for contact-list emails (org "email your list" feature).
--
--   contact_broadcasts            — one row per SEND (subject/body/when/who).
--   contact_broadcast_recipients  — one row per recipient per send, correlated
--                                   to Resend by resend_email_id.
--
-- All contact email now goes via Resend's batch-send API (one email id per
-- recipient), so every recipient is individually trackable — powering both the
-- recipient-filtering send and the delivery status page.
--
-- Per-recipient delivery is stored as EVENT TIMESTAMPS (delivered_at / opened_at
-- / …), set once by the resend-webhook function. Status-page counts derive from
-- these by aggregation, so there is no rollup counter to race on under
-- at-least-once webhook delivery. `status` mirrors the furthest state reached,
-- for convenient per-recipient display.
--
-- Writes are SERVER-ONLY (the send + webhook + unsubscribe functions use
-- service_role); org members get read access for the status page.

set search_path = public;

-- ── One row per send ────────────────────────────────────────────────
create table contact_broadcasts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  subject         text not null,
  body            text not null,               -- plain text as sent
  recipient_count integer not null default 0,
  sent_by         uuid,                         -- auth.users id of sender (nullable)
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index contact_broadcasts_org_idx
  on contact_broadcasts (organization_id, sent_at desc);

-- ── One row per recipient per send ──────────────────────────────────
create table contact_broadcast_recipients (
  id               uuid primary key default gen_random_uuid(),
  broadcast_id     uuid not null references contact_broadcasts(id) on delete cascade,
  -- Nullable: keep the tracking row even if the player is later removed.
  player_id        uuid references players(id) on delete set null,
  email            text not null,
  -- Resend's email id, captured at batch-send time; the webhook correlates
  -- inbound delivery events back to this row by it.
  resend_email_id  text,
  -- Furthest state reached, for per-recipient display.
  status           text not null default 'sent'
                     check (status in ('sent','delivered','opened','clicked',
                                       'bounced','complained','delivery_delayed')),
  -- Per-event timestamps (null until the event); status-page counts derive
  -- from these, so there is no rollup to race on.
  sent_at          timestamptz not null default now(),
  delivered_at     timestamptz,
  opened_at        timestamptz,
  clicked_at       timestamptz,
  bounced_at       timestamptz,
  complained_at    timestamptz,
  unsubscribed_at  timestamptz,
  last_event_at    timestamptz,
  created_at       timestamptz not null default now()
);

create index contact_broadcast_recipients_broadcast_idx
  on contact_broadcast_recipients (broadcast_id);
-- Webhook lookup key; partial so multiple NULLs (pre-send) don't collide.
create unique index contact_broadcast_recipients_resend_email_idx
  on contact_broadcast_recipients (resend_email_id)
  where resend_email_id is not null;

-- ── RLS: org members read; writes server-only ───────────────────────
alter table contact_broadcasts enable row level security;
alter table contact_broadcast_recipients enable row level security;

create policy "contact_broadcasts read by org members" on contact_broadcasts
  for select using (is_org_member(organization_id));

create policy "contact_broadcast_recipients read by org members"
  on contact_broadcast_recipients
  for select using (
    exists (
      select 1 from contact_broadcasts b
      where b.id = contact_broadcast_recipients.broadcast_id
        and is_org_member(b.organization_id)
    )
  );

create trigger contact_broadcasts_updated_at
  before update on contact_broadcasts
  for each row execute function public.set_updated_at();
