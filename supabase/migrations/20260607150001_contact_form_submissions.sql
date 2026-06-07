-- 20260607150001_contact_form_submissions.sql
--
-- Companion to 20260607150000_tournament_contacts.sql. Backs the public
-- contact-form rate limiter (issue #38): the contact-form edge function
-- records each submission here, then before fanning out an email it
-- counts recent rows for the same IP (and/or tournament) to throttle
-- abuse. Doubling as an audit trail the organizer can review.
--
-- Server-only writes: same posture as payments / audit_log. The edge
-- function inserts with the service_role key (bypasses RLS). NO client
-- INSERT/UPDATE policy exists, so a malicious client can't forge or
-- flood submissions directly — they must go through the rate-limited
-- function. Org members get SELECT to review their queue.
--
-- ip_hash, not raw IP: store a salted hash so the throttle works
-- without retaining players' raw addresses. The edge function computes
-- the hash with a server-side salt before insert/lookup.

set search_path = public;

create table public.contact_form_submissions (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  sender_name   text not null,
  sender_email  text not null,
  message       text not null,
  ip_hash       text,
  created_at    timestamptz not null default now()
);

comment on table public.contact_form_submissions is
  'Public contact-form submissions (issue #38). Server-only writes via the contact-form edge function (service_role); no client INSERT policy. Backs per-IP rate limiting and an organizer-visible audit trail.';

-- Rate-limit lookup: recent submissions for an IP, optionally scoped to
-- a tournament.
create index contact_form_submissions_ip_recent_idx
  on public.contact_form_submissions (ip_hash, created_at desc);

-- Organizer queue review: submissions per tournament, newest first.
create index contact_form_submissions_tournament_idx
  on public.contact_form_submissions (tournament_id, created_at desc);

-- RLS ----------------------------------------------------------------
alter table public.contact_form_submissions enable row level security;

-- SELECT only, and only for org members of the tournament's org. No
-- INSERT/UPDATE/DELETE policy — writes flow exclusively through the
-- edge function using the service_role key.
create policy "contact_form_submissions read by org" on public.contact_form_submissions
  for select using (
    exists (
      select 1 from public.tournaments t
      where t.id = contact_form_submissions.tournament_id
        and is_org_member(t.organization_id)
    )
  );
