-- Reset one piece to the very start of Scope, for testing. Run it by hand in the Supabase dashboard (SQL Editor).
-- It keeps the piece itself (title, topic, keyword, goal, notes, recipe) and clears everything built on it:
-- the scope points, all research items, the outline, the saved alignment check and the AI conversations.
-- The piece's history of events is kept. Sources and insight cards in your library are not touched.
-- This cannot be undone. Change the id on the next line to reset a different piece.
do $$
declare
  pid uuid := 'ed95a257-826e-4234-94ba-138743a5dc4e'; -- SI-0012
begin
  if not exists (select 1 from pieces where id = pid) then
    raise exception 'no piece with that id';
  end if;

  delete from piece_sections where piece_id = pid;
  delete from research_items where piece_id = pid;
  -- Every conversation is emptied, but the Scope conversation itself stays: the Scope step expects it to exist.
  delete from thread_messages where thread_id in (select id from threads where piece_id = pid);
  delete from threads where piece_id = pid and subject <> 'contract';
  insert into threads (company_id, piece_id, subject)
    select company_id, id, 'contract' from pieces
     where id = pid and not exists (select 1 from threads where piece_id = pid and subject = 'contract');

  update piece_contracts
     set core_question = '', expectations = '[]'::jsonb, confirmed_at = null, confirmed_by = null, updated_at = now()
   where piece_id = pid;

  update pieces
     set stage = 'contract',
         analysis = null,
         outline_confirmed_at = null,
         outline_seed = null,
         seo_geo_outline = null,
         seo_geo_final = null,
         final_check = null,
         final_text = null,
         memory_check = null,
         updated_at = now()
   where id = pid;
end $$;
