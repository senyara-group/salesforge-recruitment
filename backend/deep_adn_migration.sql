-- ADN approfondi Yannis V1. Migration additive : ne modifie aucun résultat ADN court.
create table if not exists public.deep_adn_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  questionnaire_version text not null,
  scoring_version text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  presentation jsonb not null,
  result jsonb,
  consistency_flags jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check ((status = 'in_progress' and completed_at is null and result is null)
    or (status = 'completed' and completed_at is not null and result is not null))
);

create table if not exists public.deep_adn_answers (
  assessment_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  question_id text not null,
  option_id text not null,
  answered_at timestamptz not null default now(),
  primary key (assessment_id, question_id),
  foreign key (assessment_id, user_id)
    references public.deep_adn_assessments(id, user_id) on delete cascade
);

create index if not exists idx_deep_adn_assessments_owner_history
  on public.deep_adn_assessments(user_id, completed_at desc, created_at desc);
create index if not exists idx_deep_adn_answers_owner
  on public.deep_adn_answers(user_id, assessment_id);

alter table public.deep_adn_assessments enable row level security;
alter table public.deep_adn_answers enable row level security;

drop policy if exists deep_adn_assessments_owner_select on public.deep_adn_assessments;
create policy deep_adn_assessments_owner_select on public.deep_adn_assessments
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists deep_adn_answers_owner_select on public.deep_adn_answers;
create policy deep_adn_answers_owner_select on public.deep_adn_answers
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.deep_adn_assessments from anon;
revoke all on public.deep_adn_answers from anon;
revoke insert, update, delete on public.deep_adn_assessments from authenticated;
revoke insert, update, delete on public.deep_adn_answers from authenticated;
grant select on public.deep_adn_assessments to authenticated;
grant select on public.deep_adn_answers to authenticated;

notify pgrst, 'reload schema';
