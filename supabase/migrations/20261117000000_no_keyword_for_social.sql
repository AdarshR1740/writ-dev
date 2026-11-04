-- Formats that don't use a primary keyword (a LinkedIn post, a social caption) must not inherit one from the
-- article they were repurposed from: the piece's own angle is its topic. Also clears keywords already copied.
create or replace function public.create_from_plan(plan uuid, entries jsonb) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  pl repurpose_plans;
  f formats;
  e jsonb;
  new_id uuid;
  created uuid[] := '{}';
  src uuid;
  first_src pieces;
  items uuid[];
  gaps text;
begin
  select * into pl from repurpose_plans where id = plan for update;
  if pl.id is null or not is_member(pl.company_id) then raise exception 'plan not found'; end if;
  if pl.status <> 'draft' then raise exception 'this plan was already used'; end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) = 0 then raise exception 'the plan has no pieces to create'; end if;
  if pl.shape <> 'split' and jsonb_array_length(entries) <> 1 then raise exception 'adapt and combine create exactly one piece'; end if;
  select * into f from formats where id = pl.target_format_id;
  select * into first_src from pieces where id = pl.source_piece_ids[1];
  select string_agg('- ' || g, E'\n') into gaps from jsonb_array_elements_text(coalesce(pl.proposal -> 'gaps', '[]'::jsonb)) g;

  for e in select * from jsonb_array_elements(entries) loop
    insert into pieces (company_id, title, topic, primary_keyword, format_id, goal, audience_notes, section_timing, recipe,
                        outline_seed, origin_notes, created_by)
      values (pl.company_id, coalesce(nullif(trim(e ->> 'heading'), ''), first_src.title), coalesce(e ->> 'angle', ''),
              case when pl.shape = 'combine' or (f.recipe #>> '{brief,keyword}') = 'false' then '' else first_src.primary_keyword end,
              f.id, first_src.goal, first_src.audience_notes, coalesce(f.recipe #>> '{sections,timing}', 'just_in_time'), f.recipe,
              case when jsonb_array_length(coalesce(e -> 'sections', '[]'::jsonb)) > 0 then e -> 'sections' else null end,
              concat_ws(E'\n',
                initcap(pl.shape) || ' from ' || (select string_agg(code || ' v' || version, ', ') from pieces where id = any (pl.source_piece_ids)) || '.',
                nullif(e ->> 'notes', ''),
                case when gaps is not null then E'Gaps the sources don''t cover (research these):\n' || gaps end,
                case when pl.instructions <> '' then 'Specific requirements: ' || pl.instructions end),
              auth.uid())
      returning id into new_id;
    insert into piece_contracts (piece_id, company_id, core_question)
      values (new_id, pl.company_id, case when pl.shape = 'split' then coalesce(e ->> 'heading', '') else '' end);
    insert into threads (company_id, piece_id, subject) values (pl.company_id, new_id, 'contract');
    select coalesce(array_agg(x::uuid), '{}') into items from jsonb_array_elements_text(coalesce(e -> 'item_ids', '[]'::jsonb)) x;
    perform carry_items(new_id, items);
    foreach src in array pl.source_piece_ids loop
      insert into piece_links (company_id, from_piece, to_piece, kind, created_by) values (pl.company_id, src, new_id, pl.shape, auth.uid());
    end loop;
    insert into piece_events (company_id, piece_id, actor, action, detail)
      values (pl.company_id, new_id, auth.uid(), 'piece_created',
              jsonb_build_object('repurpose', pl.shape, 'plan', pl.id, 'sources', pl.source_piece_ids, 'carried_items', coalesce(array_length(items, 1), 0)));
    perform enter_stage(new_id, 'contract');
    created := created || new_id;
  end loop;
  update repurpose_plans set status = 'created', created_pieces = created where id = pl.id;
  return created;
end;
$$;

update public.pieces set primary_keyword = ''
  where primary_keyword <> '' and (recipe #>> '{brief,keyword}') = 'false';
