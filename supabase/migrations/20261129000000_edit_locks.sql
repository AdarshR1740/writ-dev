-- Edit locks: one person or one Claude at a time on the outline, and on each section's text.
--
-- A lock is a short lease taken on the first edit and renewed while work goes on; it frees itself a few minutes after the
-- last activity, so a closed tab or a finished chat never leaves a piece stuck. Two scopes:
--   outline  the structure: sections, their order, levels, purposes, scope points, the benchmark, confirming
--   section  one section's text, brief, talking points and heading
-- Reading is never locked. The holder is a client (one browser tab, or one Claude connection), not just a person, so two of
-- your own tabs cannot overwrite each other either.
--
-- The lock is enforced here, in the database, so no client can walk past it: triggers refuse a change by someone who is not the
-- holder while a live lock is held by someone else. A client says who it is with the header x-writ-client. A change with no lock
-- held by anyone else goes through as before, so older clients keep working until a lock is actually in the way.
-- Writes made by Writ's own server functions (the service role, for example "Write using AI") are not checked.

create table public.edit_locks (
  piece_id uuid not null references public.pieces (id) on delete cascade,
  scope text not null check (scope in ('outline', 'section')),
  -- all zeros for the outline lock
  section_id uuid not null default '00000000-0000-0000-0000-000000000000',
  holder_client text not null,
  holder_user uuid references public.profiles (id) on delete set null,
  holder_kind text not null check (holder_kind in ('person', 'ai')),
  holder_label text not null,
  -- changes on every take or renewal: letting go with an old token does nothing, so a slow release can't undo a newer lock
  token uuid not null default gen_random_uuid(),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (piece_id, scope, section_id)
);
alter table public.edit_locks enable row level security;
create policy edit_locks_select on public.edit_locks for select to authenticated
  using (is_member((select company_id from public.pieces p where p.id = edit_locks.piece_id)));
-- No insert, update or delete policies: locks change only through the functions below.
grant select on public.edit_locks to authenticated;

-- Who is asking: the client id header, and the role of the signed-in request ('authenticated' for a person's own client).
create function public.request_client() returns text
language sql stable as $$
  select case when coalesce(current_setting('request.headers', true), '') = '' then null
              else nullif(current_setting('request.headers', true)::json ->> 'x-writ-client', '') end
$$;

create function public.request_role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '')
$$;

-- Take (or renew) a lock. Returns { ok: true, token, expires_at } or, when someone else holds it,
-- { ok: false, holder_*, since, expires_at }. take_over replaces a live holder; it is recorded in the piece's activity.
create function public.acquire_lock(
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
  if lock_scope not in ('outline', 'section') then raise exception 'a lock is on the outline or a section'; end if;
  if lock_scope = 'section' and target_section is null then raise exception 'name the section'; end if;
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

  -- Take it only if it is free, expired, or already this client's. When two clients ask at the same moment for a lock nobody
  -- holds, the unique key lets one insert win and the other's update condition fails, so only one of them gets a row back.
  insert into edit_locks (piece_id, scope, section_id, holder_client, holder_user, holder_kind, holder_label, token, acquired_at, expires_at)
    values (target_piece, lock_scope, sid, client, auth.uid(), kind, label, gen_random_uuid(), now(), now() + lease)
    on conflict (piece_id, scope, section_id) do update set
      holder_client = excluded.holder_client, holder_user = excluded.holder_user, holder_kind = excluded.holder_kind,
      holder_label = excluded.holder_label, token = excluded.token, expires_at = excluded.expires_at,
      -- a renewal keeps the time the holder first took the lock
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

-- Let go of a lock. With a token, only the lock that token belongs to is released (a slow release can't undo a newer lock).
create function public.release_lock(target_piece uuid, lock_scope text, target_section uuid, client text, lock_token uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare p pieces;
begin
  select * into p from pieces where id = target_piece;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  delete from edit_locks
    where piece_id = target_piece and scope = lock_scope
      and section_id = coalesce(target_section, '00000000-0000-0000-0000-000000000000') and holder_client = client
      and (lock_token is null or token = lock_token);
end;
$$;

-- Refuses when a live lock on this scope is held by a different client than the one asking. Used by the triggers below.
create function public.assert_unlocked(target_piece uuid, lock_scope text, target_section uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  l edit_locks;
  me text := request_client();
begin
  select * into l from edit_locks
    where piece_id = target_piece and scope = lock_scope
      and section_id = coalesce(target_section, '00000000-0000-0000-0000-000000000000') and expires_at > now();
  if l.piece_id is not null and l.holder_client is distinct from me then
    raise exception 'edit_locked: % is editing this % (since % UTC)', l.holder_label,
      case when lock_scope = 'outline' then 'outline' else 'section' end, to_char(l.acquired_at at time zone 'utc', 'HH24:MI');
  end if;
end;
$$;

-- A change to a section's structure needs the outline lock; a change to its text, heading, brief or points needs the section's lock.
create function public.guard_section_locks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lock_scope text;
  sid uuid := null;
  pid uuid;
  both boolean := false;
begin
  -- Not a person's own request, or a cascade (deleting a piece deletes its sections): nothing to check.
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
          or new.ai_draft is distinct from old.ai_draft or new.brief is distinct from old.brief or new.points is distinct from old.points then
      lock_scope := 'section'; sid := old.id;
      -- A heading changed on its own is both: the section's own work (its H2 in the Writing step) and a change to the outline
      -- (a rename in the outline editor). Neither lock may be held by someone else.
      both := new.heading is distinct from old.heading and new.content is not distinct from old.content
        and new.ai_draft is not distinct from old.ai_draft and new.brief is not distinct from old.brief and new.points is not distinct from old.points;
    else
      return new;
    end if;
  end if;
  perform assert_unlocked(pid, lock_scope, sid);
  if both then perform assert_unlocked(pid, 'outline', null); end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger piece_sections_locks before insert or update or delete on public.piece_sections
  for each row execute function public.guard_section_locks();

-- The benchmark and confirming or reopening the outline are outline work too.
create function public.guard_piece_locks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if request_role() = 'authenticated'
     and (new.analysis is distinct from old.analysis or new.outline_confirmed_at is distinct from old.outline_confirmed_at) then
    perform assert_unlocked(new.id, 'outline', null);
  end if;
  return new;
end;
$$;
create trigger pieces_locks before update on public.pieces
  for each row execute function public.guard_piece_locks();

-- assert_unlocked is for the triggers only (they run as the function owner), so no client may call it.
revoke execute on function public.assert_unlocked(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.acquire_lock(uuid, text, uuid, text, text, boolean, integer) from public, anon;
revoke execute on function public.release_lock(uuid, text, uuid, text, uuid) from public, anon;
grant execute on function public.acquire_lock(uuid, text, uuid, text, text, boolean, integer) to authenticated;
grant execute on function public.release_lock(uuid, text, uuid, text, uuid) to authenticated;
