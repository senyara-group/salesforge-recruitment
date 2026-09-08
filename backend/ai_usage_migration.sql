-- Quotas IA mensuels candidat. À appliquer manuellement dans Supabase avant déploiement.
create extension if not exists pgcrypto;

create table if not exists public.ai_monthly_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  cv_used integer not null default 0 check (cv_used >= 0),
  coach_used integer not null default 0 check (coach_used >= 0),
  extra_cv_credits integer not null default 0 check (extra_cv_credits >= 0),
  extra_coach_credits integer not null default 0 check (extra_coach_credits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start),
  check (period_end > period_start)
);

create table if not exists public.ai_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  feature text not null check (feature in ('cv', 'coach')),
  expires_at timestamptz not null default (now() + interval '3 minutes'),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (user_id, period_start) references public.ai_monthly_usage(user_id, period_start) on delete cascade
);

alter table public.ai_usage_reservations
  add column if not exists finalized_at timestamptz;

create index if not exists ai_usage_reservations_active_idx
  on public.ai_usage_reservations (user_id, period_start, feature, expires_at);

create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (feature in ('cv', 'coach')),
  model text not null default '',
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_eur numeric(12,6) check (estimated_cost_eur is null or estimated_cost_eur >= 0),
  resource_type text check (resource_type is null or resource_type in ('cv_analysis', 'conversation_message')),
  resource_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_user_created_idx
  on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_monthly_usage enable row level security;
alter table public.ai_usage_reservations enable row level security;
alter table public.ai_usage_events enable row level security;

drop policy if exists "Users read own AI usage" on public.ai_monthly_usage;
create policy "Users read own AI usage" on public.ai_monthly_usage for select using (auth.uid() = user_id);
drop policy if exists "Users read own AI usage events" on public.ai_usage_events;
create policy "Users read own AI usage events" on public.ai_usage_events for select using (auth.uid() = user_id);

revoke all on public.ai_monthly_usage, public.ai_usage_reservations, public.ai_usage_events from anon;
revoke all on public.ai_monthly_usage, public.ai_usage_reservations, public.ai_usage_events from authenticated;
grant select on public.ai_monthly_usage, public.ai_usage_events to authenticated;

create or replace function public.reserve_ai_usage(
  p_user_id uuid, p_feature text, p_period_start date, p_period_end date, p_base_limit integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_usage public.ai_monthly_usage; v_reserved integer; v_id uuid;
begin
  if p_feature not in ('cv', 'coach') or p_base_limit < 0 then raise exception 'invalid quota reservation'; end if;
  insert into public.ai_monthly_usage(user_id, period_start, period_end)
    values (p_user_id, p_period_start, p_period_end)
    on conflict (user_id, period_start) do update set period_end = excluded.period_end;
  select * into v_usage from public.ai_monthly_usage
    where user_id = p_user_id and period_start = p_period_start for update;
  delete from public.ai_usage_reservations where expires_at <= now();
  select count(*) into v_reserved from public.ai_usage_reservations
    where user_id = p_user_id and period_start = p_period_start and feature = p_feature
      and finalized_at is null and expires_at > now();
  if (case when p_feature='cv' then v_usage.cv_used else v_usage.coach_used end) + v_reserved >=
     p_base_limit + (case when p_feature='cv' then v_usage.extra_cv_credits else v_usage.extra_coach_credits end)
  then return null; end if;
  insert into public.ai_usage_reservations(user_id, period_start, feature)
    values (p_user_id, p_period_start, p_feature) returning id into v_id;
  return v_id;
end $$;

create or replace function public.finalize_ai_usage(
  p_reservation_id uuid, p_model text, p_input_tokens integer, p_output_tokens integer,
  p_estimated_cost_eur numeric, p_resource_type text default null, p_resource_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_res public.ai_usage_reservations;
begin
  select * into v_res from public.ai_usage_reservations
    where id = p_reservation_id for update;
  if v_res.id is null then return false; end if;
  if v_res.finalized_at is not null then return true; end if;
  update public.ai_monthly_usage set
    cv_used = cv_used + case when v_res.feature='cv' then 1 else 0 end,
    coach_used = coach_used + case when v_res.feature='coach' then 1 else 0 end,
    updated_at = now()
    where user_id=v_res.user_id and period_start=v_res.period_start;
  insert into public.ai_usage_events(user_id,feature,model,input_tokens,output_tokens,estimated_cost_eur,resource_type,resource_id)
    values(v_res.user_id,v_res.feature,coalesce(p_model,''),p_input_tokens,p_output_tokens,p_estimated_cost_eur,p_resource_type,p_resource_id);
  update public.ai_usage_reservations set finalized_at = now()
    where id = p_reservation_id;
  return true;
end $$;

create or replace function public.release_ai_usage(p_reservation_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  delete from public.ai_usage_reservations
    where id=p_reservation_id and finalized_at is null returning true;
$$;

revoke all on function public.reserve_ai_usage(uuid,text,date,date,integer) from public, anon, authenticated;
revoke all on function public.finalize_ai_usage(uuid,text,integer,integer,numeric,text,uuid) from public, anon, authenticated;
revoke all on function public.release_ai_usage(uuid) from public, anon, authenticated;
grant execute on function public.reserve_ai_usage(uuid,text,date,date,integer) to service_role;
grant execute on function public.finalize_ai_usage(uuid,text,integer,integer,numeric,text,uuid) to service_role;
grant execute on function public.release_ai_usage(uuid) to service_role;

notify pgrst, 'reload schema';
