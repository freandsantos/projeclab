-- Projeclab Studios: HRIS documents storage
-- Run this once in Supabase: SQL Editor -> New query -> paste all -> Run.
--
-- Employee records and document details already use the locked payroll table
-- (new kinds "employee" and "hrdoc"), so they need nothing new.
-- This only adds a PRIVATE storage bucket for the document files themselves
-- (contracts, IDs, NBI clearances ...). Only logins in payroll_admins
-- (you and HR) can upload, open or delete them.

insert into storage.buckets (id, name, public, file_size_limit)
values ('hr-docs', 'hr-docs', false, 20971520)   -- private, 20 MB per file
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists "hr docs read"   on storage.objects;
drop policy if exists "hr docs add"    on storage.objects;
drop policy if exists "hr docs change" on storage.objects;
drop policy if exists "hr docs remove" on storage.objects;

create policy "hr docs read"   on storage.objects for select to authenticated
  using (bucket_id = 'hr-docs' and public.is_payroll_admin());
create policy "hr docs add"    on storage.objects for insert to authenticated
  with check (bucket_id = 'hr-docs' and public.is_payroll_admin());
create policy "hr docs change" on storage.objects for update to authenticated
  using (bucket_id = 'hr-docs' and public.is_payroll_admin())
  with check (bucket_id = 'hr-docs' and public.is_payroll_admin());
create policy "hr docs remove" on storage.objects for delete to authenticated
  using (bucket_id = 'hr-docs' and public.is_payroll_admin());
