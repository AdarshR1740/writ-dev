-- Clear the research of a piece, or of one section, while that research is still open (not finished yet).
-- A plain delete is not enough: the table's delete policy only lets a person remove items nobody has reviewed.
-- Sources stay (they are the library), and so does everything the writer typed elsewhere. Returns how many items went.
create function public.clear_research(target_piece uuid, target_section uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  s piece_sections;
  n integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if target_section is null then
    if p.stage <> 'research' then raise exception 'the research is finished; reopen it first'; end if;
    delete from research_items where piece_id = target_piece and scope = 'piece';
  else
    select * into s from piece_sections where id = target_section and piece_id = target_piece for update;
    if s.id is null then raise exception 'section not found'; end if;
    if s.status <> 'research' then raise exception 'this section''s research is finished; reopen it first'; end if;
    delete from research_items where piece_id = target_piece and scope = 'section' and section_key = target_section::text;
  end if;
  get diagnostics n = row_count;
  if n > 0 then
    insert into piece_events (company_id, piece_id, actor, action, detail)
      values (p.company_id, target_piece, auth.uid(), 'research_cleared',
              jsonb_build_object('items', n, 'section', target_section));
  end if;
  return n;
end;
$$;

grant execute on function public.clear_research(uuid, uuid) to authenticated;
revoke execute on function public.clear_research(uuid, uuid) from anon;
