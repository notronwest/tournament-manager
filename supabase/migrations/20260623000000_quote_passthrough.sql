-- 20260623000000_quote_passthrough.sql
--
-- Quote system: mark a service as a PASS-THROUGH to a third party — money
-- collected from the organizer but NOT Bert & Erne's margin. The driving case
-- is the PickleballBrackets registration fee ($5 per registration / per
-- additional event): that $5 is PickleballBrackets' fee, not B&E profit, so it
-- should be excluded from the "Bert & Erne take" in the quote.
--
-- Adds is_passthrough to service_catalog (and snapshots it on quote_line_items
-- so saved revisions keep the right attribution), and flags registration_pb.

set search_path = public;

alter table public.service_catalog
  add column if not exists is_passthrough boolean not null default false;

comment on column public.service_catalog.is_passthrough is
  'True when this service''s charge is a pass-through to a third party (e.g. the '
  'PickleballBrackets registration fee) — collected from the organizer but NOT '
  'Bert & Erne''s margin. Excluded from the "Bert & Erne take" in the quote.';

alter table public.quote_line_items
  add column if not exists is_passthrough boolean not null default false;

-- The $5/registration PickleballBrackets fee is PB''s, not B&E''s take.
update public.service_catalog
   set is_passthrough = true
 where key = 'registration_pb';

-- Backfill saved line items so historical revisions reflect the change.
update public.quote_line_items
   set is_passthrough = true
 where service_key = 'registration_pb';
