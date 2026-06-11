-- Add structured address fields to locations.
-- Keeps existing `address` column as street line 1; adds nullable
-- line2, city, state, postal_code for future map/geocoding use.
-- No backfill required; all nullable.

alter table public.locations
  add column if not exists address_line2 text,
  add column if not exists city          text,
  add column if not exists state         text,
  add column if not exists postal_code   text;
