-- Slice 2: pieces, the reader contract (built in a conversation), and
-- piece-level research with a mandatory review gate and a source library.

-- ---------------------------------------------------------------------------
-- Pieces
-- ---------------------------------------------------------------------------

create table public.pieces (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  topic text not null default '',
  primary_keyword text not null default '',
  format_id uuid references public.formats (id) on delete set null,
  goal text not null default '',
  audience_notes text not null default '',
  -- just-in-time: research, review and draft one section at a time;
  -- up_front: research every section, review once, then draft them all.
  section_timing text not null default 'just_in_time' check (section_timing in ('just_in_time', 'up_front')),
  stage text not null default 'contract' check (stage in ('contract', 'research', 'outline', 'writing', 'done')),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pieces_company_idx on public.pieces (company_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Reader contract: the writer owns it; the AI suggests in a thread.
-- ---------------------------------------------------------------------------

create table public.piece_contracts (
  piece_id uuid primary key references public.pieces (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  core_question text not null default '',
  -- [{ "id": "e1", "text": "..." }]
  expectations jsonb not null default '[]'::jsonb check (jsonb_typeof(expectations) = 'array'),
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

-- Conversation threads attached to an artifact, kept for traceability.
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  piece_id uuid not null references public.pieces (id) on delete cascade,
  subject text not null check (subject in ('contract', 'research', 'outline', 'section')),
  section_key text,
  created_at timestamptz not null default now()
);
create unique index threads_unique on public.threads (piece_id, subject, coalesce(section_key, ''));

create table public.thread_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  role text not null check (role in ('writer', 'ai')),
  content text not null,
  -- AI messages may carry a structured suggestion (e.g. a proposed contract)
  payload jsonb,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index thread_messages_thread_idx on public.thread_messages (thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Sources and research items
-- ---------------------------------------------------------------------------

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  url text,
  title text not null default '',
  published text not null default '',
  -- saved text, so the source still works if the page changes or disappears
  snapshot text,
  origin text not null check (origin in ('search', 'url', 'paste')),
  in_library boolean not null default false,
  tags text[] not null default '{}',
  last_checked timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index sources_company_idx on public.sources (company_id);
create index sources_library_idx on public.sources (company_id) where in_library;
create unique index sources_url_unique on public.sources (company_id, url) where url is not null;

create table public.research_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  piece_id uuid not null references public.pieces (id) on delete cascade,
  scope text not null default 'piece' check (scope in ('piece', 'section')),
  section_key text,
  source_id uuid references public.sources (id) on delete set null,
  card_id uuid references public.cards (id) on delete set null,
  statement text not null check (char_length(statement) between 1 and 1200),
  quote text not null default '',
  source_type text not null check (source_type in (
    'card', 'original_research', 'official', 'practitioner', 'critical', 'data', 'web'
  )),
  secondary boolean not null default false,
  status text not null default 'unreviewed' check (status in ('unreviewed', 'approved', 'rejected')),
  edited boolean not null default false,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((card_id is not null) = (source_type = 'card'))
);
create index research_items_piece_idx on public.research_items (piece_id, scope, section_key);

-- ---------------------------------------------------------------------------
-- Editorial record: every human decision on a piece.
-- ---------------------------------------------------------------------------

create table public.piece_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  piece_id uuid not null references public.pieces (id) on delete cascade,
  actor uuid references public.profiles (id),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index piece_events_piece_idx on public.piece_events (piece_id, created_at);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Create a piece with its empty contract and contract thread.
create function public.create_piece(
  target_company uuid, piece_title text, piece_topic text, keyword text,
  format uuid, piece_goal text, audience text, timing text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if not is_member(target_company) then raise exception 'not a member of this company'; end if;
  if format is not null and not exists (select 1 from formats where id = format and company_id = target_company) then
    raise exception 'format not found';
  end if;
  insert into pieces (company_id, title, topic, primary_keyword, format_id, goal, audience_notes, section_timing, created_by)
    values (target_company, trim(piece_title), coalesce(piece_topic, ''), coalesce(keyword, ''), format,
            coalesce(piece_goal, ''), coalesce(audience, ''), coalesce(timing, 'just_in_time'), auth.uid())
    returning id into new_id;
  insert into piece_contracts (piece_id, company_id) values (new_id, target_company);
  insert into threads (company_id, piece_id, subject) values (target_company, new_id, 'contract');
  insert into piece_events (company_id, piece_id, actor, action) values (target_company, new_id, auth.uid(), 'piece_created');
  return new_id;
end;
$$;

-- Confirm the contract: it needs a core question and at least one expectation.
create function public.confirm_contract(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c piece_contracts;
begin
  select * into c from piece_contracts where piece_id = target_piece for update;
  if c.piece_id is null or not is_member(c.company_id) then raise exception 'piece not found'; end if;
  if trim(c.core_question) = '' then raise exception 'add the core question first'; end if;
  if jsonb_array_length(c.expectations) = 0 then raise exception 'add at least one expectation first'; end if;
  update piece_contracts set confirmed_at = now(), confirmed_by = auth.uid() where piece_id = target_piece;
  update pieces set stage = case when stage = 'contract' then 'research' else stage end, updated_at = now()
    where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (c.company_id, target_piece, auth.uid(), 'contract_confirmed',
            jsonb_build_object('core_question', c.core_question, 'expectations', c.expectations));
end;
$$;

-- Review a research item (approve / reject, optionally with an edited statement).
create function public.review_item(item uuid, decision text, new_statement text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  r research_items;
begin
  if decision not in ('approved', 'rejected', 'unreviewed') then raise exception 'unknown decision'; end if;
  select * into r from research_items where id = item for update;
  if r.id is null or not is_member(r.company_id) then raise exception 'item not found'; end if;
  update research_items set
    status = decision,
    statement = coalesce(nullif(trim(new_statement), ''), statement),
    edited = edited or (new_statement is not null and trim(new_statement) <> statement),
    reviewed_by = case when decision = 'unreviewed' then null else auth.uid() end,
    reviewed_at = case when decision = 'unreviewed' then null else now() end
  where id = item;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (r.company_id, r.piece_id, auth.uid(), 'research_' || decision,
            jsonb_build_object('item', item, 'edited', new_statement is not null));
end;
$$;

-- Close the piece-level research gate: every item must be decided and at
-- least one approved.
create function public.complete_piece_research(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  open_items integer;
  approved integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  select count(*) filter (where status = 'unreviewed'), count(*) filter (where status = 'approved')
    into open_items, approved
    from research_items where piece_id = target_piece and scope = 'piece';
  if open_items > 0 then raise exception '% items still need a decision', open_items; end if;
  if approved = 0 then raise exception 'approve at least one item first'; end if;
  update pieces set stage = 'outline', updated_at = now() where id = target_piece and stage = 'research';
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'piece_research_completed', jsonb_build_object('approved', approved));
end;
$$;

create trigger pieces_touch before update on public.pieces
  for each row execute function public.touch_updated_at();

create function public.touch_contract() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  -- Any edit after confirmation reopens the contract.
  if (new.core_question, new.expectations) is distinct from (old.core_question, old.expectations) then
    new.confirmed_at := null;
    new.confirmed_by := null;
  end if;
  return new;
end;
$$;
create trigger piece_contracts_touch before update on public.piece_contracts
  for each row execute function public.touch_contract();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.pieces enable row level security;
alter table public.piece_contracts enable row level security;
alter table public.threads enable row level security;
alter table public.thread_messages enable row level security;
alter table public.sources enable row level security;
alter table public.research_items enable row level security;
alter table public.piece_events enable row level security;

create policy pieces_select on public.pieces for select to authenticated using (is_member(company_id));
create policy pieces_update on public.pieces for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));
create policy pieces_delete on public.pieces for delete to authenticated using (is_editor(company_id));

create policy piece_contracts_select on public.piece_contracts for select to authenticated using (is_member(company_id));
create policy piece_contracts_update on public.piece_contracts for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));

create policy threads_select on public.threads for select to authenticated using (is_member(company_id));

create policy thread_messages_select on public.thread_messages for select to authenticated using (is_member(company_id));
create policy thread_messages_insert on public.thread_messages for insert to authenticated
  with check (is_member(company_id) and role = 'writer' and created_by = auth.uid()
    and exists (select 1 from threads t where t.id = thread_id and t.company_id = thread_messages.company_id));

create policy sources_select on public.sources for select to authenticated using (is_member(company_id));
create policy sources_update on public.sources for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));

