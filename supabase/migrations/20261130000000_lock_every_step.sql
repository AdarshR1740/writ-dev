-- Edit locks on every step of a piece, not only the outline and the sections.
--
-- 20261129000000_edit_locks.sql locked the outline and each section's text. The other steps were open: while a writer typed in
-- the scope, Claude could save over it. Now each step has its own lock, enforced here in the database as before:
--   scope     the reader's question and points, and the piece's setup (topic, goal, audience, format, recipe, brief)
--   research  the piece's research items: adding, reviewing, finishing
--   outline   (as before) plus the title, the keyword and the outline's SEO/GEO check
--   section   (as before) plus the section's grammar, fact and contract check results
--   final     the final check, the SEO/GEO final check, customer approval, the final text and the sign-off
-- Same rules as before: a lock is a short lease; a change by the holder, or when nobody else holds it, goes through; Writ's own
-- server functions (the service role, e.g. "Write using AI") are not checked.
-- This file is new: the earlier migration is already applied and is not edited.

-- 1. More kinds of lock. Only the outline kind and the section kind existed.
alter table public.edit_locks drop constraint edit_locks_scope_check;
alter table public.edit_locks add constraint edit_locks_scope_check
  check (scope in ('scope', 'research', 'outline', 'section', 'final'));

-- 2. Taking a lock: the new kinds are piece-wide, like the outline (no section id).
create or replace function public.acquire_lock(
  target_piece uuid, lock_scope text, target_section uuid, client text, kind text,
  take_over boolean default false, lease_seconds integer default 180
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  sid uuid := coalesce(target_section, '00000000-0000-0000-0000-000000000000');
  who text;
  label text;
  cur edit_locks;
  new_token uuid;
  lease interval := make_interval(secs => greatest(30, least(coalesce(lease_seconds, 180), 900)));
begin
  select * into p from pieces where id = target_piece;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if lock_scope not in ('scope', 'research', 'outline', 'section', 'final') then
    raise exception 'a lock is on the scope, the research, the outline, a section or the final checks';
  end if;
  if lock_scope = 'section' and target_section is null then raise exception 'name the section'; end if;
  if lock_scope <> 'section' then sid := '00000000-0000-0000-0000-000000000000'; end if;
  if lock_scope = 'section' and not exists (select 1 from piece_sections where id = target_section and piece_id = target_piece) then
    raise exception 'section not found';
  end if;
  if kind not in ('person', 'ai') then raise exception 'a lock is held by a person or by Claude'; end if;
  if coalesce(trim(client), '') = '' then raise exception 'say which client is asking'; end if;
  select coalesce(nullif(trim(display_name), ''), email) into who from profiles where id = auth.uid();
  label := case when kind = 'ai' then 'Claude (for ' || coalesce(who, 'a writer') || ')' else coalesce(who, 'Someone') end;

  delete from edit_locks where expires_at < now() - interval '1 day';

  if take_over then
    select * into cur from edit_locks where piece_id = target_piece and scope = lock_scope and section_id = sid;
    if cur.piece_id is not null and cur.expires_at > now() and cur.holder_client <> client then
      insert into piece_events (company_id, piece_id, actor, action, detail)
        values (p.company_id, p.id, auth.uid(), 'lock_taken_over',
                jsonb_build_object('scope', lock_scope, 'section', target_section, 'from', cur.holder_label, 'to', label));
    end if;
    insert into edit_locks (piece_id, scope, section_id, holder_client, holder_user, holder_kind, holder_label, token, acquired_at, expires_at)
      values (target_piece, lock_scope, sid, client, auth.uid(), kind, label, gen_random_uuid(), now(), now() + lease)
      on conflict (piece_id, scope, section_id) do update set
        holder_client = excluded.holder_client, holder_user = excluded.holder_user, holder_kind = excluded.holder_kind,
        holder_label = excluded.holder_label, token = excluded.token, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      returning token into new_token;
    return jsonb_build_object('ok', true, 'token', new_token, 'expires_at', now() + lease);
  end if;

  insert into edit_locks (piece_id, scope, section_id, holder_client, holder_user, holder_kind, holder_label, token, acquired_at, expires_at)
    values (target_piece, lock_scope, sid, client, auth.uid(), kind, label, gen_random_uuid(), now(), now() + lease)
    on conflict (piece_id, scope, section_id) do update set
      holder_client = excluded.holder_client, holder_user = excluded.holder_user, holder_kind = excluded.holder_kind,
      holder_label = excluded.holder_label, token = excluded.token, expires_at = excluded.expires_at,
      acquired_at = case when edit_locks.holder_client = excluded.holder_client and edit_locks.expires_at > now() then edit_locks.acquired_at else now() end
      where edit_locks.expires_at <= now() or edit_locks.holder_client = excluded.holder_client
    returning token into new_token;
  if new_token is not null then
    return jsonb_build_object('ok', true, 'token', new_token, 'expires_at', now() + lease);
  end if;
  select * into cur from edit_locks where piece_id = target_piece and scope = lock_scope and section_id = sid;
  return jsonb_build_object('ok', false, 'holder_label', cur.holder_label, 'holder_kind', cur.holder_kind,
                            'since', cur.acquired_at, 'expires_at', cur.expires_at);
end;
$$;

-- 3. The refusal names what is locked ("the scope", "the research", ...), not only "outline" or "section".
create or replace function public.assert_unlocked(target_piece uuid, lock_scope text, target_section uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  l edit_locks;
  me text := request_client();
begin
  select * into l from edit_locks
    where piece_id = target_piece and scope = lock_scope
      and section_id = coalesce(target_section, '00000000-0000-0000-0000-000000000000') and expires_at > now();
  if l.piece_id is not null and l.holder_client is distinct from me then
    raise exception 'edit_locked: % is editing % (since % UTC)', l.holder_label,
      case lock_scope when 'outline' then 'this outline' when 'scope' then 'this scope' when 'research' then 'this piece''s research'
                      when 'final' then 'the final checks and sign-off' else 'this section' end,
      to_char(l.acquired_at at time zone 'utc', 'HH24:MI');
  end if;
end;
$$;

-- 4. A section's check results belong to the section's own lock. The rest of the trigger is as before.
create or replace function public.guard_section_locks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lock_scope text;
  sid uuid := null;
  pid uuid;
  also_outline boolean := false;
begin
  if request_role() <> 'authenticated' or pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    pid := new.piece_id; lock_scope := 'outline';
  elsif tg_op = 'DELETE' then
    pid := old.piece_id; lock_scope := 'outline';
  else
    pid := new.piece_id;
    if new.position is distinct from old.position or new.purpose is distinct from old.purpose
       or new.level is distinct from old.level or new.depth is distinct from old.depth
       or new.expectation_ids is distinct from old.expectation_ids or new.structure is distinct from old.structure then
      lock_scope := 'outline';
    elsif new.heading is distinct from old.heading or new.content is distinct from old.content
          or new.ai_draft is distinct from old.ai_draft or new.brief is distinct from old.brief or new.points is distinct from old.points
          or new.grammar_check is distinct from old.grammar_check or new.fact_check is distinct from old.fact_check
          or new.contract_check is distinct from old.contract_check then
      lock_scope := 'section'; sid := old.id;
      also_outline := new.heading is distinct from old.heading and new.content is not distinct from old.content
        and new.ai_draft is not distinct from old.ai_draft and new.brief is not distinct from old.brief and new.points is not distinct from old.points
        and new.grammar_check is not distinct from old.grammar_check and new.fact_check is not distinct from old.fact_check
        and new.contract_check is not distinct from old.contract_check;
    else
      return new;
    end if;
  end if;
  perform assert_unlocked(pid, lock_scope, sid);
  if also_outline then perform assert_unlocked(pid, 'outline', null); end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- 5. The piece itself: setup is scope work, title and keyword and the outline check are outline work, the rest is the final step.
create or replace function public.guard_piece_locks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if request_role() = 'authenticated' then
    if new.analysis is distinct from old.analysis or new.outline_confirmed_at is distinct from old.outline_confirmed_at
       or new.title is distinct from old.title or new.primary_keyword is distinct from old.primary_keyword
       or new.seo_geo_outline is distinct from old.seo_geo_outline then
      perform assert_unlocked(new.id, 'outline', null);
    end if;
    if new.topic is distinct from old.topic or new.goal is distinct from old.goal or new.audience_notes is distinct from old.audience_notes
       or new.format_id is distinct from old.format_id or new.section_timing is distinct from old.section_timing
       or new.recipe is distinct from old.recipe or new.brief_extra is distinct from old.brief_extra then
      perform assert_unlocked(new.id, 'scope', null);
    end if;
    if new.final_check is distinct from old.final_check or new.final_text is distinct from old.final_text
       or new.seo_geo_final is distinct from old.seo_geo_final or new.customer_approval is distinct from old.customer_approval
       or new.signed_off_by is distinct from old.signed_off_by or new.signed_off_at is distinct from old.signed_off_at then
      perform assert_unlocked(new.id, 'final', null);
    end if;
  end if;
  return new;
end;
$$;

-- 6. The reader contract (the scope's question and points) needs the scope lock.
create function public.guard_contract_locks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if request_role() = 'authenticated' and pg_trigger_depth() <= 1
     and (new.core_question is distinct from old.core_question or new.expectations is distinct from old.expectations
          or new.confirmed_at is distinct from old.confirmed_at) then
    perform assert_unlocked(new.piece_id, 'scope', null);
  end if;
  return new;
end;
$$;
create trigger piece_contracts_locks before update on public.piece_contracts
  for each row execute function public.guard_contract_locks();

-- 7. Research items need the research lock to be added, changed or removed. A cascade (deleting a piece) is not checked.
create function public.guard_research_locks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if request_role() = 'authenticated' and pg_trigger_depth() <= 1 then
    perform assert_unlocked(case when tg_op = 'DELETE' then old.piece_id else new.piece_id end, 'research', null);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger research_items_locks before insert or update or delete on public.research_items
  for each row execute function public.guard_research_locks();

revoke execute on function public.guard_contract_locks() from public, anon, authenticated;
revoke execute on function public.guard_research_locks() from public, anon, authenticated;
