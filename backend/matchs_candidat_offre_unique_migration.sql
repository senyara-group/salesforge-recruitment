-- UNIQUE(candidat_id, offre_id) sur matchs — preuve code :
-- swipes.js / recruteurs.js upsert onConflict 'candidat_id,offre_id'.
-- Index non-unique existant : idx_matchs_candidat_offre (supabase_swipe_message_fixes.sql).
--
-- IMPORTANT : si des doublons existent en prod, cette migration ÉCHOUE sans supprimer
-- aucune ligne. Exécuter d’abord matchs_unique_diagnostic.sql (read-only).

do $$
declare
  dup_groups integer;
begin
  select count(*) into dup_groups
  from (
    select candidat_id, offre_id
    from public.matchs
    group by candidat_id, offre_id
    having count(*) > 1
  ) d;

  if dup_groups > 0 then
    raise exception
      'matchs: % groupe(s) en double (candidat_id, offre_id). Exécuter matchs_unique_diagnostic.sql — aucune suppression automatique.',
      dup_groups;
  end if;
end $$;

create unique index if not exists matchs_candidat_offre_unique
  on public.matchs (candidat_id, offre_id);
