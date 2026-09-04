-- A appliquer manuellement sur Supabase de developpement avant les parcours corriges.
alter table public.candidatures add column if not exists snapshot jsonb not null default '{}'::jsonb;
alter table public.candidatures add column if not exists withdrawn_at timestamptz;
alter table public.candidatures add column if not exists updated_at timestamptz not null default now();
alter table public.candidatures add column if not exists internal_note text not null default '';

create unique index if not exists candidatures_candidate_offer_unique
  on public.candidatures (candidat_id, offre_id);

create index if not exists candidatures_offer_status_idx
  on public.candidatures (offre_id, statut, updated_at desc);

alter table public.offres drop constraint if exists offres_statut_check;
alter table public.offres add constraint offres_statut_check
  check (statut in ('draft', 'active', 'paused', 'closed', 'inactive'));

alter table public.candidatures drop constraint if exists candidatures_statut_check;
alter table public.candidatures add constraint candidatures_statut_check
  check (statut in ('envoyee','nouveau','vu','contacte','repondu','entretien','offre','embauche','refusee','retiree'));
