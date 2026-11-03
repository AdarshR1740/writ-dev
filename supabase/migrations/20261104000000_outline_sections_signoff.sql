-- Slice 3: analysis, outline, sections (research -> review -> brief -> writing),
-- checks, sign-off and the transparency outputs.

-- Optional per company: when on, a named editor must sign off every piece.
alter table public.companies add column editorial_record boolean not null default false;
alter table public.companies add column disclosure_line text not null
  default 'Researched and drafted with AI assistance; written, reviewed and approved by our team.';

alter table public.pieces add column analysis jsonb;
alter table public.pieces add column outline_confirmed_at timestamptz;
alter table public.pieces add column final_check jsonb;
alter table public.pieces add column final_text text;
alter table public.pieces add column signed_off_by uuid references public.profiles (id);
alter table public.pieces add column signed_off_at timestamptz;

-- ---------------------------------------------------------------------------
-- Sections
-- ---------------------------------------------------------------------------

create table public.piece_sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  piece_id uuid not null references public.pieces (id) on delete cascade,
  position integer not null,
  heading text not null check (char_length(heading) between 1 and 300),
  purpose text not null default '',
  -- ids of the contract expectations this section is responsible for
  expectation_ids text[] not null default '{}',
  -- research -> brief -> writing -> written
  status text not null default 'research' check (status in ('research', 'brief', 'writing', 'written')),
  -- [{ "text": "...", "refs": [item ids] }]
  brief jsonb,
  content text not null default '',
  ai_draft text,
  written_by text check (written_by in ('writer', 'ai_then_writer')),
  contract_check jsonb,
  fact_check jsonb,
  updated_at timestamptz not null default now()
);
create index piece_sections_piece_idx on public.piece_sections (piece_id, position);

create trigger piece_sections_touch before update on public.piece_sections
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Replace the outline (only while it isn't confirmed).
create function public.save_outline(target_piece uuid, sections jsonb) returns void
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
    insert into piece_sections (company_id, piece_id, position, heading, purpose, expectation_ids)
      values (p.company_id, target_piece, i, trim(s ->> 'heading'), coalesce(s ->> 'purpose', ''),
              coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s -> 'expectation_ids', '[]'::jsonb)) x), '{}'));
  end loop;
end;
$$;

create function public.confirm_outline(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  n integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' then raise exception 'finish research first'; end if;
  select count(*) into n from piece_sections where piece_id = target_piece;
  if n = 0 then raise exception 'add at least one section first'; end if;
  update pieces set outline_confirmed_at = now(), stage = 'writing', updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'outline_confirmed', jsonb_build_object('sections', n));
end;
$$;

