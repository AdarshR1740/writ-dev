-- History, revisions and repurposing.
--   * Every piece gets a readable ID per company (e.g. NW-0042) and a version.
--   * Revising tags the old version and links it to the new one.
--   * Repurposing (split / adapt / combine) creates pieces from a confirmed plan,
--     with carried research that stays approved and an outline seed.
--   * Pieces get a review date on a fixed schedule after sign-off.

alter table public.companies add column code_prefix text;
alter table public.companies add column piece_seq integer not null default 0;
alter table public.companies add column review_interval_months integer not null default 12
  check (review_interval_months between 1 and 60);

-- Prefix from the company's initials (Northwind Logistics -> NL), at least 2 letters.
create function public.company_prefix(company_name text) returns text
language sql immutable as $$
  select upper(coalesce(nullif(
    case when array_length(regexp_split_to_array(trim(company_name), '\s+'), 1) > 1
      then (select string_agg(left(w, 1), '') from unnest(regexp_split_to_array(trim(company_name), '\s+')) w where w ~ '^[A-Za-z0-9]')
      else left(regexp_replace(company_name, '[^A-Za-z0-9]', '', 'g'), 2)
    end, ''), 'PC'))
$$;
update public.companies set code_prefix = left(company_prefix(name), 4) where code_prefix is null;

alter table public.pieces add column code text;
alter table public.pieces add column version integer not null default 1;
-- The first version's id; all versions of a piece share it.
alter table public.pieces add column lineage_id uuid;
-- Set on the old version when a revision is started.
alter table public.pieces add column revised_by uuid references public.pieces (id) on delete set null;
alter table public.pieces add column review_due_at date;
alter table public.pieces add column last_reviewed_at timestamptz;
-- Sections to start the outline with (from a repurpose plan).
alter table public.pieces add column outline_seed jsonb;
-- Notes the plan passed on, shown in the brief (angle, gaps, specific requirements).
alter table public.pieces add column origin_notes text not null default '';

alter table public.research_items add column carried_from uuid references public.research_items (id) on delete set null;

-- Give existing pieces IDs.
do $$
declare
  p record;
  n integer;
begin
  for p in select id, company_id from pieces where code is null order by created_at loop
    update companies set piece_seq = piece_seq + 1 where id = p.company_id returning piece_seq into n;
    update pieces set code = (select code_prefix from companies where id = p.company_id) || '-' || lpad(n::text, 4, '0'),
      lineage_id = id where id = p.id;
  end loop;
end;
$$;
create unique index pieces_code_version on public.pieces (company_id, code, version);

create table public.piece_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  from_piece uuid not null references public.pieces (id) on delete cascade,
  to_piece uuid not null references public.pieces (id) on delete cascade,
  kind text not null check (kind in ('revision', 'split', 'adapt', 'combine')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (from_piece, to_piece)
);
create index piece_links_to_idx on public.piece_links (to_piece);
create index piece_links_from_idx on public.piece_links (from_piece);

create table public.repurpose_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  shape text not null check (shape in ('split', 'adapt', 'combine')),
  target_format_id uuid not null references public.formats (id) on delete cascade,
  source_piece_ids uuid[] not null check (array_length(source_piece_ids, 1) >= 1),
  instructions text not null default '',
  -- { entries: [{ heading, angle, notes, item_ids, source_sections }], not_translated: [], gaps: [] }
  proposal jsonb,
  status text not null default 'draft' check (status in ('draft', 'created')),
  created_pieces uuid[] not null default '{}',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
create index repurpose_plans_company_idx on public.repurpose_plans (company_id, created_at desc);

alter table public.piece_links enable row level security;
alter table public.repurpose_plans enable row level security;
create policy piece_links_select on public.piece_links for select to authenticated using (is_member(company_id));
create policy repurpose_plans_select on public.repurpose_plans for select to authenticated using (is_member(company_id));
create policy repurpose_plans_insert on public.repurpose_plans for insert to authenticated
  with check (is_member(company_id) and created_by = auth.uid() and status = 'draft'
    and exists (select 1 from formats f where f.id = target_format_id and f.company_id = repurpose_plans.company_id)
    and not exists (select 1 from unnest(source_piece_ids) sp where not exists (
      select 1 from pieces p where p.id = sp and p.company_id = repurpose_plans.company_id)));
