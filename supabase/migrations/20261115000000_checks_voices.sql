-- 1. Which text a check ran on. Each edit to a section's text bumps content_rev; a check stores the
--    revision it ran on, so the app can show a tick only while the text is unchanged.
alter table public.piece_sections
  add column content_rev integer not null default 0,
  add column grammar_check jsonb;

create or replace function public.bump_content_rev() returns trigger
language plpgsql as $$
begin
  if new.content is distinct from old.content then
    new.content_rev := old.content_rev + 1;
  end if;
  return new;
end;
$$;

create trigger piece_sections_content_rev before update on public.piece_sections
  for each row execute function public.bump_content_rev();

-- 2. Leader voices: how particular people at the company write. Editors define them; any member can
--    use one to restyle a piece in their own AI tool (Writ never rewrites the writer's text itself).
create table public.leader_voices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  role text not null default '' check (char_length(role) <= 200),
  profile text not null check (char_length(trim(profile)) between 20 and 8000),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index leader_voices_company_idx on public.leader_voices (company_id, name);

create trigger leader_voices_touch before update on public.leader_voices
  for each row execute function public.touch_updated_at();

alter table public.leader_voices enable row level security;
create policy leader_voices_select on public.leader_voices for select to authenticated using (is_member(company_id));
create policy leader_voices_insert on public.leader_voices for insert to authenticated
  with check (is_editor(company_id) and created_by = auth.uid());
create policy leader_voices_update on public.leader_voices for update to authenticated
  using (is_editor(company_id)) with check (is_editor(company_id));
create policy leader_voices_delete on public.leader_voices for delete to authenticated using (is_editor(company_id));
