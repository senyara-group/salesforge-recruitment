-- Diagnostic READ-ONLY avant matchs_candidat_offre_unique_migration.sql
-- Aucun DELETE / UPDATE. À exécuter dans Supabase SQL Editor.

-- 1) Nombre de groupes en double
select count(*) as duplicate_groups
from (
  select candidat_id, offre_id
  from public.matchs
  group by candidat_id, offre_id
  having count(*) > 1
) d;

-- 2) Détail des doublons (id + dates)
select
  m.candidat_id,
  m.offre_id,
  count(*) as row_count,
  array_agg(m.id order by m.created_at desc nulls last, m.id desc) as match_ids,
  array_agg(m.created_at order by m.created_at desc nulls last, m.id desc) as created_ats
from public.matchs m
group by m.candidat_id, m.offre_id
having count(*) > 1
order by row_count desc, m.candidat_id, m.offre_id
limit 100;

-- 3) Total lignes matchs
select count(*) as matchs_total from public.matchs;

-- Si duplicate_groups = 0 → appliquer matchs_candidat_offre_unique_migration.sql
-- Si duplicate_groups > 0 → résoudre manuellement (hors scope auto-delete), puis réessayer.
