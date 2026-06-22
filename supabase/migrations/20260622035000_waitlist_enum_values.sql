-- 20260622035000_waitlist_enum_values.sql
--
-- Adds the two waitlist registration_status enum values in their OWN
-- migration so they're COMMITTED before anything uses them. Postgres forbids
-- using a newly-added enum value in the same transaction that adds it
-- (SQLSTATE 55P04: "unsafe use of new value ... of enum type"), which is what
-- the original combined waitlists migration hit (the partial index + the
-- functions reference 'waitlisted' in the same transaction as the ADD VALUE).
--
-- Split out per the proven pattern in 20260530160000_rating_source_self.sql.
-- The rest of the waitlist schema/functions live in 20260622040000_waitlists.sql,
-- which now applies AFTER this commits.

set search_path = public;

alter type registration_status add value if not exists 'waitlisted_pending_payment';
alter type registration_status add value if not exists 'waitlisted';
