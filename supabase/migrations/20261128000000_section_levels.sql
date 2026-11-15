-- Sub-headings (H3) as rows of their own.
--
-- A section row is a heading and everything that goes with it: research, talking points, brief, draft, checks, status.
-- An H3 is now a row too, so it gets all of that. The list stays flat and in document order (position): a level 3 row
-- belongs to the nearest level 2 row above it. Every row that exists today is level 2, so nothing changes for them.
--
--   level  2 = a main heading (H2), 3 = a sub-heading (H3) under the H2 above it
--   depth  how much the writer wants it to say: short, standard or deep (guidance for drafting, never a cut-off)
--
-- Sub-headings exist only in free outlines (blogs, newsletters). Fixed and one-section formats never get them.

alter table public.piece_sections
  add column level smallint not null default 2 check (level in (2, 3)),
  add column depth text not null default 'standard' check (depth in ('short', 'standard', 'deep'));

-- ---------------------------------------------------------------------------
-- Saving the outline carries level and depth. Rows are matched by id as before. A row that comes without a level keeps
-- the one it has (or is level 2 when new), so older callers keep working.
-- ---------------------------------------------------------------------------

create or replace function public.save_outline(target_piece uuid, sections jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  s jsonb;
  i integer := 0;
  sid uuid;
  keep uuid[] := '{}';
  lvl smallint;
  dpt text;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.outline_confirmed_at is not null then raise exception 'the outline is confirmed; reopen it first'; end if;
  if jsonb_typeof(sections) <> 'array' then raise exception 'sections must be a list'; end if;
  for s in select * from jsonb_array_elements(sections) loop
    i := i + 1;
    sid := null;
    lvl := nullif(trim(s ->> 'level'), '')::smallint;
    if lvl is not null and lvl not in (2, 3) then raise exception 'a heading level is 2 or 3'; end if;
    dpt := nullif(trim(s ->> 'depth'), '');
    if dpt is not null and dpt not in ('short', 'standard', 'deep') then raise exception 'depth is short, standard or deep'; end if;
    if (s ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into sid from piece_sections where id = (s ->> 'id')::uuid and piece_id = target_piece;
    end if;
    if sid is not null then
      update piece_sections set
        position = i,
        heading = trim(s ->> 'heading'),
        purpose = coalesce(s ->> 'purpose', ''),
        expectation_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
        structure = case when jsonb_typeof(s -> 'structure') = 'array' and jsonb_array_length(s -> 'structure') > 0 then s -> 'structure' end,
        level = coalesce(lvl, level),
        depth = coalesce(dpt, depth)
        where id = sid;
    else
      insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids, structure, status, level, depth)
        values (p.company_id, target_piece, i, trim(s ->> 'heading'), coalesce(s ->> 'purpose', ''),
                coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
                case when jsonb_typeof(s -> 'structure') = 'array' and jsonb_array_length(s -> 'structure') > 0 then s -> 'structure' end,
                first_section_status(p.recipe), coalesce(lvl, 2), coalesce(dpt, 'standard'))
        returning id into sid;
    end if;
    keep := keep || sid;
  end loop;
  delete from piece_sections where piece_id = target_piece and id <> all (keep);
  -- Sub-headings only in a free outline, and never before the first main heading. Raising undoes the whole save.
  if exists (select 1 from piece_sections where piece_id = target_piece and level = 3) then
    if p.recipe #>> '{outline,mode}' is distinct from 'free' then raise exception 'sub-headings are only available in a free outline'; end if;
    if (select level from piece_sections where piece_id = target_piece order by position limit 1) = 3 then
      raise exception 'the outline has to start with a main heading';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- A main heading whose content is its sub-headings may have an empty opening: it can be marked written without text.
-- ---------------------------------------------------------------------------

create or replace function public.complete_section(target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
  next_level smallint;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  if s.status not in ('writing', 'written') then raise exception 'confirm the brief first'; end if;
  select level into next_level from piece_sections where piece_id = s.piece_id and position > s.position order by position limit 1;
  if trim(s.content) = '' and not (s.level = 2 and coalesce(next_level, 0) = 3) then raise exception 'the section is empty'; end if;
  update piece_sections set status = 'written',
    written_by = case when ai_draft is null then 'writer' else 'ai_then_writer' end
    where id = s.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_written',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'ai_drafted', s.ai_draft is not null));
end;
$$;

-- Level and depth are outline settings: they change by saving the outline, not by editing a row directly.
create or replace function public.guard_section_status() returns trigger
language plpgsql as $$
begin
  -- Inside the security-definer functions current_user is the owner, so only
  -- direct client updates are checked here.
  if current_user = 'authenticated' and new.status is distinct from old.status
     and not (old.status = 'written' and new.status = 'writing') then
    raise exception 'section status changes go through the review steps';
  end if;
  if current_user = 'authenticated' and (new.level is distinct from old.level or new.depth is distinct from old.depth) then
    raise exception 'heading levels change through the outline';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- A revision keeps the shape: the seed it starts the new piece's outline from now carries level and depth.
-- ---------------------------------------------------------------------------

create or replace function public.revise_piece(source_piece uuid, use_current_recipe boolean, carry uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s pieces;
  r jsonb;
  new_id uuid;
  latest integer;
  sec piece_sections;
begin
  select * into s from pieces where id = source_piece;
  if s.id is null or not is_member(s.company_id) then raise exception 'piece not found'; end if;
  if s.stage <> 'done' then raise exception 'only finished pieces can be revised'; end if;
  r := s.recipe;
  if use_current_recipe and s.format_id is not null then
    select recipe into r from formats where id = s.format_id;
  end if;
  select max(version) into latest from pieces where company_id = s.company_id and code = s.code;

  insert into pieces (company_id, title, topic, primary_keyword, format_id, goal, audience_notes, section_timing, recipe,
                      brief_extra, code, version, lineage_id, outline_seed, origin_notes, created_by)
    values (s.company_id, s.title, s.topic, s.primary_keyword, s.format_id, s.goal, s.audience_notes, s.section_timing, r,
            s.brief_extra, s.code, latest + 1, s.lineage_id,
            (select jsonb_agg(jsonb_build_object('heading', heading, 'purpose', purpose, 'content', content, 'level', level, 'depth', depth) order by position)
               from piece_sections where piece_id = s.id),
            'Revision of ' || s.code || ' v' || s.version || '.', auth.uid())
    returning id into new_id;

  insert into piece_contracts (piece_id, company_id, core_question, expectations)
    select new_id, company_id, core_question, expectations from piece_contracts where piece_id = s.id;
  insert into threads (company_id, piece_id, subject) values (s.company_id, new_id, 'contract');
  perform carry_items(new_id, carry);

  update pieces set revised_by = new_id where id = s.id;
  insert into piece_links (company_id, from_piece, to_piece, kind, created_by) values (s.company_id, s.id, new_id, 'revision', auth.uid());
  insert into piece_events (company_id, piece_id, actor, action, detail) values
    (s.company_id, s.id, auth.uid(), 'revised', jsonb_build_object('new_version', latest + 1, 'new_piece', new_id)),
    (s.company_id, new_id, auth.uid(), 'piece_created',
     jsonb_build_object('revision_of', s.id, 'from_version', s.version, 'recipe', case when use_current_recipe then 'current' else 'original' end,
                        'carried_items', coalesce(array_length(carry, 1), 0)));
  perform enter_stage(new_id, 'contract');
  return new_id;
end;
$$;

create or replace function public.enter_stage(target_piece uuid, target text) returns text
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  r jsonb;
  next_stage text := target;
  exp_ids text[];
  h jsonb;
  i integer := 0;
begin
  select * into p from pieces where id = target_piece for update;
  r := p.recipe;
  if next_stage = 'contract' and r #>> '{contract,mode}' = 'off' then next_stage := 'research'; end if;
  if next_stage = 'research' and not recipe_on(r, '{research,enabled}') then next_stage := 'outline'; end if;
  if next_stage = 'outline' then
    if r #>> '{outline,mode}' = 'off' then
      if not exists (select 1 from piece_sections where piece_id = p.id) then
        select coalesce(array_agg(e ->> 'id'), '{}') into exp_ids
          from piece_contracts c, jsonb_array_elements(c.expectations) e where c.piece_id = p.id;
        -- A revision of a single-section piece keeps its text to edit.
        insert into piece_sections (company_id, piece_id, position, heading, expectation_ids, content, status)
          values (p.company_id, p.id, 1, p.title, coalesce(exp_ids, '{}'),
                  coalesce((select string_agg(seed_el ->> 'content', E'\n\n') from jsonb_array_elements(coalesce(p.outline_seed, '[]'::jsonb)) seed_el), ''),
                  first_section_status(r));
      end if;
      update pieces set outline_confirmed_at = coalesce(outline_confirmed_at, now()) where id = p.id;
      next_stage := 'writing';
    elsif not exists (select 1 from piece_sections where piece_id = p.id) then
      if p.outline_seed is not null and jsonb_array_length(p.outline_seed) > 0 then
        for h in select * from jsonb_array_elements(p.outline_seed) loop
          i := i + 1;
          -- Sub-headings come back only into a free outline; any other outline gets main headings alone.
          insert into piece_sections (company_id, piece_id, position, heading, purpose, content, status, level, depth)
            values (p.company_id, p.id, i, coalesce(h ->> 'heading', 'Section ' || i), coalesce(h ->> 'purpose', ''),
                    coalesce(h ->> 'content', ''), first_section_status(r),
                    case when (h ->> 'level') = '3' and i > 1 and r #>> '{outline,mode}' = 'free' then 3 else 2 end,
                    case when (h ->> 'depth') in ('short', 'standard', 'deep') then h ->> 'depth' else 'standard' end);
        end loop;
      elsif r #>> '{outline,mode}' = 'fixed' then
        for h in select to_jsonb(t) from jsonb_array_elements_text(r -> 'outline' -> 'template') t loop
          i := i + 1;
          insert into piece_sections (company_id, piece_id, position, heading, status)
            values (p.company_id, p.id, i, h #>> '{}', first_section_status(r));
        end loop;
      end if;
    end if;
  end if;
  update pieces set stage = next_stage, updated_at = now() where id = p.id;
  return next_stage;
end;
$$;
