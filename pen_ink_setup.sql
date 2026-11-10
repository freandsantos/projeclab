-- Handwritten to-dos (S Pen). Each row is one to-do's ink strokes.
-- Private: a row can only be read or written by the login that wrote it.
-- Kept out of the shared app_state so the team's saves stay small and
-- nobody else can see your handwriting.
create table if not exists public.pen_ink (
  id          text primary key,
  owner       uuid not null default auth.uid(),
  w           integer not null default 0,
  h           integer not null default 0,
  strokes     jsonb   not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.pen_ink enable row level security;

drop policy if exists "pen_ink own rows" on public.pen_ink;
create policy "pen_ink own rows" on public.pen_ink
  for all to authenticated
  using (owner = (select auth.uid()) and public.is_team_member())
  with check (owner = (select auth.uid()) and public.is_team_member());

create index if not exists pen_ink_owner_idx on public.pen_ink (owner);
