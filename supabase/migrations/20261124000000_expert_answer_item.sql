-- Adds an insight card to a piece's research as an approved item, for an expert's answer to a gap in the alignment
-- check. A function, not a plain insert, because the insert policy on research_items only accepts 'unreviewed' rows
-- and the auto-approve trigger can already have changed the status by the time the policy is checked.
create function public.add_answer_to_research(target_piece uuid, card uuid, item_quote text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  c cards;
  item_id uuid;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  select * into c from cards where id = card and company_id = p.company_id;
  if c.id is null then raise exception 'card not found'; end if;
  if exists (select 1 from research_items where piece_id = p.id and card_id = c.id and scope = 'piece') then
    raise exception 'this answer is already in the research';
  end if;

  insert into research_items (company_id, piece_id, scope, card_id, statement, quote, source_type,
                              status, reviewed_by, reviewed_at)
    values (p.company_id, p.id, 'piece', c.id, left(c.claim, 1200), coalesce(item_quote, ''), 'card',
            'approved', auth.uid(), now())
    returning id into item_id;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, p.id, auth.uid(), 'research_approved',
            jsonb_build_object('item', item_id, 'edited', false, 'from', 'expert_answer'));
  return item_id;
end;
$$;

grant execute on function public.add_answer_to_research(uuid, uuid, text) to authenticated;
revoke execute on function public.add_answer_to_research(uuid, uuid, text) from anon;