-- Items are created by the server (search, extraction) or from cards via the
-- client; review goes through review_item() so every decision is recorded.
create policy research_items_select on public.research_items for select to authenticated using (is_member(company_id));
create policy research_items_insert_card on public.research_items for insert to authenticated
  with check (is_member(company_id) and source_type = 'card' and status = 'unreviewed'
    and exists (select 1 from cards c where c.id = card_id and c.company_id = research_items.company_id)
    and exists (select 1 from pieces p where p.id = piece_id and p.company_id = research_items.company_id));
create policy research_items_delete on public.research_items for delete to authenticated
  using (is_member(company_id) and status = 'unreviewed');

create policy piece_events_select on public.piece_events for select to authenticated using (is_member(company_id));

grant execute on function public.create_piece(uuid, text, text, text, uuid, text, text, text) to authenticated;
grant execute on function public.confirm_contract(uuid) to authenticated;
grant execute on function public.review_item(uuid, text, text) to authenticated;
grant execute on function public.complete_piece_research(uuid) to authenticated;
revoke execute on function public.create_piece(uuid, text, text, text, uuid, text, text, text) from anon;
revoke execute on function public.confirm_contract(uuid) from anon;
revoke execute on function public.review_item(uuid, text, text) from anon;
revoke execute on function public.complete_piece_research(uuid) from anon;
