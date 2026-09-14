-- Offres Yannis non-géo : skills dédiées + part de variable structurée.
-- Additive / idempotente. À appliquer manuellement dans Supabase. NE PAS backfiller.
-- Ne touche pas candidats, deep ADN, score_adn, axes, tags legacy, geo.

alter table public.offres
  add column if not exists skills text[];

alter table public.offres
  add column if not exists variable_share text;

comment on column public.offres.skills is
  'Compétences clés Yannis V1 (Closing, Cold calling, …). Distinct de tags legacy.';

comment on column public.offres.variable_share is
  'Part de variable structurée : low | balanced | majority. Ne pas déduire de variable_note.';

create index if not exists offres_skills_gin
  on public.offres using gin (skills);

create index if not exists offres_variable_share_idx
  on public.offres (variable_share);