create policy repurpose_plans_update on public.repurpose_plans for update to authenticated
  using (is_member(company_id) and status = 'draft') with check (is_member(company_id) and status = 'draft');

-- ---------------------------------------------------------------------------
-- IDs on create, review date on sign-off, seeds on entering the outline
-- ---------------------------------------------------------------------------

create function public.assign_piece_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n integer;
  prefix text;
begin
  if new.code is null then
    update companies set piece_seq = piece_seq + 1,
      code_prefix = coalesce(code_prefix, left(company_prefix(name), 4))
      where id = new.company_id returning piece_seq, code_prefix into n, prefix;
    new.code := prefix || '-' || lpad(n::text, 4, '0');
    new.version := 1;
  end if;
  new.lineage_id := coalesce(new.lineage_id, new.id);
  return new;
end;
$$;
create trigger pieces_assign_code before insert on public.pieces
  for each row execute function public.assign_piece_code();

create function public.set_review_due() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage = 'done' and old.stage is distinct from 'done' then
    new.review_due_at := (now() + make_interval(months => (select review_interval_months from companies where id = new.company_id)))::date;
  end if;
  return new;
end;
$$;
create trigger pieces_review_due before update on public.pieces
  for each row execute function public.set_review_due();

-- Outline seeds (from a repurpose plan) fill the outline like a fixed template.
create or replace function public.enter_stage(target_piece uuid, target text) returns text
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  r jsonb;
  next_stage text := target;
  exp_ids text[];
  h jsonb;
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
        -- A revision of a single-section piece keeps its text to edit.
        insert into piece_sections (company_id, piece_id, position, heading, expectation_ids, content, status)
          values (p.company_id, p.id, 1, p.title, coalesce(exp_ids, '{}'),
                  coalesce((select string_agg(seed_el ->> 'content', E'\n\n') from jsonb_array_elements(coalesce(p.outline_seed, '[]'::jsonb)) seed_el), ''),
                  first_section_status(r));
      end if;
      update pieces set outline_confirmed_at = coalesce(outline_confirmed_at, now()) where id = p.id;
      next_stage := 'writing';
    elsif not exists (select 1 from piece_sections where piece_id = p.id) then
      if p.outline_seed is not null and jsonb_array_length(p.outline_seed) > 0 then
        for h in select * from jsonb_array_elements(p.outline_seed) loop
          i := i + 1;
          insert into piece_sections (company_id, piece_id, position, heading, purpose, content, status)
            values (p.company_id, p.id, i, coalesce(h ->> 'heading', 'Section ' || i), coalesce(h ->> 'purpose', ''),
                    coalesce(h ->> 'content', ''), first_section_status(r));
        end loop;
      elsif r #>> '{outline,mode}' = 'fixed' then
        for h in select to_jsonb(t) from jsonb_array_elements_text(r -> 'outline' -> 'template') t loop
          i := i + 1;
          insert into piece_sections (company_id, piece_id, position, heading, status)
            values (p.company_id, p.id, i, h #>> '{}', first_section_status(r));
        end loop;
      end if;
    end if;
  end if;
  update pieces set stage = next_stage, updated_at = now() where id = p.id;
  return next_stage;
end;
$$;

-- Copy approved items into a piece as carried (approved, no second review).
create function public.carry_items(target_piece uuid, item_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  n integer;
begin
  select * into p from pieces where id = target_piece;
  insert into research_items (company_id, piece_id, scope, source_id, card_id, statement, quote, source_type, secondary,
                              quote_status, status, edited, reviewed_by, reviewed_at, carried_from)
    select p.company_id, p.id, 'piece', r.source_id, r.card_id, r.statement, r.quote, r.source_type, r.secondary,
           r.quote_status, 'approved', r.edited, r.reviewed_by, r.reviewed_at, r.id
      from research_items r
     where r.id = any (item_ids) and r.company_id = p.company_id and r.status = 'approved'
       and not exists (select 1 from research_items x where x.piece_id = p.id and x.carried_from = r.id);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.carry_items(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Revisions
-- ---------------------------------------------------------------------------

create function public.revise_piece(source_piece uuid, use_current_recipe boolean, carry uuid[] default '{}') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s pieces;
  r jsonb;
  new_id uuid;
  latest integer;
  sec piece_sections;
begin
  select * into s from pieces where id = source_piece;
  if s.id is null or not is_member(s.company_id) then raise exception 'piece not found'; end if;
  if s.stage <> 'done' then raise exception 'only finished pieces can be revised'; end if;
  r := s.recipe;
  if use_current_recipe and s.format_id is not null then
    select recipe into r from formats where id = s.format_id;
  end if;
  select max(version) into latest from pieces where company_id = s.company_id and code = s.code;

  insert into pieces (company_id, title, topic, primary_keyword, format_id, goal, audience_notes, section_timing, recipe,
                      brief_extra, code, version, lineage_id, outline_seed, origin_notes, created_by)
    values (s.company_id, s.title, s.topic, s.primary_keyword, s.format_id, s.goal, s.audience_notes, s.section_timing, r,
            s.brief_extra, s.code, latest + 1, s.lineage_id,
            (select jsonb_agg(jsonb_build_object('heading', heading, 'purpose', purpose, 'content', content) order by position)
               from piece_sections where piece_id = s.id),
            'Revision of ' || s.code || ' v' || s.version || '.', auth.uid())
    returning id into new_id;

  insert into piece_contracts (piece_id, company_id, core_question, expectations)
    select new_id, company_id, core_question, expectations from piece_contracts where piece_id = s.id;
  insert into threads (company_id, piece_id, subject) values (s.company_id, new_id, 'contract');
  perform carry_items(new_id, carry);

  update pieces set revised_by = new_id where id = s.id;
  insert into piece_links (company_id, from_piece, to_piece, kind, created_by) values (s.company_id, s.id, new_id, 'revision', auth.uid());
  insert into piece_events (company_id, piece_id, actor, action, detail) values
    (s.company_id, s.id, auth.uid(), 'revised', jsonb_build_object('new_version', latest + 1, 'new_piece', new_id)),
    (s.company_id, new_id, auth.uid(), 'piece_created',
     jsonb_build_object('revision_of', s.id, 'from_version', s.version, 'recipe', case when use_current_recipe then 'current' else 'original' end,
                        'carried_items', coalesce(array_length(carry, 1), 0)));
  perform enter_stage(new_id, 'contract');
  return new_id;
end;
$$;

-- Due pieces: mark reviewed (next date) without revising.
create function public.mark_reviewed(target_piece uuid, note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'done' then raise exception 'only finished pieces are reviewed this way'; end if;
  update pieces set last_reviewed_at = now(),
    review_due_at = (now() + make_interval(months => (select review_interval_months from companies where id = p.company_id)))::date
    where id = p.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, p.id, auth.uid(), 'reviewed_still_current', jsonb_build_object('note', note));
end;
$$;

-- ---------------------------------------------------------------------------
-- Repurposing: create pieces from a confirmed plan
-- entries: [{ heading, angle, notes, item_ids: [uuid], sections: [{heading, purpose}] }]
-- ---------------------------------------------------------------------------

create function public.create_from_plan(plan uuid, entries jsonb) returns uuid[]
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
begin
  select * into pl from repurpose_plans where id = plan for update;
  if pl.id is null or not is_member(pl.company_id) then raise exception 'plan not found'; end if;
  if pl.status <> 'draft' then raise exception 'this plan was already used'; end if;
  if jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) = 0 then raise exception 'the plan has no pieces to create'; end if;
  if pl.shape <> 'split' and jsonb_array_length(entries) <> 1 then raise exception 'adapt and combine create exactly one piece'; end if;
  select * into f from formats where id = pl.target_format_id;
  select * into first_src from pieces where id = pl.source_piece_ids[1];

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

grant execute on function public.revise_piece(uuid, boolean, uuid[]) to authenticated;
grant execute on function public.mark_reviewed(uuid, text) to authenticated;
grant execute on function public.create_from_plan(uuid, jsonb) to authenticated;
revoke execute on function public.revise_piece(uuid, boolean, uuid[]) from anon;
revoke execute on function public.mark_reviewed(uuid, text) from anon;
revoke execute on function public.create_from_plan(uuid, jsonb) from anon;
