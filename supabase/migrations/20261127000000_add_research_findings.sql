-- Lets a client that did its own research (for example Claude through the Writ MCP server, on the writer's own AI
-- subscription) store what it found: the sources and the research items. A function, not plain inserts, because clients
-- have no insert policy on sources and may only insert 'card' rows into research_items.
--
-- It applies the same gates as the `research` edge function: the writer must be a member, the reader contract must be
-- confirmed, the piece (or section) must be at a step where research is still open, and the recipe must have research on.
-- Every item is stored as 'unreviewed' and with quote_status 'unverified': SQL cannot fetch the page to check the quote,
-- so nothing here claims a verification that did not happen. When the recipe has research review off, the existing
-- research_items_auto_approve trigger approves the rows, as it does for the edge function's rows.
--
-- findings: [{ url, title, statement, quote?, source_type, secondary?, published? }], at most 20 per call.
--
-- auto: true for the Writing step's "prepare" run, which may add research to a section whose status is already 'brief'
-- (as the edge function's `auto` search does). A normal section search needs status 'research' and, when the piece
-- researches just in time, every earlier section to be written first.
--
-- gap_search: true for a search aimed at one gap found by the gap analysis. The web app allows that at the outline step too
-- (before the outline is confirmed), so this does the same for piece-level research. Any other piece-level research needs
-- the research step to be open.
-- An earlier draft of this function had four arguments; drop it so no second version is left behind.
drop function if exists public.add_research_findings(uuid, jsonb, uuid, boolean);
create function public.add_research_findings(target_piece uuid, findings jsonb, target_section uuid default null,
                                             auto boolean default false, gap_search boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  s piece_sections;
  f jsonb;
  src_id uuid;
  src_url text;
  src_title text;
  item_id uuid;
  item_ids uuid[] := '{}';
  new_sources int := 0;
  n int;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;

  if jsonb_typeof(findings) is distinct from 'array' then raise exception 'findings must be a list'; end if;
  n := jsonb_array_length(findings);
  if n = 0 then raise exception 'no findings to add'; end if;
  if n > 20 then raise exception 'add at most 20 findings at a time'; end if;

  if not exists (select 1 from piece_contracts where piece_id = p.id and confirmed_at is not null) then
    raise exception 'confirm the reader contract before researching';
  end if;
  if not recipe_on(p.recipe, '{research,web_search}') then
    raise exception 'research by search is switched off for this piece';
  end if;

  if target_section is not null then
    select * into s from piece_sections where id = target_section and piece_id = p.id;
    if s.id is null then raise exception 'section not found'; end if;
    if not recipe_on(p.recipe, '{sections,research}') then raise exception 'section research is switched off for this piece'; end if;
    if auto then
      if s.status not in ('research', 'brief') then raise exception 'this section is already being written'; end if;
    else
      if s.status <> 'research' then raise exception 'this section''s research is already finished'; end if;
      if p.section_timing = 'just_in_time' and exists (
        select 1 from piece_sections where piece_id = p.id and position < s.position and status <> 'written'
      ) then
        raise exception 'write the earlier sections first (this piece researches one section at a time)';
      end if;
    end if;
  else
    if not recipe_on(p.recipe, '{research,enabled}') then raise exception 'research is switched off for this piece'; end if;
    if p.stage <> 'research' and not (gap_search and p.stage = 'outline' and p.outline_confirmed_at is null) then
      raise exception 'piece-level research is finished';
    end if;
  end if;

  for f in select * from jsonb_array_elements(findings) loop
    src_url := btrim(coalesce(f->>'url', ''));
    src_title := left(btrim(coalesce(f->>'title', '')), 300);
    if src_url !~* '^https?://[^\s]+$' or length(src_url) > 2000 then
      raise exception 'each finding needs a valid http(s) url';
    end if;
    if length(btrim(coalesce(f->>'statement', ''))) not between 1 and 1200 then
      raise exception 'each finding needs a statement of 1 to 1200 characters';
    end if;
    if coalesce(f->>'source_type', '') not in ('original_research', 'official', 'practitioner', 'critical', 'data', 'web', 'serp') then
      raise exception 'source_type must be one of original_research, official, practitioner, critical, data, web, serp';
    end if;

    select id into src_id from sources where company_id = p.company_id and url = src_url;
    if src_id is null then
      insert into sources (company_id, url, title, published, origin, created_by)
        values (p.company_id, src_url, coalesce(nullif(src_title, ''), src_url), left(coalesce(f->>'published', ''), 100),
                'search', auth.uid())
        returning id into src_id;
      new_sources := new_sources + 1;
      insert into piece_events (company_id, piece_id, actor, action, detail)
        values (p.company_id, p.id, auth.uid(), 'source_added', jsonb_build_object('source', src_id, 'url', src_url, 'via', 'client'));
    end if;

    insert into research_items (company_id, piece_id, scope, section_key, source_id, statement, quote, source_type,
                                secondary, quote_status)
      values (p.company_id, p.id, case when s.id is null then 'piece' else 'section' end, s.id::text, src_id,
              btrim(f->>'statement'), left(coalesce(f->>'quote', ''), 2000), f->>'source_type',
              coalesce((f->>'secondary')::boolean, false), 'unverified')
      returning id into item_id;
    item_ids := item_ids || item_id;
  end loop;

  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, p.id, auth.uid(), 'research_searched',
            jsonb_build_object('items', n, 'added', n, 'via', 'client', 'section', s.id));
  return jsonb_build_object('added', n, 'new_sources', new_sources, 'item_ids', to_jsonb(item_ids));
end;
$$;

grant execute on function public.add_research_findings(uuid, jsonb, uuid, boolean, boolean) to authenticated;
revoke execute on function public.add_research_findings(uuid, jsonb, uuid, boolean, boolean) from anon;
