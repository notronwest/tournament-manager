-- 20260530140000_sponsors_and_faqs.sql
--
-- Two free-form markdown text columns on tournaments for the
-- wizard's Step 5 (Sponsors & branding) and Step 6 (FAQs):
--
--   sponsors_md  — sponsor names, links, mini-blurbs. Image upload
--                  for logos / banners is a follow-up (needs
--                  Supabase Storage policies); for now an organizer
--                  pastes markdown.
--   faqs_md      — Q+A entries the public page renders on the
--                  tournament page. Structured FAQ rows are a
--                  follow-up if/when an organizer wants per-FAQ
--                  reordering or analytics. For now: markdown blob.
--
-- Companion columns for the rest of the "public-page content
-- sections" backlog item (additional_info_md, refund_policy_md,
-- weather_md, facility_info_md) land in a follow-up migration —
-- this one is scoped to what the wizard slice 4 needs.

set search_path = public;

alter table public.tournaments
  add column sponsors_md text,
  add column faqs_md text;

comment on column public.tournaments.sponsors_md is
  'Markdown copy for the public page''s Sponsors & branding section. NULL = section hidden. Image uploads are a follow-up; for now organizers paste sponsor names + links as markdown.';

comment on column public.tournaments.faqs_md is
  'Markdown copy for the public page''s FAQ section (parking, format details, lunch, etc.). NULL = section hidden. Structured per-FAQ rows are a follow-up.';
