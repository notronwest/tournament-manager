-- 20260607120000_public_content_sections.sql
--
-- The remaining "public-page content sections" columns promised by the
-- sponsors_and_faqs migration (20260530140000). These four nullable
-- markdown columns round out the structured prose blocks an organizer
-- can surface on the public tournament page (issue #39):
--
--   additional_info_md — catch-all extra info section.
--   refund_policy_md   — the refund COPY players read before paying.
--                        Complements cancellation_policy_preset
--                        (20260530120000), which is the refund
--                        MECHANISM. On the public page the two render
--                        together in a single Refund section.
--   weather_md         — rain / heat plan.
--   facility_info_md   — parking, restrooms, food, accessibility.
--
-- All nullable: NULL = section hidden on the public page. No RLS
-- changes needed — these are plain columns on tournaments, already
-- covered by the existing table policies (public reads published
-- tournaments; org members read drafts).

set search_path = public;

alter table public.tournaments
  add column additional_info_md text,
  add column refund_policy_md   text,
  add column weather_md         text,
  add column facility_info_md   text;

comment on column public.tournaments.additional_info_md is
  'Markdown copy for the public page''s "Additional info" section. NULL = section hidden.';

comment on column public.tournaments.refund_policy_md is
  'Markdown copy for the refund-policy text players agree to before paying. Renders in the same Refund section as cancellation_policy_preset. NULL = section hidden.';

comment on column public.tournaments.weather_md is
  'Markdown copy for the public page''s weather / rain-plan section. NULL = section hidden.';

comment on column public.tournaments.facility_info_md is
  'Markdown copy for the public page''s facility-info section (parking, restrooms, food, accessibility). NULL = section hidden.';
