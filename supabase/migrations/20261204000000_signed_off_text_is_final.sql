-- The text of a signed-off piece is final. The sign-off page lets the writer edit the text until the piece is approved; after
-- that the screen shows it read-only, and this makes the database refuse the same edit from anywhere else (another tab, the MCP
-- server). A change after approval is a revision: revise_piece starts a new piece from it.
--
-- Only the text and heading of a section are guarded. Check results and bookkeeping columns are left alone. Calls made from inside
-- the security-definer functions (the pg_trigger_depth() test, as in guard_section_locks) are not affected.

create or replace function public.guard_signed_off_text() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if request_role() <> 'authenticated' or pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.content is distinct from old.content or new.heading is distinct from old.heading then
    if exists (select 1 from pieces where id = new.piece_id and stage = 'done') then
      raise exception 'this piece is signed off; its text can no longer be edited. Revise it instead';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_signed_off_text() from public, anon, authenticated;

drop trigger if exists piece_sections_signed_off_text on public.piece_sections;
create trigger piece_sections_signed_off_text before update on public.piece_sections
  for each row execute function public.guard_signed_off_text();
