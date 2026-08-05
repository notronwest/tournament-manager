-- ─────────────────────────────────────────────────────────────────────
-- Notify on a customer quote response.
--
-- When a customer submits their selections on the public quote page
-- (submit_customer_revision → inserts a quote_revisions row with
-- created_by = 'customer'), fire the notify-quote-response edge function via
-- pg_net so it emails the WMPC rep. Mirrors the send-welcome-email trigger:
-- fire-and-forget, exception-safe, reads app.settings.supabase_url (already set
-- on the projects for the welcome-email trigger).
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.notify_quote_customer_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _supabase_url text;
begin
  _supabase_url := current_setting('app.settings.supabase_url', true);
  if _supabase_url is null or _supabase_url = '' then
    raise warning
      'notify_quote_customer_revision: app.settings.supabase_url not set — '
      'quote-response notification skipped for revision %.', new.id;
    return new;
  end if;

  -- Fire-and-forget HTTP POST via pg_net. The edge function always returns 200.
  perform net.http_post(
    url     := _supabase_url || '/functions/v1/notify-quote-response',
    body    := jsonb_build_object('quoteId', new.quote_id::text, 'revisionId', new.id::text),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );

  return new;
exception when others then
  -- A notification failure must never abort the customer's submission.
  raise warning
    'notify_quote_customer_revision: unexpected error (%), skipping notification for revision %.',
    sqlerrm, new.id;
  return new;
end;
$$;

-- Fires only for customer-submitted revisions (not admin saves).
drop trigger if exists on_quote_customer_revision on public.quote_revisions;
create trigger on_quote_customer_revision
  after insert on public.quote_revisions
  for each row
  when (new.created_by = 'customer')
  execute function public.notify_quote_customer_revision();
