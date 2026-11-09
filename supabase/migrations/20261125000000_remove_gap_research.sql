-- Removes research items that a search for a gap (alignment check) added, when the writer undoes those fixes.
-- Only for items of this piece's own research, and only while the outline is still open; returns how many went.
create function public.remove_gap_research(target_piece uuid, item_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  n integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' or p.outline_confirmed_at is not null then
    raise exception 'research can only be removed this way before the outline is confirmed';
  end if;
  delete from research_items where piece_id = target_piece and scope = 'piece' and id = any (coalesce(item_ids, '{}'));
  get diagnostics n = row_count;
  if n > 0 then
    insert into piece_events (company_id, piece_id, actor, action, detail)
      values (p.company_id, target_piece, auth.uid(), 'gap_research_removed', jsonb_build_object('items', n));
  end if;
  return n;
end;
$$;

grant execute on function public.remove_gap_research(uuid, uuid[]) to authenticated;
revoke execute on function public.remove_gap_research(uuid, uuid[]) from anon;
