-- Fixes proposed after the alignment check, applied together and undoable as one step.
-- Only before the outline is confirmed. Nothing is deleted except sections the fixes themselves added:
-- rejected research stays (and can be restored), edited scope points keep their id, so outline sections stay linked.
--
-- fixes: {
--   "reject_items":  ["<research item id>", ...],
--   "edit_points":   [{"id": "<scope point id>", "text": "..."}],
--   "remove_points": ["<scope point id>", ...],
--   "add_points":    [{"id": "<new id>", "text": "..."}],
--   "add_sections":  [{"heading": "...", "purpose": "...", "expectation_ids": ["<scope point id>", ...]}]
-- }
-- Returns what undo_alignment_fixes needs to put everything back.
create function public.apply_alignment_fixes(target_piece uuid, fixes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  c piece_contracts;
  reject_ids uuid[];
  before_items jsonb;
  before_exps jsonb;
  before_sections jsonb;
  new_exps jsonb;
  v_edit jsonb;
  v_add jsonb;
  v_sec jsonb;
  v_rem text;
  removed_ids text[] := '{}';
  added_sections uuid[] := '{}';
  max_exp integer;
  pos integer;
  sid uuid;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' or p.outline_confirmed_at is not null then
    raise exception 'fixes apply before the outline is confirmed';
  end if;
  if jsonb_typeof(fixes) <> 'object' then raise exception 'fixes must be an object'; end if;

  select * into c from piece_contracts where piece_id = target_piece for update;
  before_exps := c.expectations;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'expectation_ids', expectation_ids)), '[]'::jsonb)
    into before_sections from piece_sections where piece_id = target_piece;

  -- Research: reject what is off the topic. The item stays, so it can be approved again.
  select coalesce(array_agg(x::uuid), '{}') into reject_ids
    from jsonb_array_elements_text(coalesce(fixes -> 'reject_items', '[]'::jsonb)) x;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'status', status)), '[]'::jsonb) into before_items
    from research_items where id = any (reject_ids) and piece_id = target_piece and scope = 'piece' and status = 'approved';
  update research_items set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
    where id = any (reject_ids) and piece_id = target_piece and scope = 'piece' and status = 'approved';

  -- Scope: reword, remove and add points. The scope is confirmed again afterwards.
  new_exps := c.expectations;
  for v_edit in select * from jsonb_array_elements(coalesce(fixes -> 'edit_points', '[]'::jsonb)) loop
    if trim(coalesce(v_edit ->> 'text', '')) = '' then raise exception 'a scope point can''t be empty'; end if;
    select coalesce(jsonb_agg(
      case when x ->> 'id' = v_edit ->> 'id' then jsonb_set(x, '{text}', to_jsonb(trim(v_edit ->> 'text'))) else x end
      order by ord), '[]'::jsonb)
      into new_exps from jsonb_array_elements(new_exps) with ordinality as t(x, ord);
  end loop;
  for v_rem in select * from jsonb_array_elements_text(coalesce(fixes -> 'remove_points', '[]'::jsonb)) loop
    select coalesce(jsonb_agg(x order by ord), '[]'::jsonb)
      into new_exps from jsonb_array_elements(new_exps) with ordinality as t(x, ord) where x ->> 'id' <> v_rem;
    removed_ids := removed_ids || v_rem;
  end loop;
  for v_add in select * from jsonb_array_elements(coalesce(fixes -> 'add_points', '[]'::jsonb)) loop
    if trim(coalesce(v_add ->> 'text', '')) = '' or trim(coalesce(v_add ->> 'id', '')) = '' then
      raise exception 'a new scope point needs an id and some text';
    end if;
    new_exps := new_exps || jsonb_build_array(jsonb_build_object('id', v_add ->> 'id', 'text', trim(v_add ->> 'text')));
  end loop;
  if new_exps is distinct from before_exps then
    max_exp := case when p.recipe #>> '{contract,mode}' = 'lite' then 2 else 7 end;
    if jsonb_array_length(new_exps) = 0 then raise exception 'the scope needs at least one point'; end if;
    if jsonb_array_length(new_exps) > max_exp then raise exception 'this format allows at most % scope points', max_exp; end if;
    update piece_contracts set expectations = new_exps where piece_id = target_piece;
    if cardinality(removed_ids) > 0 then
      update piece_sections set expectation_ids = coalesce(
        (select array_agg(y) from unnest(expectation_ids) y where y <> all (removed_ids)), '{}')
        where piece_id = target_piece;
    end if;
    perform confirm_contract(target_piece);
  end if;

  -- Outline: new sections go at the end; the writer can move them.
  if jsonb_array_length(coalesce(fixes -> 'add_sections', '[]'::jsonb)) > 0 then
    if p.recipe #>> '{outline,mode}' = 'off' then raise exception 'this format has no outline sections'; end if;
    select coalesce(max(position), 0) into pos from piece_sections where piece_id = target_piece;
    for v_sec in select * from jsonb_array_elements(fixes -> 'add_sections') loop
      if trim(coalesce(v_sec ->> 'heading', '')) = '' then raise exception 'a section needs a heading'; end if;
      if exists (
        select 1 from jsonb_array_elements_text(coalesce(v_sec -> 'expectation_ids', '[]'::jsonb)) x
        where not exists (select 1 from jsonb_array_elements(new_exps) e where e ->> 'id' = x)
      ) then
        raise exception 'a section points at a scope point that does not exist';
      end if;
      pos := pos + 1;
      insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids, status)
        values (p.company_id, target_piece, pos, trim(v_sec ->> 'heading'), trim(coalesce(v_sec ->> 'purpose', '')),
                coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v_sec -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
                first_section_status(p.recipe))
        returning id into sid;
      added_sections := added_sections || sid;
    end loop;
  end if;

  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'alignment_fixes_applied',
            jsonb_build_object('rejected', jsonb_array_length(before_items),
                               'edited', jsonb_array_length(coalesce(fixes -> 'edit_points', '[]'::jsonb)),
                               'removed', cardinality(removed_ids),
                               'added_points', jsonb_array_length(coalesce(fixes -> 'add_points', '[]'::jsonb)),
                               'added_sections', cardinality(added_sections)));

  return jsonb_build_object('items', before_items, 'expectations', before_exps, 'sections', before_sections,
                            'added_sections', to_jsonb(added_sections));
