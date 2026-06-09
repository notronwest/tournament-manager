-- 20260609120000_player_avatars.sql
--
-- Profile pictures (story #156). Two pieces of infra the UI story depends on:
--
--   1. players.avatar_path  — NEW nullable column. Stores the Storage
--      OBJECT PATH (e.g. "<auth-uid>/avatar.png"), NOT a full URL. The
--      bucket is public-read, so the client derives the display URL with
--      supabase.storage.from('avatars').getPublicUrl(avatar_path). Storing
--      the path (not the URL) keeps rows portable across environments and
--      survives any future bucket rename / move to signed URLs.
--
--   2. avatars Storage bucket + RLS — public-read, owner-write. First use
--      of Supabase Storage in this project, so this also establishes the
--      convention: objects are namespaced by the owner's auth uid as the
--      first path segment ("<auth-uid>/<filename>"), and the storage RLS
--      keys off that segment so a user can only write/replace/delete their
--      OWN object while anyone can read.
--
-- Note on the size/type guards in the AC (jpg/png/webp, size cap): those are
-- enforced client-side at upload time. Supabase Storage can also enforce
-- allowed_mime_types / file_size_limit at the bucket level, which we set
-- below as a server-side backstop.

set search_path = public;

-- ── 1. players.avatar_path ───────────────────────────────────────────
alter table public.players
  add column if not exists avatar_path text;

comment on column public.players.avatar_path is
  'Storage object path in the public "avatars" bucket (e.g. "<auth-uid>/avatar.png"). NULL = no avatar (UI shows initials placeholder). Derive a display URL via storage.from(''avatars'').getPublicUrl(avatar_path).';

-- ── 2. avatars bucket (public-read) with server-side guards ──────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,  -- 5 MB cap (server-side backstop; client enforces too)
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 3. Storage RLS on objects in the avatars bucket ──────────────────
-- Owner-write model: the first folder segment of the object name must equal
-- the caller's auth uid. Reads are public (bucket is public, but we add an
-- explicit SELECT policy so the intent is documented and signed-URL flows
-- keep working if we ever flip public → false).

create policy "avatars public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars owner insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars owner delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
