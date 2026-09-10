-- Merge atomique de candidats.axes.meta (correctif PR E).
-- Additive, idempotente. Ne touche pas score_adn, deep_adn_*, bilans, ai_cv_analyses.
-- À appliquer manuellement dans Supabase AVANT merge / déploiement backend.

create or replace function public.merge_candidat_axes_meta(
  p_user_id uuid,
  p_meta_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_axes jsonb;
begin
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  if p_meta_patch is null or jsonb_typeof(p_meta_patch) <> 'object' then
    raise exception 'meta_patch must be a jsonb object';
  end if;

  update public.candidats
  set axes = jsonb_set(
    coalesce(axes, '{}'::jsonb),
    '{meta}',
    coalesce(axes->'meta', '{}'::jsonb) || p_meta_patch,
    true
  )
  where user_id = p_user_id
  returning axes into v_axes;

  if not found then
    raise exception 'candidat not found';
  end if;

  return v_axes;
end;
$$;

revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from public;
revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from anon;
revoke all on function public.merge_candidat_axes_meta(uuid, jsonb) from authenticated;
grant execute on function public.merge_candidat_axes_meta(uuid, jsonb) to service_role;

comment on function public.merge_candidat_axes_meta(uuid, jsonb) is
  'Merge atomique de clés dans candidats.axes.meta sans écraser les autres clés JSON (CV, ADN, avatar_meta, etc.).';
