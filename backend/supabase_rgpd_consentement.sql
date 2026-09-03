-- RGPD : preuve de consentement (test ADN et futurs consentements spécifiques).
-- Table en ajout seul (append-only) : chaque action de consentement crée une nouvelle
-- ligne, jamais de mise à jour sur une ligne existante. Ça donne un historique complet
-- (qui a consenti, à quelle version du texte, quand) même si le texte change plus tard
-- ou si l'utilisateur revient sur sa décision.
create table if not exists public.consentements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  type text not null,
  version text not null,
  accepte boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_consentements_user_type
  on public.consentements (user_id, type, created_at desc);
