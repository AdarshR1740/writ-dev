-- Export (files, formatted copy, WordPress drafts) and spending controls.

-- ---------------------------------------------------------------------------
-- Spending controls: a monthly budget per company, on its own AI key.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column monthly_budget_usd numeric(10, 2) check (monthly_budget_usd is null or monthly_budget_usd > 0),
  add column budget_alert_pct integer not null default 80 check (budget_alert_pct between 1 and 100),
  add column budget_hard_limit boolean not null default false;

-- Cost per piece, for agencies billing by piece. Null for house-file tasks.
alter table public.usage_events add column piece_id uuid references public.pieces (id) on delete set null;
create index usage_events_piece_idx on public.usage_events (piece_id) where piece_id is not null;

-- Spend this calendar month (UTC). Members can see it; the functions use it to enforce the limit.
create function public.month_spend(target uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0) from usage_events
  where company_id = target and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
    and (is_member(target) or auth.role() = 'service_role');
$$;
grant execute on function public.month_spend(uuid) to authenticated;
revoke execute on function public.month_spend(uuid) from anon;

-- ---------------------------------------------------------------------------
-- Export: WordPress as a publishing target, and an export record per piece.
-- ---------------------------------------------------------------------------
create table public.publishing_targets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null check (kind in ('wordpress')),
  site_url text not null,
  username text not null,
  key_hint text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (company_id, kind)
);
-- The application password, encrypted by the publish function. No policies: only the service role reads it.
create table public.publishing_target_secrets (
  target_id uuid primary key references public.publishing_targets (id) on delete cascade,
  ciphertext text not null,
  iv text not null
);
alter table public.publishing_targets enable row level security;
alter table public.publishing_target_secrets enable row level security;
create policy publishing_targets_select on public.publishing_targets for select to authenticated using (is_member(company_id));
-- Writes go through the publish function (editors only), which checks the credentials first.

-- Downloads and copies happen in the browser; this keeps them in the piece's record.
create function public.record_export(target_piece uuid, export_kind text, export_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p pieces;
begin
  select * into p from pieces where id = target_piece;
  if p.id is null or not is_member(p.company_id) then raise exception 'piece not found'; end if;
  if export_kind not in ('docx', 'html', 'markdown', 'copy', 'wordpress') then raise exception 'unknown export'; end if;
  insert into piece_events (company_id, piece_id, actor, action, detail)
    values (p.company_id, p.id, auth.uid(), 'exported', jsonb_build_object('kind', export_kind) || coalesce(export_detail, '{}'::jsonb));
end;
$$;
grant execute on function public.record_export(uuid, text, jsonb) to authenticated;
revoke execute on function public.record_export(uuid, text, jsonb) from anon;
