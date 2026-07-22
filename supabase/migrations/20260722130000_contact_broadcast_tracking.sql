-- 20260722130000_contact_broadcast_tracking.sql
--
-- Delivery tracking for contact-list emails (org "email your list" feature).
-- Two tables:
--
--   contact_broadcasts             — one row per SEND (subject/body/when/who),
--                                    plus rollup counts for the status page.
--   contact_broadcast_recipients   — one row per recipient per send, correlated
--                                    to Resend by resend_email_id so the
--                                    resend-webhook function can advance each
--                                    recipient's delivery status.
--
-- All contact emails now go via Resend's batch-send API (one email id per
-- recipient), so every recipient is individually trackable — powering both the
-- recipient-filtering send and the delivery status page.
--
-- Writes are SERVER-ONLY (the send + webhook functions use service_role);
-- org members get read access for the status page. No client INSERT/UPDATE.

set search_path = public;

-- ── One row per send ────────────────────────────────────────────────
create table contact_broadcasts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  subject            text not null,
  body               text not null,               -- plain text as sent
  recipient_count    integer not null default 0,
  sent_by            uuid,                         -- auth.users id of sender (nullable)
  sent_at            timestamptz not null default now(),
  -- Delivery rollups, maintained by the resend-webhook function as events land.
  delivered_count    integer not null default 0,
  opened_count       integer not null default 0,
  clicked_count      integer not null default 0,
  bounced_count      integer not null default 0,
  complained_count   integer not null default 0,
  unsubscribed_count integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
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
  status           text not null default 'sent'
                     check (status in ('sent','delivered','opened','clicked',
                                       'bounced','complained','delivery_delayed')),
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
