-- Snapshot of the production Supabase column types (PostgREST OpenAPI, 2026-10-08).
-- Only the tables used by brevo_outbox_migration.sql, with their real column types.
-- Defaults with casts and the CHECK/UNIQUE constraints below are not exposed by OpenAPI:
-- they come from the checked-in migrations (recruitment_integrity_migration.sql,
-- matchs_candidat_offre_unique_migration.sql) and their presence in production is assumed.
create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null,
  created_at timestamp with time zone default now()
);
create table public.candidats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  nom text,
  prenom text,
  titre text,
  score_adn integer,
  axes jsonb,
  cv_url text,
  created_at timestamp with time zone default now(),
  swipes_meta jsonb,
  contacts_meta jsonb,
  last_login_at timestamp with time zone,
  type_poste text,
  target_job_types text[],
  sales_style text,
  years_experience integer,
  city_code text,
  latitude double precision,
  longitude double precision,
  mobility_km integer,
  desired_contracts text[],
  sectors text[],
  customer_types text[],
  tools text[],
  methodologies text[],
  availability text,
  skills text[]
);
create table public.recruteurs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  entreprise text,
  secteur text,
  plan text default 'starter',
  created_at timestamp with time zone default now(),
  matching jsonb,
  questions jsonb,
  avatar_meta jsonb,
  last_login_at timestamp with time zone
);
create table public.offres (
  id uuid primary key default gen_random_uuid(),
  recruteur_id uuid references public.recruteurs(id),
  titre text not null,
  type text,
  lieu text,
  salaire text,
  tags jsonb,
  statut text default 'actif',
  auto_candidature boolean default true,
  created_at timestamp with time zone default now(),
  description text,
  job_type text,
  contract_type text,
  remote_mode text,
  salary_fixed_min integer,
  salary_fixed_max integer,
  has_variable boolean,
  variable_note text,
  sales_styles text[],
  sector text,
  customer_types text[],
  experience_min integer,
  experience_max integer,
  city_code text,
  latitude double precision,
  longitude double precision,
  skills text[],
  variable_share text
);
create table public.candidatures (
  id uuid primary key default gen_random_uuid(),
  candidat_id uuid references public.candidats(id),
  offre_id uuid references public.offres(id),
  statut text default 'envoyee',
  lettre_type text,
  created_at timestamp with time zone default now(),
  snapshot jsonb not null default '{}'::jsonb,
  withdrawn_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  internal_note text default '' not null
);
create table public.matchs (
  id uuid primary key default gen_random_uuid(),
  candidat_id uuid references public.candidats(id),
  offre_id uuid references public.offres(id),
  score_match integer,
  score_compat integer,
  created_at timestamp with time zone default now()
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid references public.users(id),
  receiver_id uuid references public.users(id),
  match_id uuid references public.matchs(id),
  contenu text,
  lu boolean default false,
  created_at timestamp with time zone default now()
);
create table public.abonnements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  stripe_customer_id text,
  plan text default 'freemium',
  statut text default 'actif',
  periode text,
  created_at timestamp with time zone default now(),
  date_fin timestamp with time zone,
  resiliation_programmee boolean default false
);
create table public.consentements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  type text not null,
  version text not null,
  accepte boolean not null,
  created_at timestamp with time zone default now() not null
);
alter table public.offres add constraint offres_statut_check check (statut in ('draft','active','paused','closed','inactive'));
alter table public.candidatures add constraint candidatures_statut_check check (statut in ('envoyee','nouveau','vu','contacte','repondu','entretien','offre','embauche','refusee','retiree'));
create unique index candidatures_candidate_offer_unique on public.candidatures(candidat_id, offre_id);
create unique index matchs_candidat_offre_unique on public.matchs(candidat_id, offre_id);
