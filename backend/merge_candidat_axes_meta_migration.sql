-- Merge atomique de candidats.axes.meta (correctif PR E — robustesse jsonb_typeof).
-- Additive, idempotente. Ne touche pas score_adn, deep_adn_*, bilans, ai_cv_analyses.
-- À appliquer manuellement dans Supabase AVANT merge / déploiement backend.
--
-- Contrat :
--   axes SQL NULL | JSON null | {} | objet  → OK (NULL/null ⇒ {})
--   axes.meta absent | JSON null | objet    → OK (absent/null ⇒ {})
--   axes ou axes.meta array/scalar/boolean  → RAISE, aucune ligne modifiée
--   p_meta_patch non-objet                  → RAISE

create or replace function public.merge_candidat_axes_meta(
  p_user_id uuid,
  p_meta_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw jsonb;
  v_base_axes jsonb;
  v_base_meta jsonb;
  v_axes jsonb;
  v_meta_raw jsonb;
  v_meta_type text;
begin
  if p_user_id is null then
    raise exception 'user_id required';
  end if;

  if p_meta_patch is null or jsonb_typeof(p_meta_patch) <> 'object' then
    raise exception 'meta_patch must be a jsonb object (got %)',
      case when p_meta_patch is null then 'sql-null' else jsonb_typeof(p_meta_patch) end;
  end if;

  select c.axes
    into v_raw
  from public.candidats as c
  where c.user_id = p_user_id
  for update;

  if not found then
    raise exception 'candidat not found';
  end if;

  -- Cas 1–2 / 7 : axes SQL NULL, JSON null, objet, sinon échec.
  if v_raw is null or jsonb_typeof(v_raw) = 'null' then
    v_base_axes := '{}'::jsonb;
  elsif jsonb_typeof(v_raw) = 'object' then
    v_base_axes := v_raw;
  else
    raise exception 'axes must be a jsonb object (got %)', jsonb_typeof(v_raw);
  end if;

  -- Cas 3–6 : meta absente / JSON null / objet ; array|scalar ⇒ échec.
  if not (v_base_axes ? 'meta') then
    v_base_meta := '{}'::jsonb;
  else
    v_meta_raw := v_base_axes -> 'meta';
    v_meta_type := jsonb_typeof(v_meta_raw);
    if v_meta_type = 'null' then
      v_base_meta := '{}'::jsonb;
    elsif v_meta_type = 'object' then
      v_base_meta := v_meta_raw;
    else
      raise exception 'axes.meta must be a jsonb object (got %)', v_meta_type;
    end if;
  end if;

  update public.candidats
  set axes = jsonb_set(
    v_base_axes,
    '{meta}',
    v_base_meta || p_meta_patch,
    true
  )
  where user_id = p_user_id
  returning axes into v_axes;

  return v_axes;
end;
$$;

revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from public;
revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from anon;
revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from authenticated;
grant execute on function public.merge_candidat_axes_meta(uuid, jsonb) to service_role;

comment on function public.merge_candidat_axes_meta(uuid, jsonb) is
  'Merge atomique de clés dans candidats.axes.meta. JSON null→{}; array/scalar axes|meta→exception avant UPDATE.';
