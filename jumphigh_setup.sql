-- Projeclab Studios: Jumphigh tab (schedule + daily-rate payroll)
-- Already applied in Supabase on 14 Nov 2026 (migration "jumphigh_tab") - kept here for the record.
--
-- Jumphigh is kept completely apart from Projeclab:
--   * Jumphigh staff logins are NOT in team_emails, so they can never read
--     app_state (tasks, clients, chat ...), payroll, invoices or the feed.
--   * jh_members  = who can open the Jumphigh tab, and as what (admin / staff).
--   * jh_data     = staff names + the shift schedule. Every Jumphigh member can
--                   read it; only Jumphigh admins can change it.
--   * jh_pay      = daily rates, pay details and payroll runs. Jumphigh admins only.

create table if not exists public.jh_members (
  email     text primary key,
  role      text not null check (role in ('admin', 'staff')),
  staff_id  text,
  added_at  timestamptz not null default now()
);
alter table public.jh_members enable row level security;

create or replace function public.jh_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.jh_members
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;
create or replace function public.is_jh_member()
returns boolean language sql stable security definer set search_path = public as $$
  select public.jh_role() is not null;
$$;
create or replace function public.is_jh_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.jh_role() = 'admin', false);
$$;
revoke execute on function public.jh_role()      from public, anon;
revoke execute on function public.is_jh_member() from public, anon;
revoke execute on function public.is_jh_admin()  from public, anon;
grant  execute on function public.jh_role()      to authenticated;
grant  execute on function public.is_jh_member() to authenticated;
grant  execute on function public.is_jh_admin()  to authenticated;

drop policy if exists "jh members: admins manage" on public.jh_members;
drop policy if exists "jh members: see own row"   on public.jh_members;
create policy "jh members: admins manage" on public.jh_members for all to authenticated
  using (public.is_jh_admin()) with check (public.is_jh_admin());
create policy "jh members: see own row" on public.jh_members for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create table if not exists public.jh_data (
  id         text primary key,
  kind       text not null,                 -- 'staff' | 'shift'
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.jh_data enable row level security;
drop policy if exists "jh data: members read"  on public.jh_data;
drop policy if exists "jh data: admins add"    on public.jh_data;
drop policy if exists "jh data: admins change" on public.jh_data;
drop policy if exists "jh data: admins remove" on public.jh_data;
create policy "jh data: members read"  on public.jh_data for select to authenticated using (public.is_jh_member());
create policy "jh data: admins add"    on public.jh_data for insert to authenticated with check (public.is_jh_admin());
create policy "jh data: admins change" on public.jh_data for update to authenticated using (public.is_jh_admin()) with check (public.is_jh_admin());
create policy "jh data: admins remove" on public.jh_data for delete to authenticated using (public.is_jh_admin());

create table if not exists public.jh_pay (
  id         text primary key,
  kind       text not null,                 -- 'rate' | 'run' | 'settings'
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.jh_pay enable row level security;
drop policy if exists "jh pay: admins only" on public.jh_pay;
create policy "jh pay: admins only" on public.jh_pay for all to authenticated
  using (public.is_jh_admin()) with check (public.is_jh_admin());
-- jh_pay is deliberately NOT added to Realtime.

-- Frean is the first Jumphigh admin.
insert into public.jh_members (email, role) values ('freandsantos@gmail.com', 'admin')
on conflict (email) do nothing;

-- Also (migration "task_photos_team_only"): task photos are only listable and
-- uploadable by Projeclab team members, so Jumphigh logins can't browse them.
alter policy "Projeclab team can read task photos" on storage.objects using (bucket_id = 'task-photos' and public.is_team_member());
alter policy "Projeclab team can upload task photos" on storage.objects with check (bucket_id = 'task-photos' and public.is_team_member());
