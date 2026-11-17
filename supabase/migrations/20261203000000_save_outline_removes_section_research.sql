-- Removing a section from the outline (or clearing the outline) now also removes the research saved for that section.
-- Same function as before (see 20261128000000_section_levels.sql) with that one addition.
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
  -- A section that is removed takes its own research with it: the items are keyed by the section's id with no foreign key,
  -- so nothing else would delete them and they would stay in the piece for good.
  delete from research_items where piece_id = target_piece and scope = 'section'
    and section_key in (select id::text from piece_sections where piece_id = target_piece and id <> all (keep));
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
