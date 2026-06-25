alter table public.recruteurs
  add column if not exists matching jsonb not null default '{}'::jsonb,
  add column if not exists questions jsonb not null default '[]'::jsonb;

create index if not exists idx_matchs_candidat_offre
  on public.matchs (candidat_id, offre_id);

create index if not exists idx_messages_match_created
  on public.messages (match_id, created_at);

with ranked_recruiter_matches as (
  select
    m.id,
    row_number() over (
      partition by o.recruteur_id, m.candidat_id
      order by m.created_at desc nulls last, m.id desc
    ) as rn
  from public.matchs m
  join public.offres o on o.id = m.offre_id
)
delete from public.matchs m
using ranked_recruiter_matches r
where m.id = r.id
  and r.rn > 1;
