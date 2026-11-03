-- Workflow recipes per format, snapshotted on each piece. Stages and section
-- steps a recipe switches off are skipped automatically.

-- Keep in sync with LONG_FORM in web/src/lib/recipes.ts (a test checks it).
create function public.default_recipe() returns jsonb
language sql immutable as $$
  select '{"base":"long_form","brief":{"keyword":true,"goal":true,"audience":true,"customer":false,"offer":false},"contract":{"mode":"full","ai_thread":true},"research":{"enabled":true,"web_search":true,"max_searches":6,"serp":true,"cards":true,"library":true,"manual":true,"review":true},"analysis":{"enabled":true,"tensions":true,"insight_vs_consensus":true,"gaps":true,"contract_suggestions":true},"outline":{"mode":"free","template":[],"ai_thread":true,"seo_geo_check":true},"sections":{"research":true,"timing":"just_in_time","reuse_piece_items":true,"brief":true},"writing":{"ai_draft":true},"checks":{"grammar":true,"fact":true,"contract":true,"seo":true,"geo":true,"customer_approval":false},"signoff":{"required":true,"editor_required":false,"final_paste":true,"learn":true}}'::jsonb
$$;

alter table public.formats add column recipe jsonb not null default public.default_recipe();
alter table public.pieces add column recipe jsonb not null default public.default_recipe();
-- Brief fields some recipes add: customer and approval contact, offer and CTA.
alter table public.pieces add column brief_extra jsonb not null default '{}'::jsonb;
alter table public.pieces add column customer_approval jsonb;

-- Only editors change a format's recipe.
create function public.guard_format_recipe() returns trigger
language plpgsql as $$
begin
  if current_user = 'authenticated' and new.recipe is distinct from old.recipe and not is_editor(new.company_id) then
    raise exception 'only editors can change a format''s workflow';
  end if;
  return new;
end;
$$;
create trigger formats_guard_recipe before update on public.formats
  for each row execute function public.guard_format_recipe();

