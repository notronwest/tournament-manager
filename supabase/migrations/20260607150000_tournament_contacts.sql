-- 20260607150000_tournament_contacts.sql
--
-- Tournament contacts (issue #38). An organizer attaches one or more
-- contacts (name, role, phone, email) to a tournament so players know
-- who to reach. Each contact is independently public/hidden (an org can
-- stash a "billing only" contact privately) and can be flagged to
-- receive public contact-form messages.
--
-- SCOPE OF THIS MIGRATION: the contacts table only. The public
-- contact-FORM submission path (an edge function that fans out to
-- flagged emails via Resend) is server-side email — a hard stop, same
-- category as the Stripe writes — and lands separately once the
-- rate-limit mechanism is decided (see issue #38 / the blocked note).
-- If we land on a DB-backed rate limiter, its submissions-log table
-- comes in a companion migration.

set search_path = public;

create table public.tournament_contacts (
  id                    uuid primary key default gen_random_uuid(),
  tournament_id         uuid not null references public.tournaments(id) on delete cascade,
  name                  text not null,
  role                  text,
  phone                 text,
  email                 text,
  receives_form_messages boolean not null default false,
  is_public             boolean not null default true,
  sort_order            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

comment on table public.tournament_contacts is
  'Per-tournament contacts (director, registration, on-site). is_public hides a contact from the public page; receives_form_messages opts a contact into the contact-form fan-out.';

create index tournament_contacts_live_idx
  on public.tournament_contacts (tournament_id, sort_order)
  where deleted_at is null;

-- RLS ----------------------------------------------------------------
alter table public.tournament_contacts enable row level security;

-- Read: the public sees live, is_public contacts on a publicly-visible
-- tournament. Org members see all contacts (incl. private + hidden) for
-- their org's tournaments.
create policy "contacts read public or by org" on public.tournament_contacts
  for select using (
    deleted_at is null
    and (
      exists (
        select 1 from public.tournaments t
        where t.id = tournament_contacts.tournament_id
          and is_org_member(t.organization_id)
      )
      or (
        is_public
        and exists (
          select 1 from public.tournaments t
          where t.id = tournament_contacts.tournament_id
            and t.deleted_at is null
            and t.status in ('published', 'closed', 'completed')
        )
      )
    )
  );

-- Write: org admins manage the contact list.
create policy "contacts write by org admins" on public.tournament_contacts
  for all using (
    exists (
      select 1 from public.tournaments t
      where t.id = tournament_contacts.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  ) with check (
    exists (
      select 1 from public.tournaments t
      where t.id = tournament_contacts.tournament_id
        and has_org_role(t.organization_id, 'admin')
    )
  );
