-- Apply before enabling BREVO_OUTBOX_ENABLED. No historical emails are replayed.
begin;
create table if not exists public.automation_installation (
  id integer primary key check(id = 1), started_at timestamptz not null default now()
);
insert into public.automation_installation(id) values(1) on conflict do nothing;
alter table public.automation_installation enable row level security;
revoke all on public.automation_installation from anon, authenticated;
grant all on public.automation_installation to service_role;
create table if not exists public.brevo_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text unique,
  user_id uuid,
  email text,
  event_name text not null,
  properties jsonb not null default '{}',
  contact_properties jsonb not null default '{}',
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease_token uuid,
  leased_until timestamptz,
  delivered_at timestamptz,
  event_delivered_at timestamptz,
  email_delivered_at timestamptz,
  discarded_at timestamptz,
  last_error text,
  check (email is not null or user_id is not null)
);
create index if not exists brevo_outbox_pending on public.brevo_outbox(available_at) where delivered_at is null;
alter table public.brevo_outbox enable row level security;
revoke all on public.brevo_outbox from anon, authenticated;
grant all on public.brevo_outbox to service_role;

create or replace function public.claim_brevo_events(batch_size integer default 50)
returns setof public.brevo_outbox language sql security definer set search_path = public as $$
  update public.brevo_outbox set lease_token = gen_random_uuid(),
    leased_until = now() + interval '15 minutes', attempts = attempts + 1
  where id in (select id from public.brevo_outbox
    where delivered_at is null and discarded_at is null and available_at <= now()
      and (leased_until is null or leased_until < now())
    order by available_at limit greatest(1, least(batch_size, 100)) for update skip locked)
  returning *;
$$;
revoke all on function public.claim_brevo_events(integer) from public, anon, authenticated;
grant execute on function public.claim_brevo_events(integer) to service_role;

create or replace function public.enqueue_brevo_event(recipient uuid, event text, payload jsonb, event_key text)
returns void language sql security definer set search_path = public as $$
  insert into public.brevo_outbox(user_id, event_name, properties, dedupe_key)
  select recipient, event, payload, event_key where recipient is not null
  on conflict(dedupe_key) do nothing;
