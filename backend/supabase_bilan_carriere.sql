-- Questionnaire ADN approfondi (74 items, palier Carrière) — spécification fournie
-- par Yannis, 2026-09. Table VOLONTAIREMENT séparée de `candidats`/`evaluations_adn` :
-- "Les résultats du questionnaire approfondi sont stockés dans une table séparée,
-- sans jointure possible depuis les requêtes de matching." Aucune route de
-- matching/deck/recruteur ne doit jamais lire cette table.
create table if not exists public.bilans_carriere (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  type_poste text,
  style_vente text,
  reponses jsonb not null,
  scores jsonb not null,
  restitution jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bilans_carriere_user
  on public.bilans_carriere (user_id, created_at desc);

-- Benchmark anonymisé par typologie de poste, même principe de seuil que
-- GET /candidats/benchmark (k>=5 côté application, pas en SQL).
create index if not exists idx_bilans_carriere_type_poste
  on public.bilans_carriere (type_poste)
  where type_poste is not null;
