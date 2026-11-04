-- Accounts created before the migrations were applied have no profile row, because
-- profiles are made by a trigger at sign-up. Backfill them, and make create_company
-- create the caller's profile if it is still missing.
insert into public.profiles (id, email, display_name)
select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'display_name', split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;

create or replace function public.create_company(company_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into profiles (id, email, display_name)
    select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'display_name', split_part(u.email, '@', 1))
    from auth.users u where u.id = auth.uid()
    on conflict (id) do nothing;
  insert into companies (name, created_by) values (trim(company_name), auth.uid()) returning id into new_id;
  insert into memberships (company_id, user_id, role) values (new_id, auth.uid(), 'editor');
  insert into context_documents (company_id, kind)
    select new_id, k from unnest(array['icp', 'positioning', 'strategy_notes', 'core_voice']) as k;
  return new_id;
end;
$$;
