-- What each section should contain, block by block (answer, list, table, example...), planned in the
-- outline so a section is more than a heading followed by a paragraph.
-- Shape: [{"type": "answer", "note": "what goes in this block"}, ...]
alter table public.piece_sections add column structure jsonb;

create or replace function public.save_outline(target_piece uuid, sections jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  s jsonb;
  i integer := 0;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.outline_confirmed_at is not null then raise exception 'the outline is confirmed; reopen it first'; end if;
  if jsonb_typeof(sections) <> 'array' then raise exception 'sections must be a list'; end if;
  delete from piece_sections where piece_id = target_piece;
  for s in select * from jsonb_array_elements(sections) loop
    i := i + 1;
    insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids, structure, status)
      values (p.company_id, target_piece, i, trim(s ->> 'heading'), coalesce(s ->> 'purpose', ''),
              coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
              case when jsonb_typeof(s -> 'structure') = 'array' and jsonb_array_length(s -> 'structure') > 0 then s -> 'structure' end,
              first_section_status(p.recipe));
  end loop;
end;
$$;
