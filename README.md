# General Project

Full-stack university project using Vite, React, TypeScript, Express, and Supabase Auth.

## Authentication and roles

Supabase Auth is the identity provider. The frontend signs in with Supabase and retains its refreshable Auth session. It sends the Supabase access token to the API, which verifies it with Supabase Auth and resolves the role from `public.user_profiles`. The profile table is the trusted source for `ADMIN`, `STUDENT`, or `MENTOR`; frontend state and user metadata are not authorization sources.

The profile contains `user_id`, `email`, `full_name`, `role`, and optional `student_id`. RLS permits users to read only their own profile and does not permit users to change their own role. The backend uses the server-only service-role key to read profiles and provision invited accounts. Admin matching routes continue to require a verified Supabase user and an `ADMIN` profile.

There is no public registration or development role selector. Users are invited by an administrator; they set a password through the Supabase invitation flow and then sign in at the application login page. No application passwords are stored.

## Supabase setup

1. Copy `.env.example` to the repository-root `.env` and set values from Supabase Project Settings → API.
2. Apply `supabase/migrations/202610020001_create_user_profiles.sql` in the Supabase SQL Editor (or through the Supabase CLI).
3. In Supabase Auth settings, disable public user signups and add the configured invitation redirect URL to the allowed redirect URLs.
4. In Supabase Auth, invite the two initial administrator accounts. Before an application admin exists, add their profile rows from the SQL Editor using their Auth user IDs and real university emails:

```sql
insert into public.user_profiles (user_id, email, full_name, role)
select id, email, 'Teacher Name', 'ADMIN'
from auth.users
where email = 'teacher@example.edu';

insert into public.user_profiles (user_id, email, full_name, role)
select id, email, 'Project Developer Name', 'ADMIN'
from auth.users
where email = 'developer@example.edu';
```

Replace the example addresses and names with the real invited accounts. Do not expose the service-role key or use it in SQL/client-side application code.

After bootstrap, an authenticated admin can invite/provision accounts with `POST /api/admin/users/invite`, using a Supabase access token in the Bearer header and JSON fields `email`, `full_name`, `role`, and optional `student_id` (only for `STUDENT`). This endpoint sends the invitation through Supabase Auth and creates the profile server-side. No invitation-management UI is included yet.

## Environment variables

- `SUPABASE_URL`: project URL, backend
- `SUPABASE_ANON_KEY`: public anon key, backend
- `SUPABASE_SERVICE_ROLE_KEY`: privileged key, backend only; never prefix it with `VITE_`
- `VITE_SUPABASE_URL`: same project URL, frontend
- `VITE_SUPABASE_ANON_KEY`: public anon key, frontend
- `SUPABASE_INVITE_REDIRECT_URL`: optional allowed post-invitation redirect, usually `http://localhost:5173/?set-password=1`; add this URL to Supabase Auth's redirect allow list

The Vite configuration loads the root `.env`; only `VITE_` variables are included in the browser bundle.

## Run locally

Run each command in a separate terminal from the repository root:

```bash
npm --prefix backend install
npm --prefix backend run dev
```

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

Open http://localhost:5173. The backend health check is http://localhost:3001/api/health.

## Test roles and matching

Invite one account for each role from the admin endpoint or Supabase Auth, and make sure each account has a matching `user_profiles` row. Then sign in through the app:

- `ADMIN` → admin dashboard and Feature 2 mock matching
- `STUDENT` → student experience / existing Feature 1 placeholder
- `MENTOR` → separate mentor experience; no CV upload

To call the invitation endpoint, pass the current admin's Supabase access token:

```bash
curl -X POST http://localhost:3001/api/admin/users/invite \
	-H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
	-H "Content-Type: application/json" \
	-d '{"email":"student@example.edu","full_name":"Example Student","role":"STUDENT","student_id":"S-1001"}'
```

An unauthenticated request receives `401`; a `STUDENT` or `MENTOR` token receives `403` for admin matching endpoints; an `ADMIN` token is allowed. The matching provider remains the existing mock implementation.

## Feature 2 matching provider

The backend defaults to the mock provider. To opt into the OpenAI provider, set `MATCHING_PROVIDER=openai`, set `OPENAI_API_KEY` in the root `.env`, and set `OPENAI_MATCHING_MODEL=gpt-6-astra`. The API key is backend-only; do not add a `VITE_` prefix. Mentor CV extraction uses the configured model with low reasoning effort, caches structured profiles in process memory by mentor ID and PDF SHA-256, and the cohort matching call uses high reasoning effort with strict structured output and `store: false`. The mock provider remains available with `MATCHING_PROVIDER=mock` (or by leaving the selector unset).

Matching session state is persisted in Supabase. The CV profile cache is in process memory and is cleared when the server restarts. OpenAI calls are not made in automated tests and require the backend key to be configured locally.
