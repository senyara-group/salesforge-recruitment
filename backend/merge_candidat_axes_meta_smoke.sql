-- Smoke test manuel — Supabase SQL Editor (après application de merge_candidat_axes_meta_migration.sql).
-- Remplace :00000000-0000-4000-8000-000000000001 par un user_id candidat réel de test, puis ROLLBACK.
-- Ne pas exécuter en prod hors transaction de test.

begin;

-- Isoler une ligne de test (user_id existant recommandé ; sinon créer un candidat jetable).
-- select user_id from public.candidats limit 1;

-- Helper local : stocker le user_id testé
-- \set uid 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'  -- psql only
-- Ici on utilise une CTE / variables plpgsql.

do $$
declare
  v_uid uuid;
  v_axes_before jsonb;
  v_axes jsonb;
  v_err text;
begin
  select user_id, axes into v_uid, v_axes_before
  from public.candidats
  limit 1;

  if v_uid is null then
    raise exception 'Aucun candidat pour smoke test';
  end if;

  -- Sauvegarde pour restauration
  raise notice 'smoke uid=%', v_uid;

  -- Cas axes SQL NULL
  update public.candidats set axes = null where user_id = v_uid;
  v_axes := public.merge_candidat_axes_meta(v_uid, '{"ville":"Paris"}'::jsonb);
  assert (v_axes ->> 'ville') is null;
  assert jsonb_typeof(v_axes -> 'meta') = 'object';
  assert v_axes #>> '{meta,ville}' = 'Paris';

  -- Cas axes={}
  update public.candidats set axes = '{}'::jsonb where user_id = v_uid;
  v_axes := public.merge_candidat_axes_meta(v_uid, '{"ville":"Lyon"}'::jsonb);
  assert v_axes #>> '{meta,ville}' = 'Lyon';

  -- Cas meta JSON null
  update public.candidats set axes = '{"meta":null}'::jsonb where user_id = v_uid;
  v_axes := public.merge_candidat_axes_meta(v_uid, '{"ville":"Nantes"}'::jsonb);
  assert v_axes #>> '{meta,ville}' = 'Nantes';

  -- Cas meta={}
  update public.candidats set axes = '{"meta":{}}'::jsonb where user_id = v_uid;
  v_axes := public.merge_candidat_axes_meta(v_uid, '{"ville":"Lille"}'::jsonb);
  assert v_axes #>> '{meta,ville}' = 'Lille';

  -- Préservation clés existantes
  update public.candidats
    set axes = '{"meta":{"ville":"Lille","foo":"bar"},"resultat":{"closing":80}}'::jsonb
  where user_id = v_uid;
  v_axes := public.merge_candidat_axes_meta(v_uid, '{"ville":"Paris"}'::jsonb);
  assert v_axes #>> '{meta,ville}' = 'Paris';
  assert v_axes #>> '{meta,foo}' = 'bar';
  assert (v_axes -> 'resultat' ->> 'closing') = '80';

  -- Erreurs attendues (aucune corruption)
  update public.candidats set axes = '{"meta":[]}'::jsonb where user_id = v_uid;
  begin
    perform public.merge_candidat_axes_meta(v_uid, '{"ville":"X"}'::jsonb);
    raise exception 'expected failure for meta array';
  exception when others then
    if SQLERRM like 'expected failure%' then raise; end if;
    v_err := SQLERRM;
    raise notice 'ok meta array → %', v_err;
  end;
  assert (select axes from public.candidats where user_id = v_uid) = '{"meta":[]}'::jsonb;

  update public.candidats set axes = '{"meta":"bad"}'::jsonb where user_id = v_uid;
  begin
    perform public.merge_candidat_axes_meta(v_uid, '{"ville":"X"}'::jsonb);
    raise exception 'expected failure for meta string';
  exception when others then
    if SQLERRM like 'expected failure%' then raise; end if;
    raise notice 'ok meta string → %', SQLERRM;
  end;
  assert (select axes from public.candidats where user_id = v_uid) = '{"meta":"bad"}'::jsonb;

  update public.candidats set axes = '[]'::jsonb where user_id = v_uid;
  begin
    perform public.merge_candidat_axes_meta(v_uid, '{"ville":"X"}'::jsonb);
    raise exception 'expected failure for axes array';
  exception when others then
    if SQLERRM like 'expected failure%' then raise; end if;
    raise notice 'ok axes array → %', SQLERRM;
  end;
  assert (select axes from public.candidats where user_id = v_uid) = '[]'::jsonb;

  update public.candidats set axes = '"bad"'::jsonb where user_id = v_uid;
  begin
    perform public.merge_candidat_axes_meta(v_uid, '{"ville":"X"}'::jsonb);
    raise exception 'expected failure for axes string';
  exception when others then
    if SQLERRM like 'expected failure%' then raise; end if;
    raise notice 'ok axes string → %', SQLERRM;
  end;
  assert (select axes from public.candidats where user_id = v_uid) = '"bad"'::jsonb;

  begin
    perform public.merge_candidat_axes_meta(v_uid, '[]'::jsonb);
    raise exception 'expected failure for patch array';
  exception when others then
    if SQLERRM like 'expected failure%' then raise; end if;
    raise notice 'ok patch array → %', SQLERRM;
  end;

  -- Restaurer
  update public.candidats set axes = v_axes_before where user_id = v_uid;
  raise notice 'smoke merge_candidat_axes_meta OK — restauré';
end;
$$;

rollback;
