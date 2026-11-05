-- Saving the outline now keeps the sections it already has (their text, brief and research) instead of
-- replacing them all: sections are matched by id, new ones are added, and ones left out are removed.
create or replace function public.save_outline(target_piece uuid, sections jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  s jsonb;
  i integer := 0;
  sid uuid;
  keep uuid[] := '{}';
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.outline_confirmed_at is not null then raise exception 'the outline is confirmed; reopen it first'; end if;
  if jsonb_typeof(sections) <> 'array' then raise exception 'sections must be a list'; end if;
  for s in select * from jsonb_array_elements(sections) loop
    i := i + 1;
    sid := null;
    if (s ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select id into sid from piece_sections where id = (s ->> 'id')::uuid and piece_id = target_piece;
    end if;
    if sid is not null then
      update piece_sections set
        position = i,
        heading = trim(s ->> 'heading'),
        purpose = coalesce(s ->> 'purpose', ''),
        expectation_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
        structure = case when jsonb_typeof(s -> 'structure') = 'array' and jsonb_array_length(s -> 'structure') > 0 then s -> 'structure' end
        where id = sid;
    else
      insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids, structure, status)
        values (p.company_id, target_piece, i, trim(s ->> 'heading'), coalesce(s ->> 'purpose', ''),
                coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
                case when jsonb_typeof(s -> 'structure') = 'array' and jsonb_array_length(s -> 'structure') > 0 then s -> 'structure' end,
                first_section_status(p.recipe))
        returning id into sid;
    end if;
    keep := keep || sid;
  end loop;
  delete from piece_sections where piece_id = target_piece and id <> all (keep);
end;
$$;

-- Take a confirmed outline back to editing. Sections already written keep their text; the outline has to be
-- confirmed again before writing carries on.
create function public.reopen_outline(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'writing' or p.outline_confirmed_at is null then raise exception 'only a confirmed outline of a piece being written can be reopened'; end if;
  if p.recipe #>> '{outline,mode}' = 'off' then raise exception 'this format has no outline'; end if;
  update pieces set stage = 'outline', outline_confirmed_at = null, updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'outline_reopened', '{}'::jsonb);
end;
$$;

grant execute on function public.reopen_outline(uuid) to authenticated;
revoke execute on function public.reopen_outline(uuid) from anon;
