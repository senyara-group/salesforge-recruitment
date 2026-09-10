-- Fondation filtres (PR A) — migration additive uniquement.
-- A appliquer manuellement sur Supabase. Ne droppe aucune colonne et ne touche pas deep_adn_*.
-- Aucun backfill depuis ADN approfondondi, bilan carrière, ou ai_cv_analyses.experience_years.

-- ============================================================
-- OFFRES : colonnes structurées nullable (legacy titre/type/lieu/salaire/tags conservés)
-- ============================================================
alter table public.offres add column if not exists job_type text;
alter table public.offres add column if not exists contract_type text;
alter table public.offres add column if not exists remote_mode text;
alter table public.offres add column if not exists salary_fixed_min integer;
alter table public.offres add column if not exists salary_fixed_max integer;
alter table public.offres add column if not exists has_variable boolean;
alter table public.offres add column if not exists variable_note text;
alter table public.offres add column if not exists sales_styles text[];
alter table public.offres add column if not exists sector text;
alter table public.offres add column if not exists customer_types text[];
alter table public.offres add column if not exists experience_min integer;
alter table public.offres add column if not exists experience_max integer;
alter table public.offres add column if not exists city_code text;
alter table public.offres add column if not exists latitude double precision;
alter table public.offres add column if not exists longitude double precision;

-- created_at : non prouvé dans les migrations du repo.
-- - ADD COLUMN IF NOT EXISTS si absente ;
-- - DEFAULT now() pour les NOUVELLES offres uniquement ;
-- - ne remplit PAS les NULL historiques (évite de falsifier la date de publication) ;
-- - reste nullable pendant la transition.
alter table public.offres add column if not exists created_at timestamptz;
alter table public.offres alter column created_at set default now();

-- ============================================================
-- CANDIDATS : colonnes sourcing déclaratives nullable
-- score_adn (ADN court) et axes.meta.competences restent les sources actuelles.
-- ============================================================
alter table public.candidats add column if not exists target_job_types text[];
alter table public.candidats add column if not exists sales_style text;
alter table public.candidats add column if not exists years_experience integer;
alter table public.candidats add column if not exists city_code text;
alter table public.candidats add column if not exists latitude double precision;
alter table public.candidats add column if not exists longitude double precision;
alter table public.candidats add column if not exists mobility_km integer;
alter table public.candidats add column if not exists desired_contracts text[];
alter table public.candidats add column if not exists sectors text[];
alter table public.candidats add column if not exists customer_types text[];
alter table public.candidats add column if not exists tools text[];
alter table public.candidats add column if not exists methodologies text[];
alter table public.candidats add column if not exists availability text;

-- ============================================================
-- Backfills déterministes uniquement (sinon NULL)
-- ============================================================

-- remote_mode = mode de travail uniquement (onsite | hybrid | remote).
-- "France entière" n'est PAS un remote_mode : lieu legacy conservé, remote_mode reste NULL.
update public.offres
set remote_mode = 'remote'
where remote_mode is null
  and lieu is not null
  and lower(lieu) like '%remote%';

-- contract_type = source canonique contrat (ne modifie PAS offres.type legacy)
update public.offres
set contract_type = 'CDI'
where contract_type is null
  and type is not null
  and lower(trim(type)) = 'cdi';

update public.offres
set contract_type = 'Alternance'
where contract_type is null
  and type is not null
  and lower(trim(type)) = 'alternance';

update public.offres
set contract_type = 'Mission'
where contract_type is null
  and type is not null
  and lower(trim(type)) = 'mission';

update public.offres
set contract_type = 'Freelance'
where contract_type is null
  and type is not null
  and lower(trim(type)) = 'freelance';

-- ============================================================
-- Index justifiés pour futures requêtes (pas de sur-indexation)
-- ============================================================
create index if not exists offres_statut_created_at_idx
  on public.offres (statut, created_at desc nulls last);

create index if not exists offres_type_idx
  on public.offres (type);

create index if not exists offres_contract_type_idx
  on public.offres (contract_type);

create index if not exists offres_remote_mode_idx
  on public.offres (remote_mode);

create index if not exists offres_salary_fixed_min_idx
  on public.offres (salary_fixed_min);

create index if not exists offres_job_type_idx
  on public.offres (job_type);

create index if not exists offres_sales_styles_gin_idx
  on public.offres using gin (sales_styles);

create index if not exists offres_customer_types_gin_idx
  on public.offres using gin (customer_types);

create index if not exists offres_tags_gin_idx
  on public.offres using gin (tags);

create index if not exists candidats_score_adn_idx
  on public.candidats (score_adn desc nulls last);

create index if not exists candidats_sales_style_idx
  on public.candidats (sales_style);

create index if not exists candidats_years_experience_idx
  on public.candidats (years_experience);

create index if not exists candidats_availability_idx
  on public.candidats (availability);

create index if not exists candidats_target_job_types_gin_idx
  on public.candidats using gin (target_job_types);

create index if not exists candidats_desired_contracts_gin_idx
  on public.candidats using gin (desired_contracts);

create index if not exists candidats_sectors_gin_idx
  on public.candidats using gin (sectors);

create index if not exists candidats_customer_types_gin_idx
  on public.candidats using gin (customer_types);

create index if not exists candidats_tools_gin_idx
  on public.candidats using gin (tools);

create index if not exists candidats_methodologies_gin_idx
  on public.candidats using gin (methodologies);
