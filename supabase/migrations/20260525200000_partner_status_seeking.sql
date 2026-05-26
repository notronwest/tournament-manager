-- 20260525200000_partner_status_seeking.sql
--
-- F1: "I need a partner" registration option for doubles events.
-- Adds a 'seeking' value to the partner_status enum so a player
-- can register for a doubles event without picking a partner —
-- they're explicitly looking for one. Organizers can match them up
-- offline (F2), and other registrants can find them via the
-- partner search (which now treats seekers as findable rather than
-- "already taken").
--
-- Also updates the F3 RPC players_registered_for_events to EXCLUDE
-- seekers. F3's purpose is "don't let a player pick a partner who
-- already has a partner / is registered with someone." A seeker
-- has neither — they're available, and the whole point of seeking
-- is to be findable. So the RPC's set shrinks to: registered AND
-- not seeking.

set search_path = public;

alter type partner_status add value if not exists 'seeking';
