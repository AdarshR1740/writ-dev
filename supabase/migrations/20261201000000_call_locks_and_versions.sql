-- Two more protections, on top of 20261129000000_edit_locks.sql and 20261130000000_lock_every_step.sql (both new; neither is edited).
--
-- 1. Call locks. Writ's own server functions ("Write using AI", the AI checks, research search) write with the service role, which
--    the lock triggers do not check. These functions let a server function take the same lock a tab would, as the person who
--    made the call and from that person's tab, before it spends time on the AI, and check again before it writes. They can only
--    be called by the service role.
-- 2. Step versions. Each step (scope, research, outline, final, and each section) records when it last changed and who changed it.
--    A reader (Claude through the MCP server) remembers the version it read, and refuses to save over a step that changed since.
--    This catches what a lock cannot: a change made after the other writer's lock had expired.

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Call locks
-- ---------------------------------------------------------------------------------------------------------------------------

-- A call can run next to another call from the same tab, and next to the tab's own edits. So a lock a call took counts the calls
-- using it, and is let go only by the last one, and only if the tab has not made it its own meanwhile (that changes the token).
alter table public.edit_locks
  add column calls integer not null default 0,
  add column by_call boolean not null default false;

-- Takes the lock for a server function that acts for one person. If that person's own tab (the same client) already holds the
-- lock, nothing changes hands: the call is only counted, and the tab keeps the lock when the call ends.
create function public.call_lock_acquire(
  target_piece uuid, lock_scope text, target_section uuid, client text, for_user uuid, lease_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  nil uuid := '00000000-0000-0000-0000-000000000000';
  sid uuid := coalesce(target_section, '00000000-0000-0000-0000-000000000000');
  who text;
  cur edit_locks;
  new_token uuid;
  lease interval := make_interval(secs => greatest(30, least(coalesce(lease_seconds, 300), 900)));
begin
  select * into p from pieces where id = target_piece;
  if p.id is null or for_user is null
     or not exists (select 1 from memberships m where m.company_id = p.company_id and m.user_id = for_user) then
    raise exception 'piece not found';
  end if;
  if lock_scope not in ('scope', 'research', 'outline', 'section', 'final') then raise exception 'unknown lock'; end if;
  if lock_scope = 'section' and target_section is null then raise exception 'name the section'; end if;
  if lock_scope <> 'section' then sid := nil; end if;
  if coalesce(trim(client), '') = '' then raise exception 'say which client is asking'; end if;
  select coalesce(nullif(trim(display_name), ''), email) into who from profiles where id = for_user;

  select * into cur from edit_locks where piece_id = target_piece and scope = lock_scope and section_id = sid;
  if cur.piece_id is not null and cur.expires_at > now() and cur.holder_client = client then
    -- The caller's own tab (or an earlier call from it) holds it. Count this call; the lock's own lease is not touched, so a tab
    -- that closes mid-call does not keep anyone out for longer than its lock already would.
    update edit_locks set calls = calls + 1
      where piece_id = target_piece and scope = lock_scope and section_id = sid;
    return jsonb_build_object('ok', true, 'token', cur.token);
  end if;

  insert into edit_locks (piece_id, scope, section_id, holder_client, holder_user, holder_kind, holder_label, token, acquired_at, expires_at, calls, by_call)
    values (target_piece, lock_scope, sid, client, for_user, 'person', coalesce(who, 'Someone'), gen_random_uuid(), now(), now() + lease, 1, true)
    on conflict (piece_id, scope, section_id) do update set
      holder_client = excluded.holder_client, holder_user = excluded.holder_user, holder_kind = excluded.holder_kind,
      holder_label = excluded.holder_label, token = excluded.token, expires_at = excluded.expires_at, acquired_at = now(),
      calls = 1, by_call = true
      where edit_locks.expires_at <= now()
    returning token into new_token;
  if new_token is not null then
    return jsonb_build_object('ok', true, 'token', new_token);
  end if;
  select * into cur from edit_locks where piece_id = target_piece and scope = lock_scope and section_id = sid;
  return jsonb_build_object('ok', false, 'holder_label', cur.holder_label, 'holder_kind', cur.holder_kind,
                            'since', cur.acquired_at, 'expires_at', cur.expires_at);
end;
$$;

-- A call is done with the lock. The last call out lets go of a lock a call took, unless the tab has made it its own since (taking
-- or renewing a lock gives it a new token, which then no longer matches). A lock the tab held all along is never released here.
create function public.call_lock_release(target_piece uuid, lock_scope text, target_section uuid, client text, lock_token uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid := case when lock_scope = 'section' then coalesce(target_section, '00000000-0000-0000-0000-000000000000')
                         else '00000000-0000-0000-0000-000000000000' end;
begin
  update edit_locks set calls = greatest(calls - 1, 0)
    where piece_id = target_piece and scope = lock_scope and section_id = sid and holder_client = client;
  delete from edit_locks
    where piece_id = target_piece and scope = lock_scope and section_id = sid
      and holder_client = client and calls = 0 and by_call and token = lock_token;
end;
$$;

-- Is this client still the one who may write? True when nobody else holds a live lock. Run right before a server function writes.
create function public.call_lock_check(target_piece uuid, lock_scope text, target_section uuid, client text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur edit_locks;
begin
  select * into cur from edit_locks
    where piece_id = target_piece and scope = lock_scope
      and section_id = case when lock_scope = 'section' then coalesce(target_section, '00000000-0000-0000-0000-000000000000')
                            else '00000000-0000-0000-0000-000000000000' end
      and expires_at > now();
  if cur.piece_id is not null and cur.holder_client is distinct from client then
    return jsonb_build_object('ok', false, 'holder_label', cur.holder_label, 'holder_kind', cur.holder_kind, 'since', cur.acquired_at);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.call_lock_acquire(uuid, text, uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.call_lock_release(uuid, text, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.call_lock_check(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.call_lock_acquire(uuid, text, uuid, text, uuid, integer) to service_role;
grant execute on function public.call_lock_release(uuid, text, uuid, text, uuid) to service_role;
grant execute on function public.call_lock_check(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Step versions
-- ---------------------------------------------------------------------------------------------------------------------------

-- One row per step that has changed: piece-wide steps use the nil section id, a section has its own row. No foreign key on the
-- piece: deleting a piece cascades into the tables below, and their triggers must not write a row for a piece that is going.
create table public.step_versions (
  piece_id uuid not null,
  scope text not null check (scope in ('scope', 'research', 'outline', 'section', 'final')),
  section_id uuid not null default '00000000-0000-0000-0000-000000000000',
  version timestamptz not null default clock_timestamp(),
  changed_by uuid,
  changed_by_label text not null default 'Someone',
  primary key (piece_id, scope, section_id)
);
alter table public.step_versions enable row level security;
create policy step_versions_read on public.step_versions for select
  using (is_member((select company_id from public.pieces p where p.id = step_versions.piece_id)));

-- Records that a step changed now, and who changed it: a person, Claude acting for a person (its client id starts with ai-), or
-- Writ's own AI (a server function, which has no signed-in user of its own).
create function public.bump_step_version(p_piece uuid, p_scope text, p_section uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  who text;
  label text;
begin
  if not exists (select 1 from pieces where id = p_piece) then return; end if;
  if auth.uid() is not null then
    select coalesce(nullif(trim(display_name), ''), email) into who from profiles where id = auth.uid();
    label := case when coalesce(request_client(), '') like 'ai-%' then 'Claude (for ' || coalesce(who, 'a writer') || ')'
                  else coalesce(who, 'Someone') end;
  else
    label := 'Writ AI';
  end if;
  insert into step_versions (piece_id, scope, section_id, version, changed_by, changed_by_label)
    values (p_piece, p_scope, coalesce(p_section, '00000000-0000-0000-0000-000000000000'), clock_timestamp(), auth.uid(), label)
    on conflict (piece_id, scope, section_id) do update set
      version = excluded.version, changed_by = excluded.changed_by, changed_by_label = excluded.changed_by_label;
end;
$$;

-- The piece: the same groups of columns the lock triggers use.
create function public.track_piece_versions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.analysis is distinct from old.analysis or new.outline_confirmed_at is distinct from old.outline_confirmed_at
     or new.title is distinct from old.title or new.primary_keyword is distinct from old.primary_keyword
     or new.seo_geo_outline is distinct from old.seo_geo_outline then
    perform bump_step_version(new.id, 'outline');
  end if;
  if new.topic is distinct from old.topic or new.goal is distinct from old.goal or new.audience_notes is distinct from old.audience_notes
     or new.format_id is distinct from old.format_id or new.section_timing is distinct from old.section_timing
     or new.recipe is distinct from old.recipe or new.brief_extra is distinct from old.brief_extra then
    perform bump_step_version(new.id, 'scope');
  end if;
  if new.final_check is distinct from old.final_check or new.final_text is distinct from old.final_text
     or new.seo_geo_final is distinct from old.seo_geo_final or new.customer_approval is distinct from old.customer_approval
     or new.signed_off_by is distinct from old.signed_off_by or new.signed_off_at is distinct from old.signed_off_at then
    perform bump_step_version(new.id, 'final');
  end if;
  return new;
end;
$$;
create trigger pieces_versions after update on public.pieces
  for each row execute function public.track_piece_versions();

-- The reader contract is the scope.
create function public.track_contract_versions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.core_question is distinct from old.core_question or new.expectations is distinct from old.expectations
     or new.confirmed_at is distinct from old.confirmed_at then
    perform bump_step_version(new.piece_id, 'scope');
  end if;
  return new;
end;
$$;
create trigger piece_contracts_versions after update on public.piece_contracts
  for each row execute function public.track_contract_versions();

-- Research: adding, changing and removing an item all count, so a deletion is seen too.
create function public.track_research_versions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform bump_step_version(case when tg_op = 'DELETE' then old.piece_id else new.piece_id end, 'research');
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger research_items_versions after insert or update or delete on public.research_items
  for each row execute function public.track_research_versions();

-- Sections: the shape of the outline is the outline's, a section's own work is the section's.
create function public.track_section_versions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform bump_step_version(new.piece_id, 'outline');
  elsif tg_op = 'DELETE' then
    perform bump_step_version(old.piece_id, 'outline');
  else
    if new.position is distinct from old.position or new.purpose is distinct from old.purpose
       or new.level is distinct from old.level or new.depth is distinct from old.depth
       or new.expectation_ids is distinct from old.expectation_ids or new.structure is distinct from old.structure
       or new.heading is distinct from old.heading then
      perform bump_step_version(new.piece_id, 'outline');
    end if;
    if new.heading is distinct from old.heading or new.content is distinct from old.content
       or new.ai_draft is distinct from old.ai_draft or new.brief is distinct from old.brief or new.points is distinct from old.points
       or new.grammar_check is distinct from old.grammar_check or new.fact_check is distinct from old.fact_check
       or new.contract_check is distinct from old.contract_check then
      perform bump_step_version(new.piece_id, 'section', old.id);
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger piece_sections_versions after insert or update or delete on public.piece_sections
  for each row execute function public.track_section_versions();

revoke execute on function public.bump_step_version(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.track_piece_versions() from public, anon, authenticated;
revoke execute on function public.track_contract_versions() from public, anon, authenticated;
revoke execute on function public.track_research_versions() from public, anon, authenticated;
revoke execute on function public.track_section_versions() from public, anon, authenticated;

-- Deleting a piece removes its version rows (there is no foreign key; see above).
create function public.purge_step_versions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from step_versions where piece_id = old.id;
  return old;
end;
$$;
create trigger pieces_purge_versions before delete on public.pieces
  for each row execute function public.purge_step_versions();
revoke execute on function public.purge_step_versions() from public, anon, authenticated;
