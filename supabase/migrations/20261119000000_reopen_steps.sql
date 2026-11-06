-- Take a confirmed step back to review. Each step can be reopened while the step after it is still open; to go
-- further back, reopen the later steps first. Nothing is deleted: the scope, research items and sections stay.

-- Scope: back to editing. The piece returns to the Scope step; confirming it again moves on as before.
create function public.reopen_contract(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage = 'done' then raise exception 'this piece is signed off; revise it instead'; end if;
  if p.stage = 'writing' and (p.recipe #>> '{outline,mode}' <> 'off'
      or exists (select 1 from piece_sections where piece_id = p.id and btrim(content) <> '')) then
    raise exception 'writing has started; reopen the outline first';
  end if;
  update piece_contracts set confirmed_at = null, confirmed_by = null where piece_id = target_piece;
  update pieces set stage = 'contract', outline_confirmed_at = null, updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'contract_reopened', '{}'::jsonb);
end;
$$;

-- Piece-level research: back to reviewing items (the outline must still be open).
create function public.reopen_piece_research(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage = 'research' then raise exception 'research is already open'; end if;
  if p.stage = 'contract' then raise exception 'confirm the scope first'; end if;
  if p.stage = 'done' then raise exception 'this piece is signed off; revise it instead'; end if;
  if p.stage = 'writing' and (p.recipe #>> '{outline,mode}' <> 'off'
      or exists (select 1 from piece_sections where piece_id = p.id and btrim(content) <> '')) then
    raise exception 'writing has started; reopen the outline first';
  end if;
  update pieces set stage = 'research', outline_confirmed_at = null, updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'research_reopened', '{}'::jsonb);
end;
$$;

-- A section's research: back to reviewing items, while its brief isn't confirmed.
create function public.reopen_section_research(target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  if s.status = 'research' then raise exception 'this section''s research is already open'; end if;
  if s.status <> 'brief' then raise exception 'the brief is confirmed; this section is already being written'; end if;
  update piece_sections set status = 'research' where id = s.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_research_reopened', jsonb_build_object('section', s.id, 'heading', s.heading));
end;
$$;

grant execute on function public.reopen_contract(uuid) to authenticated;
grant execute on function public.reopen_piece_research(uuid) to authenticated;
grant execute on function public.reopen_section_research(uuid) to authenticated;
revoke execute on function public.reopen_contract(uuid) from anon;
revoke execute on function public.reopen_piece_research(uuid) from anon;
revoke execute on function public.reopen_section_research(uuid) from anon;