create function public.recipe_on(r jsonb, path text[]) returns boolean
language sql immutable as $$ select coalesce((r #>> path)::boolean, false) $$;

-- Where a new section starts, given the recipe.
create function public.first_section_status(r jsonb) returns text
language sql immutable as $$
  select case
    when recipe_on(r, '{sections,research}') then 'research'
    when recipe_on(r, '{sections,brief}') then 'brief'
    else 'writing'
  end
$$;

-- Move a piece to the first enabled stage at or after `target`, setting up
-- whatever a skipped stage would have produced (e.g. a single section).
create function public.enter_stage(target_piece uuid, target text) returns text
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  r jsonb;
  next_stage text := target;
  exp_ids text[];
  h text;
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
        insert into piece_sections (company_id, piece_id, position, heading, expectation_ids, status)
          values (p.company_id, p.id, 1, p.title, coalesce(exp_ids, '{}'), first_section_status(r));
      end if;
      update pieces set outline_confirmed_at = coalesce(outline_confirmed_at, now()) where id = p.id;
      next_stage := 'writing';
    elsif r #>> '{outline,mode}' = 'fixed' and not exists (select 1 from piece_sections where piece_id = p.id) then
      for h in select jsonb_array_elements_text(r -> 'outline' -> 'template') loop
        i := i + 1;
        insert into piece_sections (company_id, piece_id, position, heading, status)
          values (p.company_id, p.id, i, h, first_section_status(r));
      end loop;
    end if;
  end if;
  update pieces set stage = next_stage, updated_at = now() where id = p.id;
  return next_stage;
end;
$$;

-- Research items are auto-approved when the recipe switches review off.
create function public.auto_approve_items() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'unreviewed'
     and exists (select 1 from pieces where id = new.piece_id and not recipe_on(recipe, '{research,review}')) then
    new.status := 'approved';
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;
create trigger research_items_auto_approve before insert on public.research_items
  for each row execute function public.auto_approve_items();

-- ---------------------------------------------------------------------------
-- Stage functions, now recipe-aware
-- ---------------------------------------------------------------------------

drop function public.create_piece(uuid, text, text, text, uuid, text, text, text);
create function public.create_piece(
  target_company uuid, piece_title text, piece_topic text, keyword text,
  format uuid, piece_goal text, audience text, timing text, extra jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
  r jsonb;
begin
  if not is_member(target_company) then raise exception 'not a member of this company'; end if;
  if format is not null then
    select recipe into r from formats where id = format and company_id = target_company;
    if r is null then raise exception 'format not found'; end if;
  else
    r := default_recipe();
  end if;
  insert into pieces (company_id, title, topic, primary_keyword, format_id, goal, audience_notes, section_timing,
                      recipe, brief_extra, created_by)
    values (target_company, trim(piece_title), coalesce(piece_topic, ''), coalesce(keyword, ''), format,
            coalesce(piece_goal, ''), coalesce(audience, ''),
            coalesce(nullif(timing, ''), r #>> '{sections,timing}', 'just_in_time'), r, coalesce(extra, '{}'), auth.uid())
    returning id into new_id;
  insert into piece_contracts (piece_id, company_id) values (new_id, target_company);
  insert into threads (company_id, piece_id, subject) values (target_company, new_id, 'contract');
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (target_company, new_id, auth.uid(), 'piece_created', jsonb_build_object('recipe', r));
  perform enter_stage(new_id, 'contract');
  return new_id;
end;
$$;

create or replace function public.confirm_contract(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c piece_contracts;
  p pieces;
  max_exp integer;
begin
  select * into c from piece_contracts where piece_id = target_piece for update;
  if c.piece_id is null or not is_member(c.company_id) then raise exception 'piece not found'; end if;
  select * into p from pieces where id = target_piece;
  if trim(c.core_question) = '' then raise exception 'add the core question first'; end if;
  if jsonb_array_length(c.expectations) = 0 then raise exception 'add at least one expectation first'; end if;
  max_exp := case when p.recipe #>> '{contract,mode}' = 'lite' then 2 else 7 end;
  if jsonb_array_length(c.expectations) > max_exp then
    raise exception 'this format allows at most % expectations', max_exp;
  end if;
  update piece_contracts set confirmed_at = now(), confirmed_by = auth.uid() where piece_id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (c.company_id, target_piece, auth.uid(), 'contract_confirmed',
            jsonb_build_object('core_question', c.core_question, 'expectations', c.expectations));
  if p.stage = 'contract' then perform enter_stage(target_piece, 'research'); end if;
end;
$$;

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
  if reviewing and approved = 0 then raise exception 'approve at least one item first'; end if;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'piece_research_completed',
            jsonb_build_object('approved', approved, 'reviewed', reviewing));
  if p.stage = 'research' then perform enter_stage(target_piece, 'outline'); end if;
end;
$$;

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
    insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids, status)
      values (p.company_id, target_piece, i, trim(s ->> 'heading'), coalesce(s ->> 'purpose', ''),
              coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'),
              first_section_status(p.recipe));
  end loop;
end;
$$;

create or replace function public.confirm_outline(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  n integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' then raise exception 'finish the earlier steps first'; end if;
  if p.recipe #>> '{contract,mode}' <> 'off'
     and not exists (select 1 from piece_contracts where piece_id = target_piece and confirmed_at is not null) then
    raise exception 'confirm the reader contract first (it was edited after research)';
  end if;
  select count(*) into n from piece_sections where piece_id = target_piece;
  if n = 0 then raise exception 'add at least one section first'; end if;
  update pieces set outline_confirmed_at = now(), stage = 'writing', updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'outline_confirmed', jsonb_build_object('sections', n));
end;
$$;

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
  if reviewing and approved = 0 then raise exception 'approve at least one item first'; end if;
  update piece_sections set status = case when recipe_on(r, '{sections,brief}') then 'brief' else 'writing' end
    where id = s.id and status = 'research';
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_research_completed',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'approved', approved, 'reviewed', reviewing));
end;
$$;

-- Case studies: who at the customer approved, and when.
create function public.record_customer_approval(target_piece uuid, approver text, note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if trim(coalesce(approver, '')) = '' then raise exception 'name the person who approved it'; end if;
  update pieces set customer_approval = jsonb_build_object(
    'approver', trim(approver), 'note', coalesce(note, ''), 'recorded_by', auth.uid(), 'recorded_at', now())
    where id = p.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, p.id, auth.uid(), 'customer_approval_recorded', jsonb_build_object('approver', trim(approver), 'note', note));
end;
$$;

-- Sign-off follows the recipe: which checks it needs, whether an editor must
-- sign, or (when sign-off is switched off) simply marking the piece done.
create or replace function public.sign_off(target_piece uuid, final_version text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  r jsonb;
  needs_editor boolean;
  company_record boolean;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  r := p.recipe;
  if p.stage <> 'writing' then raise exception 'the piece isn''t ready for sign-off'; end if;
  if exists (select 1 from piece_sections where piece_id = target_piece and status <> 'written') then
    raise exception 'every section must be written first';
  end if;
  if recipe_on(r, '{checks,contract}') and p.final_check is null then raise exception 'run the final contract check first'; end if;
  if recipe_on(r, '{checks,customer_approval}') and p.customer_approval is null then
    raise exception 'record the customer''s approval first';
  end if;
  select editorial_record into company_record from companies where id = p.company_id;
  needs_editor := company_record or (recipe_on(r, '{signoff,required}') and recipe_on(r, '{signoff,editor_required}'));
  if needs_editor and not is_editor(p.company_id) then raise exception 'only an editor can sign off'; end if;
  update pieces set stage = 'done', signed_off_by = auth.uid(), signed_off_at = now(),
    final_text = coalesce(nullif(trim(final_version), ''), final_text), updated_at = now()
    where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(),
            case when recipe_on(r, '{signoff,required}') or company_record then 'signed_off' else 'marked_done' end,
            jsonb_build_object('final_text_pasted', final_version is not null));
end;
$$;

grant execute on function public.create_piece(uuid, text, text, text, uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.record_customer_approval(uuid, text, text) to authenticated;
revoke execute on function public.create_piece(uuid, text, text, text, uuid, text, text, text, jsonb) from anon;
revoke execute on function public.record_customer_approval(uuid, text, text) from anon;
revoke execute on function public.enter_stage(uuid, text) from public, anon, authenticated;
