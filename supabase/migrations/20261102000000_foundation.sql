-- Foundation for v2: companies, teams, provider keys, context documents, cards, usage.
-- Every company is an isolated system: every row below carries company_id and
-- row-level security limits access to members of that company.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- People and companies
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

-- editor: can sign off pieces, manage team, keys and model settings.
-- member: works on content.
create table public.memberships (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('editor', 'member')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor', 'member')),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz
);
create index invitations_company_idx on public.invitations (company_id);

-- ---------------------------------------------------------------------------
-- AI providers (keys are encrypted by the provider-keys function; the
-- ciphertext table has no policies, so only the service role can read it)
-- ---------------------------------------------------------------------------

create table public.provider_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'gemini')),
  key_hint text not null,
  is_active boolean not null default false,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (company_id, provider)
);
create unique index provider_keys_one_active on public.provider_keys (company_id) where is_active;

create table public.provider_key_secrets (
  key_id uuid primary key references public.provider_keys (id) on delete cascade,
  ciphertext text not null,
  iv text not null
);

-- Advanced override: a company can replace the default model for a task type.
create table public.model_overrides (
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'gemini')),
  task_type text not null check (task_type in ('extract', 'research', 'reason', 'write')),
  model text not null check (char_length(model) between 1 and 120),
  primary key (company_id, provider, task_type)
);

-- ---------------------------------------------------------------------------
-- Context documents: the consolidated, editable documents each stage can be
-- wired to. Raw inputs (pasted text, files, URLs) are kept separately, and AI
-- merges arrive as proposals the user accepts or rejects.
-- ---------------------------------------------------------------------------

create table public.formats (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  template_key text,
  description text not null default '',
  created_at timestamptz not null default now()
);
create index formats_company_idx on public.formats (company_id);

create table public.context_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('icp', 'positioning', 'strategy_notes', 'core_voice', 'format_profile')),
  format_id uuid references public.formats (id) on delete cascade,
  content text not null default '',
  version integer not null default 0,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  check ((kind = 'format_profile') = (format_id is not null))
);
create unique index context_documents_unique
  on public.context_documents (company_id, kind, coalesce(format_id, '00000000-0000-0000-0000-000000000000'));

create table public.context_inputs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  document_id uuid not null references public.context_documents (id) on delete cascade,
  origin text not null check (origin in ('paste', 'upload', 'url')),
  label text not null default '',
  source_url text,
  content text not null check (char_length(content) > 0),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  merged_at timestamptz
);
create index context_inputs_document_idx on public.context_inputs (document_id);

create table public.document_proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  document_id uuid not null references public.context_documents (id) on delete cascade,
  base_version integer not null,
  proposed_content text not null,
  summary text not null default '',
  input_ids uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz
);
create index document_proposals_document_idx on public.document_proposals (document_id);

-- ---------------------------------------------------------------------------
-- Insight and data cards
-- ---------------------------------------------------------------------------

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  type text not null check (type in ('story', 'opinion', 'data_point', 'technical_detail', 'customer_quote', 'lesson')),
  claim text not null check (char_length(claim) between 1 and 400),
  detail text not null default '',
  source_who text not null default '',
  source_where text not null default '',
  source_date text not null default '',
  citation text not null check (citation in ('public', 'internal')),
  tags text[] not null default '{}',
  -- data_point fields
  value text,
  unit text,
  period text,
  sample_size text,
  origin text not null default 'manual' check (origin in ('manual', 'import', 'extraction')),
  import_batch uuid,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'data_point' or (value is not null and value <> ''))
);
create index cards_company_idx on public.cards (company_id);
create index cards_tags_idx on public.cards using gin (tags);

-- ---------------------------------------------------------------------------
-- AI usage (written by functions with the service role; read by members)
-- ---------------------------------------------------------------------------

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references public.profiles (id),
  task text not null,
  task_type text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);
