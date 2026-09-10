-- Marketing / engagement tracking (preuve code : engagementTracking.js, swipes.js, recruteurs.js).
-- Additive, idempotente. Remplace la migration manquante
-- backend/migrations/2026_08_marketing_automation_tracking.sql référencée dans le code.
-- Aucune suppression de données. Aucun deep ADN / CV IA / Stripe.

create extension if not exists pgcrypto;

-- Likes recruteur → candidat (idempotent : un couple unique).
create table if not exists public.candidat_likes (
  id uuid primary key default gen_random_uuid(),
  candidat_id uuid not null references public.candidats(id) on delete cascade,
  recruteur_id uuid not null references public.recruteurs(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (candidat_id, recruteur_id)
);

create index if not exists candidat_likes_candidat_created_idx
  on public.candidat_likes (candidat_id, created_at desc);

create index if not exists candidat_likes_recruteur_idx
  on public.candidat_likes (recruteur_id);

-- Consultations de profil (non uniques : chaque vue compte).
create table if not exists public.candidat_profile_views (
  id uuid primary key default gen_random_uuid(),
  candidat_id uuid not null references public.candidats(id) on delete cascade,
  recruteur_id uuid not null references public.recruteurs(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists candidat_profile_views_candidat_created_idx
  on public.candidat_profile_views (candidat_id, created_at desc);

-- Dernière connexion (touchLastLogin).
alter table public.candidats add column if not exists last_login_at timestamptz;
alter table public.recruteurs add column if not exists last_login_at timestamptz;
