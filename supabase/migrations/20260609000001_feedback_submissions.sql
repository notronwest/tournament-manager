-- supabase/migrations/20260609000001_feedback_submissions.sql
--
-- Stores feedback widget submissions for rate-limiting and audit.
-- The submit-feedback edge function writes via service_role only —
-- no client INSERT policy. Platform admins can read via SQL.

create table if not exists public.feedback_submissions (
  id           uuid        primary key default gen_random_uuid(),
  ip_hash      text        not null,
  category     text        not null,
  message      text        not null,
  page_url     text,
  auth_user_id uuid,
  created_at   timestamptz not null default now()
);

alter table public.feedback_submissions enable row level security;

-- Platform admins may inspect submissions; everyone else is blocked.
create policy "platform admins read feedback_submissions"
  on public.feedback_submissions
  for select
  using (is_platform_admin());

-- No INSERT/UPDATE/DELETE policies — writes are service_role only
-- (same posture as payments and contact_form_submissions).