-- Close a section's research gate.
create function public.complete_section_research(target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
  open_items integer;
  approved integer;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  select count(*) filter (where status = 'unreviewed'), count(*) filter (where status = 'approved')
    into open_items, approved
    from research_items where piece_id = s.piece_id and scope = 'section' and section_key = s.id::text;
  if open_items > 0 then raise exception '% items still need a decision', open_items; end if;
  if approved = 0 then raise exception 'approve at least one item first'; end if;
  update piece_sections set status = 'brief' where id = s.id and status = 'research';
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_research_completed',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'approved', approved));
end;
$$;

-- Reuse an approved piece-level item in a section (already reviewed once).
create function public.use_piece_item(item uuid, target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r research_items;
  s piece_sections;
begin
  select * into r from research_items where id = item;
  select * into s from piece_sections where id = target_section;
  if r.id is null or s.id is null or r.piece_id <> s.piece_id or not is_member(s.company_id) then
    raise exception 'item not found';
  end if;
  if r.status <> 'approved' then raise exception 'only approved items can be reused'; end if;
  if exists (select 1 from research_items where piece_id = s.piece_id and scope = 'section'
             and section_key = s.id::text and statement = r.statement) then
    return;
  end if;
  insert into research_items (company_id, piece_id, scope, section_key, source_id, card_id, statement, quote,
                              source_type, secondary, status, edited, reviewed_by, reviewed_at)
    values (r.company_id, r.piece_id, 'section', s.id::text, r.source_id, r.card_id, r.statement, r.quote,
            r.source_type, r.secondary, 'approved', r.edited, auth.uid(), now());
end;
$$;

create function public.confirm_brief(target_section uuid, bullets jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  if s.status = 'research' then raise exception 'finish this section''s research first'; end if;
  if jsonb_typeof(bullets) <> 'array' or jsonb_array_length(bullets) = 0 then raise exception 'the brief is empty'; end if;
  update piece_sections set brief = bullets, status = case when status = 'brief' then 'writing' else status end
    where id = s.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'brief_confirmed', jsonb_build_object('section', s.id, 'bullets', jsonb_array_length(bullets)));
end;
$$;

-- Mark a section written; records whether the writer or the AI drafted it.
create function public.complete_section(target_section uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s piece_sections;
begin
  select * into s from piece_sections where id = target_section for update;
  if s.id is null or not is_member(s.company_id) then raise exception 'section not found'; end if;
  if s.status not in ('writing', 'written') then raise exception 'confirm the brief first'; end if;
  if trim(s.content) = '' then raise exception 'the section is empty'; end if;
  update piece_sections set status = 'written',
    written_by = case when ai_draft is null then 'writer' else 'ai_then_writer' end
    where id = s.id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (s.company_id, s.piece_id, auth.uid(), 'section_written',
            jsonb_build_object('section', s.id, 'heading', s.heading, 'ai_drafted', s.ai_draft is not null));
end;
$$;

-- Sign off. Needs every section written and a final contract check. When the
-- company keeps an editorial record, only an editor can sign off.
create function public.sign_off(target_piece uuid, final_version text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  needs_editor boolean;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'writing' then raise exception 'the piece isn''t ready for sign-off'; end if;
  if exists (select 1 from piece_sections where piece_id = target_piece and status <> 'written') then
    raise exception 'every section must be written first';
  end if;
  if p.final_check is null then raise exception 'run the final contract check first'; end if;
  select editorial_record into needs_editor from companies where id = p.company_id;
  if needs_editor and not is_editor(p.company_id) then raise exception 'only an editor can sign off'; end if;
  update pieces set stage = 'done', signed_off_by = auth.uid(), signed_off_at = now(),
    final_text = coalesce(nullif(trim(final_version), ''), final_text), updated_at = now()
    where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'signed_off', jsonb_build_object('final_text_pasted', final_version is not null));
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.piece_sections enable row level security;

create policy piece_sections_select on public.piece_sections for select to authenticated using (is_member(company_id));
-- Members edit the writing and the brief draft; status moves only through the functions above.
create policy piece_sections_update on public.piece_sections for update to authenticated
  using (is_member(company_id)) with check (is_member(company_id));

create function public.guard_section_status() returns trigger
language plpgsql as $$
begin
  -- Inside the security-definer functions current_user is the owner, so only
  -- direct client updates are checked here.
  if current_user = 'authenticated' and new.status is distinct from old.status
     and not (old.status = 'written' and new.status = 'writing') then
    raise exception 'section status changes go through the review steps';
  end if;
  return new;
end;
$$;
create trigger piece_sections_guard before update on public.piece_sections
  for each row execute function public.guard_section_status();

grant execute on function public.save_outline(uuid, jsonb) to authenticated;
grant execute on function public.confirm_outline(uuid) to authenticated;
grant execute on function public.complete_section_research(uuid) to authenticated;
grant execute on function public.use_piece_item(uuid, uuid) to authenticated;
grant execute on function public.confirm_brief(uuid, jsonb) to authenticated;
grant execute on function public.complete_section(uuid) to authenticated;
grant execute on function public.sign_off(uuid, text) to authenticated;
revoke execute on function public.save_outline(uuid, jsonb) from anon;
revoke execute on function public.confirm_outline(uuid) from anon;
revoke execute on function public.complete_section_research(uuid) from anon;
revoke execute on function public.use_piece_item(uuid, uuid) from anon;
revoke execute on function public.confirm_brief(uuid, jsonb) from anon;
revoke execute on function public.complete_section(uuid) from anon;
revoke execute on function public.sign_off(uuid, text) from anon;
