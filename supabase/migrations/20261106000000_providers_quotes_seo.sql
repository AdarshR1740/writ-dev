-- ChatGPT (OpenAI) defaults, local OpenAI-compatible models, quote
-- verification for providers without API citations, the search-landscape
-- source type, and SEO/GEO checks.

-- Local models: an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM...).
alter table public.provider_keys drop constraint provider_keys_provider_check;
alter table public.provider_keys add constraint provider_keys_provider_check
  check (provider in ('anthropic', 'openai', 'gemini', 'local'));
alter table public.provider_keys add column base_url text;
alter table public.provider_keys add constraint provider_keys_local_url
  check ((provider = 'local') = (base_url is not null));

alter table public.model_overrides drop constraint model_overrides_provider_check;
alter table public.model_overrides add constraint model_overrides_provider_check
  check (provider in ('anthropic', 'openai', 'gemini', 'local'));

-- How a research item's quote was obtained:
--   cited       the provider's citation API returned the passage (Anthropic)
--   verified    the model quoted it and we found it verbatim in the source text
--   unverified  the model quoted it but we couldn't find it in the source
alter table public.research_items add column quote_status text not null default 'cited'
  check (quote_status in ('cited', 'verified', 'unverified'));

-- Search landscape: what ranking pages cover and skip, questions people ask, intent.
alter table public.research_items drop constraint research_items_source_type_check;
alter table public.research_items add constraint research_items_source_type_check check (source_type in (
  'card', 'original_research', 'official', 'practitioner', 'critical', 'data', 'web', 'serp'
));

-- Research can suggest contract changes; the writer decides.
-- (stored inside pieces.analysis as contract_suggestions)

-- SEO/GEO checks: on the outline and on the finished piece. Checklists, no score.
alter table public.pieces add column seo_geo_outline jsonb;
alter table public.pieces add column seo_geo_final jsonb;

-- The outline builds on the contract: it must be confirmed (again, if research
-- led the writer to change it).
create or replace function public.confirm_outline(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
  n integer;
begin
  select * into p from pieces where id = target_piece for update;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if p.stage <> 'outline' then raise exception 'finish research first'; end if;
  if not exists (select 1 from piece_contracts where piece_id = target_piece and confirmed_at is not null) then
    raise exception 'confirm the reader contract first (it was edited after research)';
  end if;
  select count(*) into n from piece_sections where piece_id = target_piece;
  if n = 0 then raise exception 'add at least one section first'; end if;
  update pieces set outline_confirmed_at = now(), stage = 'writing', updated_at = now() where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, target_piece, auth.uid(), 'outline_confirmed', jsonb_build_object('sections', n));
end;
$$;

-- Re-confirming the contract later in the piece must not move the stage back.
create or replace function public.confirm_contract(target_piece uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c piece_contracts;
begin
  select * into c from piece_contracts where piece_id = target_piece for update;
  if c.piece_id is null or not is_member(c.company_id) then raise exception 'piece not found'; end if;
  if trim(c.core_question) = '' then raise exception 'add the core question first'; end if;
  if jsonb_array_length(c.expectations) = 0 then raise exception 'add at least one expectation first'; end if;
  update piece_contracts set confirmed_at = now(), confirmed_by = auth.uid() where piece_id = target_piece;
  update pieces set stage = case when stage = 'contract' then 'research' else stage end, updated_at = now()
    where id = target_piece;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (c.company_id, target_piece, auth.uid(), 'contract_confirmed',
            jsonb_build_object('core_question', c.core_question, 'expectations', c.expectations));
end;
$$;
