-- 20260911150000_partner_invites_last_sent_at.sql
--
-- Pending partner invites showed only created_at, so a Resend changed nothing
-- on the row and organizers couldn't tell whether the nudge went out. Record
-- the most recent send. Additive: one nullable column, backfilled to created_at
-- so existing invites never show blank; send-partner-invite stamps it after
-- each successful send (initial or resend).

set search_path = public;

alter table partner_invites
  add column if not exists last_sent_at timestamptz;

comment on column partner_invites.last_sent_at is
  'When the invite email most recently went out (initial send or Resend). '
  'Stamped by the send-partner-invite edge function after Resend accepts the message. '
  'Backfilled to created_at for invites that predate the column.';

update partner_invites
   set last_sent_at = created_at
 where last_sent_at is null;