create index usage_events_company_idx on public.usage_events (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies don't recurse)
-- ---------------------------------------------------------------------------

create function public.is_member(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where company_id = target and user_id = auth.uid());
$$;

create function public.is_editor(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where company_id = target and user_id = auth.uid() and role = 'editor');
$$;

-- New auth users get a profile.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Create a company; the creator becomes its first editor and gets empty
-- strategy and voice documents.
create function public.create_company(company_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into companies (name, created_by) values (trim(company_name), auth.uid()) returning id into new_id;
  insert into memberships (company_id, user_id, role) values (new_id, auth.uid(), 'editor');
  insert into context_documents (company_id, kind)
    select new_id, k from unnest(array['icp', 'positioning', 'strategy_notes', 'core_voice']) as k;
  return new_id;
end;
$$;

-- Accept an invitation addressed to the signed-in user's email.
create function public.accept_invitation(invite_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv invitations;
  me text;
begin
  select email into me from profiles where id = auth.uid();
  select * into inv from invitations where token = invite_token;
  if inv.id is null then raise exception 'invitation not found'; end if;
  if inv.accepted_at is not null then raise exception 'invitation already used'; end if;
  if inv.expires_at < now() then raise exception 'invitation expired'; end if;
  if lower(inv.email) <> lower(me) then raise exception 'invitation is for a different email'; end if;
  insert into memberships (company_id, user_id, role) values (inv.company_id, auth.uid(), inv.role)
    on conflict (company_id, user_id) do nothing;
  update invitations set accepted_at = now() where id = inv.id;
  return inv.company_id;
end;
$$;

-- Accept an AI proposal: applies it only if the document hasn't changed since.
create function public.accept_proposal(proposal_id uuid, final_content text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p document_proposals;
  doc context_documents;
begin
  select * into p from document_proposals where id = proposal_id;
  if p.id is null or not is_member(p.company_id) then raise exception 'proposal not found'; end if;
  if p.status <> 'pending' then raise exception 'proposal already decided'; end if;
  select * into doc from context_documents where id = p.document_id for update;
  if doc.version <> p.base_version then
    raise exception 'document changed since this proposal was made';
  end if;
  update context_documents
    set content = final_content, version = version + 1, updated_by = auth.uid(), updated_at = now()
    where id = doc.id;
  update document_proposals set status = 'accepted', decided_by = auth.uid(), decided_at = now() where id = p.id;
  update context_inputs set merged_at = now() where id = any (p.input_ids) and merged_at is null;
  return doc.version + 1;
end;
$$;

-- Editors can't remove or demote the last editor of a company.
create function public.protect_last_editor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'editor' and (tg_op = 'DELETE' or new.role <> 'editor') then
    if (select count(*) from memberships where company_id = old.company_id and role = 'editor') <= 1 then
      raise exception 'a company needs at least one editor';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger memberships_protect_last_editor before update or delete on public.memberships
  for each row execute function public.protect_last_editor();

-- Document edits by hand bump the version so stale AI proposals can't overwrite them.
create function public.bump_document_version() returns trigger
language plpgsql as $$
begin
  if new.content is distinct from old.content and new.version = old.version then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
create trigger context_documents_bump before update on public.context_documents
  for each row execute function public.bump_document_version();

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger cards_touch before update on public.cards
  for each row execute function public.touch_updated_at();

-- A new format gets its (empty) style profile document.
create function public.handle_new_format() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into context_documents (company_id, kind, format_id) values (new.company_id, 'format_profile', new.id);
  return new;
end;
$$;
create trigger on_format_created after insert on public.formats
  for each row execute function public.handle_new_format();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.provider_keys enable row level security;
alter table public.provider_key_secrets enable row level security;
alter table public.model_overrides enable row level security;
alter table public.formats enable row level security;
alter table public.context_documents enable row level security;
alter table public.context_inputs enable row level security;
alter table public.document_proposals enable row level security;
alter table public.cards enable row level security;
alter table public.usage_events enable row level security;

-- profiles: yourself, and people you share a company with
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from memberships mine join memberships theirs on mine.company_id = theirs.company_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id
  )
);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- companies: created through create_company()
create policy companies_select on public.companies for select to authenticated using (is_member(id));
create policy companies_update on public.companies for update to authenticated using (is_editor(id)) with check (is_editor(id));

create policy memberships_select on public.memberships for select to authenticated using (is_member(company_id));
create policy memberships_update on public.memberships for update to authenticated
  using (is_editor(company_id)) with check (is_editor(company_id));
create policy memberships_delete on public.memberships for delete to authenticated
  using (is_editor(company_id) or user_id = auth.uid());

create policy invitations_select on public.invitations for select to authenticated using (is_editor(company_id));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (is_editor(company_id) and invited_by = auth.uid());
create policy invitations_delete on public.invitations for delete to authenticated using (is_editor(company_id));

-- provider keys: members see which providers exist; writes go through the function
create policy provider_keys_select on public.provider_keys for select to authenticated using (is_member(company_id));
-- provider_key_secrets: intentionally no policies

create policy model_overrides_select on public.model_overrides for select to authenticated using (is_member(company_id));
create policy model_overrides_write on public.model_overrides for all to authenticated
  using (is_editor(company_id)) with check (is_editor(company_id));

create policy formats_all on public.formats for all to authenticated
  using (is_member(company_id)) with check (is_member(company_id));

create policy context_documents_select on public.context_documents for select to authenticated using (is_member(company_id));
create policy context_documents_update on public.context_documents for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));

create policy context_inputs_select on public.context_inputs for select to authenticated using (is_member(company_id));
create policy context_inputs_insert on public.context_inputs for insert to authenticated
  with check (is_member(company_id) and created_by = auth.uid()
    and exists (select 1 from context_documents d where d.id = document_id and d.company_id = context_inputs.company_id));
create policy context_inputs_delete on public.context_inputs for delete to authenticated using (is_member(company_id));

create policy document_proposals_select on public.document_proposals for select to authenticated using (is_member(company_id));
create policy document_proposals_reject on public.document_proposals for update to authenticated
  using (is_member(company_id) and status = 'pending')
  with check (is_member(company_id) and status = 'rejected');

create policy cards_select on public.cards for select to authenticated using (is_member(company_id));
create policy cards_insert on public.cards for insert to authenticated
  with check (is_member(company_id) and created_by = auth.uid());
create policy cards_update on public.cards for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));
create policy cards_delete on public.cards for delete to authenticated using (is_member(company_id));

create policy usage_events_select on public.usage_events for select to authenticated using (is_member(company_id));

grant execute on function public.create_company(text) to authenticated;
grant execute on function public.accept_invitation(uuid) to authenticated;
grant execute on function public.accept_proposal(uuid, text) to authenticated;
revoke execute on function public.create_company(text) from anon;
revoke execute on function public.accept_invitation(uuid) from anon;
revoke execute on function public.accept_proposal(uuid, text) from anon;
