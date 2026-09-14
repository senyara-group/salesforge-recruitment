-- Skills déclaratives candidat (Yannis V1) — migration additive uniquement.
-- À appliquer manuellement dans Supabase. Ne droppe rien, ne touche pas axes / deep ADN.
-- Pas de backfill : axes.meta.competences reste le fallback lecture.

alter table public.candidats
  add column if not exists skills text[];

comment on column public.candidats.skills is
  'Compétences déclaratives Yannis V1 (Closing, Cold calling, …). Distinct des axes ADN court et de axes.meta.competences (legacy).';

create index if not exists candidats_skills_gin
  on public.candidats using gin (skills);
