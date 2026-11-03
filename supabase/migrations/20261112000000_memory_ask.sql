-- Memory across pieces, and Ask Writ: both search the company's own material.

-- ---------------------------------------------------------------------------
-- search_material: ranked passages from what the company has: finished pieces
-- (current versions), insight and data cards, the house file, approved research
-- and library sources. Long texts are split into paragraphs so a passage is
-- something a person can check. Words are OR-ed and ranked, so a question
-- doesn't have to match every word.
-- ---------------------------------------------------------------------------
create function public.search_material(
  target_company uuid,
  q text,
  n integer default 12,
  only_kinds text[] default null,
  exclude_code text default null
) returns table (kind text, ref_id uuid, piece_id uuid, label text, title text, body text, path text, rank real)
language plpgsql stable security definer set search_path = public as $$
declare
  query tsquery;
  words text;
begin
  if not (is_member(target_company) or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  select string_agg(distinct w, ' | ') into words
    from regexp_split_to_table(lower(coalesce(q, '')), '[^a-z0-9]+') w
    where length(w) >= 3;
  if words is null then return; end if;
  query := to_tsquery('english', words);
  if query is null or numnode(query) = 0 then return; end if;

  return query
  with passages as (
    -- Finished pieces, current versions only, by paragraph.
    select 'piece'::text as kind, s.id as ref_id, p.id as piece_id, p.code || ' v' || p.version as label,
           p.title || case when s.heading <> '' and s.heading <> p.title then ': ' || s.heading else '' end as title,
           para as body, '/pieces/' || p.id as path
      from piece_sections s join pieces p on p.id = s.piece_id,
           regexp_split_to_table(s.content, E'\n\\s*\n') para
     where p.company_id = target_company and p.stage = 'done' and p.revised_by is null
       and (exclude_code is null or p.code <> exclude_code) and length(trim(para)) > 30
    union all
    select 'card', c.id, null, case when c.type = 'data_point' then 'Data point' else 'Insight card' end,
           c.claim,
           concat_ws(' ', c.claim, nullif(c.detail, ''),
             case when c.value is not null then concat_ws(' ', c.value, c.unit, c.period) end,
             nullif(concat_ws(', ', nullif(c.source_who, ''), nullif(c.source_where, ''), nullif(c.source_date, '')), '')),
           case when c.type = 'data_point' then '/data' else '/insights' end
      from cards c where c.company_id = target_company
    union all
    select 'house', d.id, null, 'House file',
           case d.kind when 'icp' then 'Ideal customer profile' when 'positioning' then 'Positioning'
             when 'strategy_notes' then 'Strategy notes' when 'core_voice' then 'Core voice' else 'Format profile' end,
           para,
           case d.kind when 'icp' then '/setup/icp' when 'positioning' then '/setup/positioning'
             when 'strategy_notes' then '/setup/strategy-notes' when 'core_voice' then '/setup/voice'
             else '/formats/' || d.format_id end
      from context_documents d, regexp_split_to_table(d.content, E'\n\\s*\n') para
     where d.company_id = target_company and length(trim(para)) > 30
    union all
    select 'research', r.id, p.id, 'Research · ' || p.code,
           coalesce(nullif(src.title, ''), 'Approved finding'),
           concat_ws(' ', r.statement, nullif(r.quote, '')),
           '/pieces/' || p.id
      from research_items r join pieces p on p.id = r.piece_id left join sources src on src.id = r.source_id
     where r.company_id = target_company and r.status = 'approved'
       and (exclude_code is null or p.code <> exclude_code)
    union all
    select 'library', src.id, null, 'Library', coalesce(nullif(src.title, ''), src.url, 'Source'), para, '/library'
      from sources src, regexp_split_to_table(coalesce(src.snapshot, ''), E'\n\\s*\n') para
     where src.company_id = target_company and src.in_library and length(trim(para)) > 60
  ),
  ranked as (
    select x.*, ts_rank(to_tsvector('english', x.body || ' ' || x.title), query) as rank
      from passages x
     where (only_kinds is null or x.kind = any (only_kinds))
       and to_tsvector('english', x.body || ' ' || x.title) @@ query
  )
  select ranked.kind, ranked.ref_id, ranked.piece_id, ranked.label, ranked.title, left(ranked.body, 1200), ranked.path, ranked.rank
    from ranked order by ranked.rank desc limit greatest(1, least(n, 40));
end;
$$;
grant execute on function public.search_material(uuid, text, integer, text[], text) to authenticated;
revoke execute on function public.search_material(uuid, text, integer, text[], text) from anon;

-- ---------------------------------------------------------------------------
-- Memory check: the piece compared with what the company has already published.
-- ---------------------------------------------------------------------------
alter table public.pieces add column memory_check jsonb;

-- ---------------------------------------------------------------------------
-- Ask Writ: one running conversation per person per company, private to them.
-- Written by the ai function; the person can clear it.
-- ---------------------------------------------------------------------------
create table public.ask_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'writ')),
  content text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index ask_messages_user_idx on public.ask_messages (company_id, user_id, created_at);
alter table public.ask_messages enable row level security;
create policy ask_messages_select on public.ask_messages for select to authenticated
  using (user_id = auth.uid() and is_member(company_id));
create policy ask_messages_delete on public.ask_messages for delete to authenticated
  using (user_id = auth.uid() and is_member(company_id));
