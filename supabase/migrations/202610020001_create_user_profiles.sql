create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  role text not null check (role in ('ADMIN', 'STUDENT', 'MENTOR')),
  student_id text,
  created_at timestamptz not null default now(),
  constraint user_profiles_student_id_role_check
    check (role = 'STUDENT' or student_id is null)
);

create unique index if not exists user_profiles_email_lower_key
  on public.user_profiles (lower(email));

create unique index if not exists user_profiles_student_id_key
  on public.user_profiles (student_id)
  where student_id is not null;

alter table public.user_profiles enable row level security;

grant select on public.user_profiles to authenticated;
grant all on public.user_profiles to service_role;

drop policy if exists "Users can read their own profile" on public.user_profiles;
create policy "Users can read their own profile"
  on public.user_profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);