-- Learned voice memory: an editable list of rules per company, learned from
-- the writer's edits and feedback, or added by hand. Only drafting reads it.

create table public.voice_memory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  rule text not null check (char_length(rule) between 1 and 500),
  evidence text not null default '',
  origin text not null default 'manual' check (origin in ('manual', 'learned')),
  source_piece uuid references public.pieces (id) on delete set null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index voice_memory_company_idx on public.voice_memory (company_id, created_at);

alter table public.voice_memory enable row level security;
create policy voice_memory_select on public.voice_memory for select to authenticated using (is_member(company_id));
create policy voice_memory_insert on public.voice_memory for insert to authenticated
  with check (is_member(company_id) and created_by = auth.uid());
create policy voice_memory_update on public.voice_memory for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));
create policy voice_memory_delete on public.voice_memory for delete to authenticated using (is_member(company_id));