$$;
revoke all on function public.enqueue_brevo_event(uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.enqueue_brevo_event(uuid,text,jsonb,text) to service_role;

-- Capture in the same transaction as the business change. Recipient ownership
-- comes from the database, never from a client supplied email address.
create or replace function public.capture_brevo_application()
returns trigger language plpgsql security definer set search_path = public as $$
declare candidate_user uuid; recruiter_user uuid; offer_title text; company text; payload jsonb;
begin
  if new.lettre_type = 'recruteur_like' then return new; end if;
  select user_id into candidate_user from public.candidats where id = new.candidat_id;
  select r.user_id, o.titre, r.entreprise into recruiter_user, offer_title, company
    from public.offres o join public.recruteurs r on r.id = o.recruteur_id where o.id = new.offre_id;
  payload := jsonb_build_object('application_id',new.id,'offre_id',new.offre_id,
    'poste',offer_title,'entreprise',company,'statut',new.statut);
  if tg_op = 'INSERT' then
    perform public.enqueue_brevo_event(candidate_user,'application_submitted',payload,'application_submitted:'||new.id);
    perform public.enqueue_brevo_event(recruiter_user,'application_received',payload,'application_received:'||new.id);
    perform public.enqueue_brevo_event(recruiter_user,'offer_first_application',payload,'offer_first_application:'||new.offre_id);
  elsif new.statut is distinct from old.statut then
    perform public.enqueue_brevo_event(candidate_user,'application_status_changed',
      payload || jsonb_build_object('previous_status',old.statut),
      'application_status:'||new.id||':'||gen_random_uuid());
  end if;
  return new;
end;
$$;
drop trigger if exists brevo_application on public.candidatures;
create trigger brevo_application after insert or update of statut on public.candidatures
for each row execute function public.capture_brevo_application();

create or replace function public.capture_brevo_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare payload jsonb;
begin
  payload := jsonb_build_object('message_id',new.id,'conversation_id',new.match_id);
  -- Message content and identity are intentionally excluded.
  if tg_op = 'INSERT' then
    perform public.enqueue_brevo_event(new.receiver_id,'message_received',payload,'message_received:'||new.id);
    perform public.enqueue_brevo_event(new.sender_id,'message_sent',payload,'message_sent:'||new.id);
    if not exists(select 1 from public.messages where match_id = new.match_id and id <> new.id) then
      perform public.enqueue_brevo_event(new.receiver_id,'first_message_sent',payload,'first_message:'||new.match_id||':'||new.receiver_id);
      perform public.enqueue_brevo_event(new.sender_id,'first_message_sent',payload,'first_message:'||new.match_id||':'||new.sender_id);
    end if;
  elsif new.lu = true and old.lu is distinct from true then
    perform public.enqueue_brevo_event(new.sender_id,'message_read',payload,'message_read:'||new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists brevo_message on public.messages;
create trigger brevo_message after insert or update of lu on public.messages
for each row execute function public.capture_brevo_message();
create table if not exists public.automation_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  marketing_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create table if not exists public.automation_activity (
  user_id uuid primary key references public.users(id) on delete cascade,
  last_active_at timestamptz not null default now()
);
create table if not exists public.offer_interactions (
  user_id uuid references public.users(id) on delete cascade,
  offre_id uuid references public.offres(id) on delete cascade,
  viewed_at timestamptz,
  application_started_at timestamptz,
  saved_at timestamptz,
  dismissed_at timestamptz,
  primary key(user_id, offre_id)
);
alter table public.offres add column if not exists expires_at timestamptz;
alter table public.candidats add column if not exists automation_changed_at timestamptz;
create or replace function public.mark_candidate_automation_change()
returns trigger language plpgsql set search_path = public as $$
begin
  new.automation_changed_at := now();
  return new;
end;
$$;
drop trigger if exists candidate_automation_change on public.candidats;
create trigger candidate_automation_change before insert or update of axes,score_adn,skills,target_job_types,sectors,desired_contracts
on public.candidats for each row execute function public.mark_candidate_automation_change();
alter table public.automation_preferences enable row level security;
alter table public.automation_activity enable row level security;
alter table public.offer_interactions enable row level security;
revoke all on public.automation_preferences, public.automation_activity, public.offer_interactions from anon, authenticated;
grant all on public.automation_preferences, public.automation_activity, public.offer_interactions to service_role;

create or replace function public.record_offer_interaction(p_user_id uuid, p_offre_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind not in ('viewed','application_started','saved','unsaved','dismissed') then
    raise exception 'Invalid interaction';
  end if;
  insert into public.offer_interactions(user_id,offre_id) values(p_user_id,p_offre_id)
    on conflict do nothing;
  update public.offer_interactions set
    viewed_at = case when p_kind = 'viewed' then coalesce(viewed_at,now()) else viewed_at end,
    application_started_at = case when p_kind = 'application_started' then coalesce(application_started_at,now()) else application_started_at end,
    saved_at = case when p_kind = 'saved' then coalesce(saved_at,now()) when p_kind = 'unsaved' then null else saved_at end,
    dismissed_at = case when p_kind = 'dismissed' then now() else dismissed_at end
  where user_id = p_user_id and offre_id = p_offre_id;
end;
$$;
revoke all on function public.record_offer_interaction(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.record_offer_interaction(uuid,uuid,text) to service_role;

-- Immutable signup events; profile and ADN data are recomputed from stored rows.
create or replace function public.capture_brevo_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_brevo_event(new.user_id,'signup_completed',
      jsonb_build_object('role',case when tg_table_name = 'candidats' then 'CANDIDAT' else 'RECRUTEUR' end),
      'signup_completed:'||new.user_id);
  end if;
  if tg_table_name = 'candidats' then
    perform public.enqueue_brevo_event(new.user_id,'profile_updated','{}',
      'profile_updated:'||new.id||':'||gen_random_uuid());
    if tg_op = 'UPDATE' then
      if new.score_adn is not null and (new.score_adn is distinct from old.score_adn
        or new.axes->'resultat' is distinct from old.axes->'resultat') then
        perform public.enqueue_brevo_event(new.user_id,'adn_completed',
          jsonb_build_object('score',new.score_adn),'adn_completed:'||new.id||':'||gen_random_uuid());
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists brevo_candidate_profile on public.candidats;
create trigger brevo_candidate_profile after insert or update of prenom, nom, titre, axes, score_adn, skills on public.candidats
for each row execute function public.capture_brevo_profile();
drop trigger if exists brevo_recruiter_profile on public.recruteurs;
create trigger brevo_recruiter_profile after insert on public.recruteurs
for each row execute function public.capture_brevo_profile();

create or replace function public.capture_brevo_offer()
returns trigger language plpgsql security definer set search_path = public as $$
declare recipient uuid;
begin
  if coalesce(new.statut,'active') = 'active' then
    if tg_op = 'INSERT' or old.statut is distinct from new.statut then
      select user_id into recipient from public.recruteurs where id = new.recruteur_id;
      perform public.enqueue_brevo_event(recipient,'offer_published',
        jsonb_build_object('offre_id',new.id,'poste',new.titre,'expires_at',new.expires_at),
        'offer_published:'||new.id||':'||gen_random_uuid());
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists brevo_offer on public.offres;
create trigger brevo_offer after insert or update of statut on public.offres
for each row execute function public.capture_brevo_offer();

create or replace function public.capture_brevo_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare candidate_user uuid; recruiter_user uuid; payload jsonb;
begin
  select user_id into candidate_user from public.candidats where id = new.candidat_id;
  select r.user_id into recruiter_user from public.offres o join public.recruteurs r on r.id = o.recruteur_id where o.id = new.offre_id;
  payload := jsonb_build_object('conversation_id',new.id,'match_id',new.id,'offre_id',new.offre_id,'candidat_id',new.candidat_id);
  perform public.enqueue_brevo_event(candidate_user,'match_created',payload,'match_created:candidate:'||new.id);
  perform public.enqueue_brevo_event(recruiter_user,'match_created',payload,'match_created:recruiter:'||new.id);
  return new;
end;
$$;
drop trigger if exists brevo_match on public.matchs;
create trigger brevo_match after insert on public.matchs for each row execute function public.capture_brevo_match();

create or replace function public.capture_automation_contact_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_brevo_event(new.user_id,'__contact_update','{}',
    'contact_state:'||new.user_id||':'||gen_random_uuid());
  return new;
end;
$$;
drop trigger if exists brevo_preferences on public.automation_preferences;
create trigger brevo_preferences after insert or update on public.automation_preferences
for each row execute function public.capture_automation_contact_state();
drop trigger if exists brevo_activity on public.automation_activity;
create trigger brevo_activity after insert or update on public.automation_activity
for each row execute function public.capture_automation_contact_state();

-- Trigger helpers cannot be invoked directly by browser roles.
create table if not exists public.automation_candidate_discoveries (
  offre_id uuid references public.offres(id) on delete cascade,
  candidat_id uuid references public.candidats(id) on delete cascade,
  score integer not null check(score between 0 and 100),
  created_at timestamptz not null default now(),
  primary key(offre_id,candidat_id)
);
alter table public.automation_candidate_discoveries enable row level security;
revoke all on public.automation_candidate_discoveries from anon,authenticated;
grant all on public.automation_candidate_discoveries to service_role;
create or replace function public.enqueue_candidate_discoveries(p_offre_id uuid,p_candidates jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare recipient uuid; title text; discovered jsonb; total integer;
begin
  select r.user_id,o.titre into recipient,title from public.offres o
    join public.recruteurs r on r.id=o.recruteur_id where o.id=p_offre_id;
  if recipient is null then return; end if;
  with inserted as (
    insert into public.automation_candidate_discoveries(offre_id,candidat_id,score)
    select p_offre_id,c.candidat_id,c.score from jsonb_to_recordset(p_candidates) as c(candidat_id uuid,score integer)
    on conflict do nothing returning candidat_id,score
  ) select jsonb_agg(jsonb_build_object('candidat_id',candidat_id,'score',score) order by candidat_id),count(*)
    into discovered,total from inserted;
  if total > 0 then
    perform public.enqueue_brevo_event(recipient,'compatible_candidates_found',
      jsonb_build_object('offre_id',p_offre_id,'poste',title,'nb',total,'candidats',discovered),
      'candidate_discovery:'||p_offre_id||':'||gen_random_uuid());
  end if;
end;
$$;
revoke all on function public.enqueue_candidate_discoveries(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_candidate_discoveries(uuid,jsonb) to service_role;
revoke all on function public.capture_brevo_application(), public.capture_brevo_message(),
  public.capture_brevo_profile(), public.capture_brevo_offer(), public.capture_brevo_match(),
  public.mark_candidate_automation_change(), public.capture_automation_contact_state() from public, anon, authenticated;
commit;
