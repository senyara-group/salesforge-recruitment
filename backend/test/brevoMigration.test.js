const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('SQL captures business changes atomically, isolates browser roles, and leases distinct events', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table users(id uuid primary key, email text);
      create table candidats(id uuid primary key default gen_random_uuid(), user_id uuid references users(id),
        prenom text,nom text,titre text,axes jsonb default '{}',score_adn numeric,skills jsonb,
        target_job_types jsonb,sectors jsonb,desired_contracts jsonb,created_at timestamptz default now());
      create table recruteurs(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),entreprise text);
      create table offres(id uuid primary key default gen_random_uuid(),recruteur_id uuid references recruteurs(id),titre text,statut text);
      create table candidatures(id uuid primary key default gen_random_uuid(),candidat_id uuid references candidats(id),offre_id uuid references offres(id),statut text,lettre_type text);
      create table matchs(id uuid primary key default gen_random_uuid(),candidat_id uuid references candidats(id),offre_id uuid references offres(id));
      create table messages(id uuid primary key default gen_random_uuid(),match_id uuid references matchs(id),sender_id uuid,receiver_id uuid,lu boolean default false);
      insert into users values ('11111111-1111-4111-8111-111111111111','candidate@example.test'),('22222222-2222-4222-8222-222222222222','recruiter@example.test');
    `);
    const migration = fs.readFileSync(path.join(__dirname, '../brevo_outbox_migration.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query('select * from brevo_outbox')).rows.length, 0);
    const candidate = (await db.query("insert into candidats(user_id) values('11111111-1111-4111-8111-111111111111') returning id")).rows[0].id;
    const recruiter = (await db.query("insert into recruteurs(user_id,entreprise) values('22222222-2222-4222-8222-222222222222','Test') returning id")).rows[0].id;
    const offer = (await db.query("insert into offres(recruteur_id,titre,statut) values($1,'Commercial','active') returning id", [recruiter])).rows[0].id;
    const before = (await db.query('select count(*)::int n from brevo_outbox')).rows[0].n;
    await db.exec('begin');
    await db.query("insert into candidatures(candidat_id,offre_id,statut) values($1,$2,'envoyee')", [candidate, offer]);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from brevo_outbox')).rows[0].n, before);
    const application = (await db.query("insert into candidatures(candidat_id,offre_id,statut) values($1,$2,'envoyee') returning id", [candidate, offer])).rows[0].id;
    await db.query("update candidatures set statut='vu' where id=$1", [application]);
    await db.query("update candidatures set statut='vu' where id=$1", [application]);
    const change = (await db.query("select * from brevo_outbox where event_name='application_status_changed'")).rows;
    assert.equal(change.length, 1);
    assert.equal(change[0].user_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(change[0].properties.previous_status, 'envoyee');
    assert.equal(change[0].properties.statut, 'vu');
    const match = (await db.query('insert into matchs(candidat_id,offre_id) values($1,$2) returning id', [candidate, offer])).rows[0].id;
    const message = (await db.query("insert into messages(match_id,sender_id,receiver_id) values($1,'22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111') returning id", [match])).rows[0].id;
    await db.query('update messages set lu=true where id=$1', [message]);
    const received = (await db.query("select * from brevo_outbox where event_name='message_received'")).rows;
    assert.equal(received.length, 1);
    assert.equal(received[0].user_id, '11111111-1111-4111-8111-111111111111');
    assert.equal((await db.query("select * from brevo_outbox where event_name='first_message_sent'")).rows.length, 2);
    assert.equal((await db.query("select * from brevo_outbox where event_name='message_read'")).rows[0].user_id, '22222222-2222-4222-8222-222222222222');
    await db.query('select enqueue_candidate_discoveries($1,$2::jsonb)', [offer, JSON.stringify([{ candidat_id: candidate, score: 92 }])]);
    await db.query('select enqueue_candidate_discoveries($1,$2::jsonb)', [offer, JSON.stringify([{ candidat_id: candidate, score: 92 }])]);
    const discovery = (await db.query("select * from brevo_outbox where event_name='compatible_candidates_found'")).rows;
    assert.equal(discovery.length, 1);
    assert.equal(discovery[0].properties.nb, 1);
    await db.query("select record_offer_interaction('11111111-1111-4111-8111-111111111111',$1,'viewed')", [offer]);
    const viewed = (await db.query('select viewed_at from offer_interactions')).rows[0].viewed_at;
    await db.query("select record_offer_interaction('11111111-1111-4111-8111-111111111111',$1,'viewed')", [offer]);
    assert.deepEqual((await db.query('select viewed_at from offer_interactions')).rows[0].viewed_at, viewed);
    const claimed = (await db.query('select * from claim_brevo_events(3)')).rows;
    const next = (await db.query('select * from claim_brevo_events(3)')).rows;
    assert.equal(claimed.length, 3);
    assert.ok(next.every((row) => !claimed.some((first) => first.id === row.id)));
    assert.ok(claimed.every((row) => row.attempts === 1 && row.lease_token));
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from claim_brevo_events(3)'), /permission denied/);
    await assert.rejects(db.query('select * from brevo_outbox'), /permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});
