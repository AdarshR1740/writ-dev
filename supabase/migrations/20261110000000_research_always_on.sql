-- Research is available in every format (user decision). Its sub-settings
-- (web search, sources, review) stay configurable, and a piece can continue
-- without approved research (the provenance summary says so).

create function public.force_research(r jsonb) returns jsonb
language sql immutable as $$
  select case
    when coalesce((r #>> '{research,web_search}')::boolean, false) or coalesce((r #>> '{research,cards}')::boolean, false)
      or coalesce((r #>> '{research,library}')::boolean, false) or coalesce((r #>> '{research,manual}')::boolean, false)
    then jsonb_set(r, '{research,enabled}', 'true')
    else jsonb_set(jsonb_set(r, '{research,enabled}', 'true'), '{research,manual}', 'true')
  end
$$;

create function public.apply_research_always_on() returns trigger
language plpgsql as $$
begin
  new.recipe := force_research(new.recipe);
  return new;
end;
$$;
create trigger formats_research_on before insert or update of recipe on public.formats
  for each row execute function public.apply_research_always_on();
create trigger pieces_research_on before insert or update of recipe on public.pieces
  for each row execute function public.apply_research_always_on();

update public.formats set recipe = force_research(recipe);
update public.pieces set recipe = force_research(recipe) where stage in ('contract', 'research');

-- Continue past research with nothing approved: every item must still be
-- decided when review is on, but zero approved items is allowed.
create or replace function public.complete_piece_research(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  open_items integer;
  approved integer;
  reviewing boolean;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  reviewing := recipe_on(p.recipe, '{research,review}');
  select count(*) filter (where status = 'unreviewed'), count(*) filter (where status = 'approved')
    into open_items, approved
    from research_items where piece_id = target_piece and scope = 'piece';
  if reviewing and open_items > 0 then raise exception '% items still need a decision', open_items; end if;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'piece_research_completed',
            jsonb_build_object('approved', approved, 'reviewed', reviewing, 'without_research', approved = 0));
  if p.stage = 'research' then perform enter_stage(target_piece, 'outline'); end if;
end;
$$;

-- Combined pieces carry the plan's gaps into their brief, so research targets them.
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
              case when pl.shape = 'combine' then '' else first_src.primary_keyword end,
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

-- Sections can also move on without approved research.
create or replace function public.complete_section_research(target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
  r jsonb;
  open_items integer;
  approved integer;
  reviewing boolean;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  select recipe into r from pieces where id = s.piece_id;
  reviewing := recipe_on(r, '{research,review}');
  select count(*) filter (where status = 'unreviewed'), count(*) filter (where status = 'approved')
    into open_items, approved
    from research_items where piece_id = s.piece_id and scope = 'section' and section_key = s.id::text;
  if reviewing and open_items > 0 then raise exception '% items still need a decision', open_items; end if;
  update piece_sections set status = case when recipe_on(r, '{sections,brief}') then 'brief' else 'writing' end
    where id = s.id and status = 'research';
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_research_completed',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'approved', approved, 'reviewed', reviewing, 'without_research', approved = 0));
end;
$$;
