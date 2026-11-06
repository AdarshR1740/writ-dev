-- Whether this person sees AI costs on screens other than AI provider & models. Follows the account across devices.
-- Everyone can already update their own profile row (profiles_update), so no new policy is needed.
alter table public.profiles add column show_ai_costs boolean not null default true;
