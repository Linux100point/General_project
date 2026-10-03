create table if not exists public.matching_sessions (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users (id) on delete cascade,
  original_result jsonb not null default '{}'::jsonb,
  current_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists matching_sessions_created_by_idx
  on public.matching_sessions (created_by);

create index if not exists matching_sessions_updated_at_idx
  on public.matching_sessions (updated_at desc);

alter table public.matching_sessions enable row level security;

grant select, insert, update, delete on public.matching_sessions to authenticated;
grant all on public.matching_sessions to service_role;

drop policy if exists "Admins manage their matching sessions" on public.matching_sessions;
create policy "Admins manage their matching sessions"
  on public.matching_sessions
  for all
  to authenticated
  using (
    (select auth.uid()) = created_by
    and exists (
      select 1
      from public.user_profiles up
      where up.user_id = auth.uid()
        and up.role = 'ADMIN'
    )
  )
  with check (
    (select auth.uid()) = created_by
    and exists (
      select 1
      from public.user_profiles up
      where up.user_id = auth.uid()
        and up.role = 'ADMIN'
    )
  );

insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do nothing;

drop policy if exists "Admins can manage project-files objects" on storage.objects;
create policy "Admins can manage project-files objects"
  on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'project-files'
    and exists (
      select 1
      from public.user_profiles up
      where up.user_id = auth.uid()
        and up.role = 'ADMIN'
    )
  )
  with check (
    bucket_id = 'project-files'
    and exists (
      select 1
      from public.user_profiles up
      where up.user_id = auth.uid()
        and up.role = 'ADMIN'
    )
  );

drop policy if exists "Service role can manage project-files objects" on storage.objects;
create policy "Service role can manage project-files objects"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'project-files')
  with check (bucket_id = 'project-files');
