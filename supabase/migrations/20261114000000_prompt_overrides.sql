-- A company's own version of a prompt. Without a row, Writ uses its built-in prompt.
-- Any member can read; only editors can change or reset (delete) one.
create table public.prompt_overrides (
  company_id uuid not null references public.companies (id) on delete cascade,
  prompt_key text not null check (char_length(prompt_key) between 1 and 80),
  text text not null check (char_length(text) between 20 and 20000),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (company_id, prompt_key)
);

alter table public.prompt_overrides enable row level security;
create policy prompt_overrides_select on public.prompt_overrides for select to authenticated using (is_member(company_id));
create policy prompt_overrides_insert on public.prompt_overrides for insert to authenticated
  with check (is_editor(company_id) and updated_by = auth.uid());
create policy prompt_overrides_update on public.prompt_overrides for update to authenticated
  using (is_editor(company_id)) with check (is_editor(company_id) and updated_by = auth.uid());
create policy prompt_overrides_delete on public.prompt_overrides for delete to authenticated using (is_editor(company_id));
