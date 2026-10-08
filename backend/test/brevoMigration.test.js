const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const CANDIDATE_USER = '11111111-1111-4111-8111-111111111111';
const RECRUITER_USER = '22222222-2222-4222-8222-222222222222';

// Column types snapshotted from the production Supabase schema (text[] skills,
// integer score_adn, snapshot jsonb not null...), not a simplified stand-in.
async function productionShapedDb() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/supabase_schema_snapshot.sql'), 'utf8'));
  await db.query("insert into users(id,email,role) values ($1,'candidate@example.test','candidat'),($2,'recruiter@example.test','recruteur')",
    [CANDIDATE_USER, RECRUITER_USER]);
  return db;
}
const migration = () => fs.readFileSync(path.join(__dirname, '../brevo_outbox_migration.sql'), 'utf8');
const outbox = async (db, name) => (await db.query('select * from brevo_outbox where event_name=$1 order by created_at', [name])).rows;

test('SQL captures business changes atomically, isolates browser roles, and leases distinct events', async () => {
  const db = await productionShapedDb();
  try {
    await db.exec(migration());
    await db.exec(migration());
    assert.equal((await db.query('select * from brevo_outbox')).rows.length, 0);
    const candidate = (await db.query('insert into candidats(user_id) values($1) returning id', [CANDIDATE_USER])).rows[0].id;
    const recruiter = (await db.query("insert into recruteurs(user_id,entreprise) values($1,'Test') returning id", [RECRUITER_USER])).rows[0].id;
    const offer = (await db.query("insert into offres(recruteur_id,titre,statut) values($1,'Commercial','active') returning id", [recruiter])).rows[0].id;
    const before = (await db.query('select count(*)::int n from brevo_outbox')).rows[0].n;
    await db.exec('begin');
    await db.query("insert into candidatures(candidat_id,offre_id,statut) values($1,$2,'envoyee')", [candidate, offer]);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from brevo_outbox')).rows[0].n, before);
    const application = (await db.query("insert into candidatures(candidat_id,offre_id,statut,lettre_type) values($1,$2,'envoyee','candidate_like') returning id", [candidate, offer])).rows[0].id;
    await db.query("update candidatures set statut='vu' where id=$1", [application]);
    await db.query("update candidatures set statut='vu' where id=$1", [application]);
    const change = await outbox(db, 'application_status_changed');
    assert.equal(change.length, 1);
    assert.equal(change[0].user_id, CANDIDATE_USER);
    assert.equal(change[0].properties.previous_status, 'envoyee');
    assert.equal(change[0].properties.statut, 'vu');
    assert.equal((await outbox(db, 'application_received'))[0].user_id, RECRUITER_USER);
    const match = (await db.query('insert into matchs(candidat_id,offre_id) values($1,$2) returning id', [candidate, offer])).rows[0].id;
    const message = (await db.query("insert into messages(match_id,sender_id,receiver_id,contenu) values($1,$2,$3,'CONFIDENTIAL BODY') returning id",
      [match, RECRUITER_USER, CANDIDATE_USER])).rows[0].id;
    await db.query('update messages set lu=true where id=$1', [message]);
    const received = await outbox(db, 'message_received');
    assert.equal(received.length, 1);
    assert.equal(received[0].user_id, CANDIDATE_USER);
    assert.ok(!JSON.stringify((await db.query('select properties from brevo_outbox')).rows).includes('CONFIDENTIAL'));
    assert.equal((await outbox(db, 'first_message_sent')).length, 2);
    assert.equal((await outbox(db, 'message_read'))[0].user_id, RECRUITER_USER);
    await db.query('select enqueue_candidate_discoveries($1,$2::jsonb)', [offer, JSON.stringify([{ candidat_id: candidate, score: 92 }])]);
    await db.query('select enqueue_candidate_discoveries($1,$2::jsonb)', [offer, JSON.stringify([{ candidat_id: candidate, score: 92 }])]);
    const discovery = await outbox(db, 'compatible_candidates_found');
    assert.equal(discovery.length, 1);
    assert.equal(discovery[0].user_id, RECRUITER_USER);
    assert.equal(discovery[0].properties.nb, 1);
    await db.query("select record_offer_interaction($1,$2,'viewed')", [CANDIDATE_USER, offer]);
    const viewed = (await db.query('select viewed_at from offer_interactions')).rows[0].viewed_at;
    await db.query("select record_offer_interaction($1,$2,'viewed')", [CANDIDATE_USER, offer]);
    assert.deepEqual((await db.query('select viewed_at from offer_interactions')).rows[0].viewed_at, viewed);
    const claimed = (await db.query('select * from claim_brevo_events(3)')).rows;
    const next = (await db.query('select * from claim_brevo_events(3)')).rows;
    assert.equal(claimed.length, 3);
    assert.ok(next.every((row) => !claimed.some((first) => first.id === row.id)));
    assert.ok(claimed.every((row) => row.attempts === 1 && row.lease_token));
    for (const role of ['authenticated', 'anon']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from claim_brevo_events(3)'), /permission denied/);
      await assert.rejects(db.query('select * from brevo_outbox'), /permission denied/);
      await assert.rejects(db.query("select enqueue_brevo_event($1,'payment_failed','{}','forged')", [CANDIDATE_USER]), /permission denied/);
      await assert.rejects(db.query("select record_offer_interaction($1,$2,'viewed')", [CANDIDATE_USER, offer]), /permission denied/);
      await assert.rejects(db.query('select * from automation_preferences'), /permission denied/);
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});

test('first application, profile updates and recruiter likes follow the real product semantics', async () => {
  const db = await productionShapedDb();
  try {
    const candidate = (await db.query("insert into candidats(user_id,prenom,skills,score_adn) values($1,'Ana',array['closing'],70) returning id", [CANDIDATE_USER])).rows[0].id;
    const recruiter = (await db.query("insert into recruteurs(user_id,entreprise) values($1,'Test') returning id", [RECRUITER_USER])).rows[0].id;
    const offer = (await db.query("insert into offres(recruteur_id,titre,statut) values($1,'Commercial','active') returning id", [recruiter])).rows[0].id;
    const other = (await db.query("insert into candidats(user_id) values($1) returning id", [RECRUITER_USER])).rows[0].id;
    // An application that existed before installation.
    await db.query("insert into candidatures(candidat_id,offre_id,statut,lettre_type) values($1,$2,'envoyee','candidate_like')", [other, offer]);
    await db.exec(migration());
    // Nothing historical is replayed by the installation itself.
    assert.equal((await db.query('select count(*)::int n from brevo_outbox')).rows[0].n, 0);
    await db.query("insert into candidatures(candidat_id,offre_id,statut,lettre_type) values($1,$2,'envoyee','candidate_like')", [candidate, offer]);
    assert.equal((await outbox(db, 'offer_first_application')).length, 0, 'not the first application of this offer');
    assert.equal((await outbox(db, 'application_submitted')).length, 1);
    // Recruiter-side rows are not candidate applications.
    const offer2 = (await db.query("insert into offres(recruteur_id,titre,statut) values($1,'Sales','active') returning id", [recruiter])).rows[0].id;
    await db.query("insert into candidatures(candidat_id,offre_id,statut,lettre_type) values($1,$2,'nouveau','recruteur_like')", [candidate, offer2]);
    assert.equal((await outbox(db, 'application_received')).length, 1);
    // Whole-profile saves that change nothing are not profile_updated events.
    await db.query("update candidats set prenom='Ana', skills=array['closing'] where id=$1", [candidate]);
    assert.equal((await outbox(db, 'profile_updated')).length, 0);
    await db.query("update candidats set skills=array['closing','prospection'] where id=$1", [candidate]);
    assert.equal((await outbox(db, 'profile_updated')).length, 1);
    await db.query(`update candidats set score_adn=88, axes='{"resultat":{"score":88}}' where id=$1`, [candidate]);
    assert.equal((await outbox(db, 'adn_completed'))[0].properties.score, 88);
    // Expiration column and closing status fit the real statut constraint.
    await db.query("update offres set expires_at=now() - interval '1 minute' where id=$1", [offer2]);
    await db.query("update offres set statut='closed' where id=$1 and expires_at <= now()", [offer2]);
    assert.equal((await db.query('select statut from offres where id=$1', [offer2])).rows[0].statut, 'closed');
  } finally { await db.close(); }
});
