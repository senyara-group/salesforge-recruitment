-- Extension additive du contrat IA candidat. À appliquer manuellement avant le code.
alter table public.ai_cv_analyses
  add column if not exists experience_years numeric,
  add column if not exists sector text not null default '';

alter table public.ai_cv_analyses
  drop constraint if exists ai_cv_analyses_experience_years_check;
alter table public.ai_cv_analyses
  add constraint ai_cv_analyses_experience_years_check
  check (experience_years is null or (experience_years >= 0 and experience_years <= 80));

alter table public.ai_cv_analyses
  drop constraint if exists ai_cv_analyses_sector_check;
alter table public.ai_cv_analyses
  add constraint ai_cv_analyses_sector_check check (char_length(sector) <= 120);

-- Préserve les conversations historiques "simulation" et ajoute le mode Yannis.
alter table public.ai_conversations
  drop constraint if exists ai_conversations_mode_check;
alter table public.ai_conversations
  add constraint ai_conversations_mode_check
  check (mode in ('interview', 'objections', 'pitch', 'simulation'));

notify pgrst, 'reload schema';
