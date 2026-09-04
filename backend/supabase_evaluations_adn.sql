-- Historique des passages du test ADN (append-only, jamais d'update) — permet la
-- ré-évaluation semestrielle avec courbe d'évolution (palier Carrière Coaching),
-- sans perdre les résultats précédents comme le faisait l'ancien comportement
-- (POST /ai/score-adn écrasait candidats.axes.resultat à chaque passage).
create table if not exists public.evaluations_adn (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  score integer not null,
  resultat jsonb not null,
  reponses jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_evaluations_adn_user
  on public.evaluations_adn (user_id, created_at desc);

-- Typologie de poste choisie pendant le test (SDR, AE, KAM, terrain...), jusqu'ici
-- enterrée sans être relue dans axes.questionnaire.job_profile.poste. Colonne dédiée
-- pour permettre une requête groupée par typologie (benchmark anonymisé).
alter table public.candidats
  add column if not exists type_poste text;

create index if not exists idx_candidats_type_poste
  on public.candidats (type_poste)
  where type_poste is not null;