end;
$$;

-- Puts back what apply_alignment_fixes changed. Text the writer added to those sections since is not kept.
create function public.undo_alignment_fixes(target_piece uuid, snapshot jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' or p.outline_confirmed_at is not null then
    raise exception 'fixes can only be undone before the outline is confirmed';
  end if;

  update research_items r set status = s.status, reviewed_by = auth.uid(), reviewed_at = now()
    from (select (x ->> 'id')::uuid as id, x ->> 'status' as status
            from jsonb_array_elements(coalesce(snapshot -> 'items', '[]'::jsonb)) x) s
    where r.id = s.id and r.piece_id = target_piece;

  delete from piece_sections where piece_id = target_piece and id in (
    select x::uuid from jsonb_array_elements_text(coalesce(snapshot -> 'added_sections', '[]'::jsonb)) x);
  update piece_sections ps set expectation_ids = coalesce(
      (select array_agg(y) from jsonb_array_elements_text(s.exp) y), '{}')
    from (select (x ->> 'id')::uuid as id, x -> 'expectation_ids' as exp
            from jsonb_array_elements(coalesce(snapshot -> 'sections', '[]'::jsonb)) x) s
    where ps.id = s.id and ps.piece_id = target_piece;

  if snapshot ? 'expectations'
     and (select expectations from piece_contracts where piece_id = target_piece) is distinct from snapshot -> 'expectations' then
    update piece_contracts set expectations = snapshot -> 'expectations' where piece_id = target_piece;
    perform confirm_contract(target_piece);
  end if;

  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'alignment_fixes_undone', '{}'::jsonb);
end;
$$;

grant execute on function public.apply_alignment_fixes(uuid, jsonb) to authenticated;
grant execute on function public.undo_alignment_fixes(uuid, jsonb) to authenticated;
revoke execute on function public.apply_alignment_fixes(uuid, jsonb) from anon;
revoke execute on function public.undo_alignment_fixes(uuid, jsonb) from anon;
