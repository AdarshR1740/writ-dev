-- Delete one section from the Writing page, without reopening the outline.
--
-- Writers change their minds half way through: a section turns out not to be needed. Until now the only way was to reopen
-- the outline, which also un-confirms it. This removes the section (and, for a main heading, the sub-headings under it),
-- takes their research and locks with them, closes the gap in the numbering and records the change.
--
-- Refused: a signed-off piece, the last section, a section someone else is editing, or the outline or the piece's research
-- while someone else edits it. The text of a removed section is gone (the piece's history keeps only that it happened).

create or replace function public.delete_section(target_section uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  pid uuid;
  p pieces;
  s piece_sections;
  upto integer;
  ids uuid[];
  r uuid;
begin
  select piece_id into pid from piece_sections where id = target_section;
  if pid is null then raise exception 'section not found'; end if;
  select * into p from pieces where id = pid for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'section not found'; end if;
  select * into s from piece_sections where id = target_section for update;
  if s.id is null then raise exception 'section not found'; end if;
  if p.stage = 'done' then raise exception 'this piece is signed off; its sections can no longer be removed. Revise it instead'; end if;

  -- A main heading takes its sub-headings with it: they run until the next main heading.
  if s.level = 2 then
    select min(position) into upto from piece_sections where piece_id = pid and position > s.position and level = 2;
    select array_agg(id) into ids from piece_sections
      where piece_id = pid and position >= s.position and (upto is null or position < upto);
  else
    ids := array[s.id];
  end if;

  if (select count(*) from piece_sections where piece_id = pid) - cardinality(ids) < 1 then
    raise exception 'a piece needs at least one section';
  end if;

  perform assert_unlocked(pid, 'outline', null);
  perform assert_unlocked(pid, 'research', null);
  foreach r in array ids loop
    perform assert_unlocked(pid, 'section', r);
  end loop;

  delete from research_items where piece_id = pid and scope = 'section' and section_key in (select unnest(ids)::text);
  delete from edit_locks where piece_id = pid and section_id = any (ids);
  delete from piece_sections where id = any (ids);
  -- Their conversations and version marks are keyed by the section's id with no foreign key; written after the delete so a
  -- trigger can't leave a mark behind.
  delete from threads where piece_id = pid and subject = 'section' and section_key in (select unnest(ids)::text);
  delete from step_versions where piece_id = pid and scope = 'section' and section_id = any (ids);

  update piece_sections ps set position = n.rn
    from (select id, row_number() over (order by position) as rn from piece_sections where piece_id = pid) n
    where ps.id = n.id and ps.position <> n.rn;

  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, pid, auth.uid(), 'section_deleted',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'removed', cardinality(ids)));
  return cardinality(ids);
end;
$$;

grant execute on function public.delete_section(uuid) to authenticated;
revoke execute on function public.delete_section(uuid) from anon, public;
