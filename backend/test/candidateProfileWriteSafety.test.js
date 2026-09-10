const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  normalizeCandidateProfileStructuredFields,
  parseOptionalStringList,
  buildAxesMetaPatch,
  applyAxesMetaMerge,
  MAX_YEARS,
  MAX_MULTI,
} = require('../utils/candidateProfileWrite');
const { assertAllowedList, CONTRACT_TYPES } = require('../utils/filterTaxonomies');

process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

function mockModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ------------------------------------------------------------
// Fake DB pour PUT /profil
// ------------------------------------------------------------
const state = {
  roleByUser: {
    'user-cand': 'candidat',
    'user-rec': 'recruteur',
  },
  rows: {
    'user-cand': {
      id: 'cand-1',
      user_id: 'user-cand',
      prenom: 'Ada',
      nom: 'Lovelace',
      titre: null,
      score_adn: 77,
      target_job_types: [],
      sales_style: null,
      years_experience: null,
      desired_contracts: [],
      sectors: [],
      customer_types: [],
      tools: [],
      methodologies: [],
      availability: null,
      axes: {
        resultat: { closing: 80 },
        meta: { ville: 'Lyon', cv_path: 'user-cand/cv.pdf', cv_file_name: 'cv.pdf' },
      },
    },
  },
  lastUpdatePatch: null,
  lastRpc: null,
  concurrentMetaInjection: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const fakeSupabase = {
  from(table) {
    if (table === 'users') {
      return {
        select() {
          return {
            eq(col, id) {
              return {
                limit() {
                  return Promise.resolve({
                    data: state.roleByUser[id] ? [{ id, role: state.roleByUser[id] }] : [],
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    }
    if (table !== 'candidats') {
      return {
        select() { return { eq() { return { limit: async () => ({ data: [], error: null }) }; } }; },
        update() { return { eq() { return { select() { return { single: async () => ({ data: null, error: { message: 'unexpected' } }) }; } }; } }; },
      };
    }
    return {
      select() {
        return {
          eq(col, userId) {
            return {
              limit: async () => ({
                data: state.rows[userId] ? [clone(state.rows[userId])] : [],
                error: null,
              }),
            };
          },
        };
      },
      update(patch) {
        state.lastUpdatePatch = clone(patch);
        return {
          eq(col, userId) {
            return {
              select() {
                return {
                  single: async () => {
                    assert.equal(col, 'user_id');
                    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'axes'), false, 'UPDATE colonnes ne doit pas inclure axes');
                    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'score_adn'), false, 'score_adn jamais écrit');
                    const row = state.rows[userId];
                    if (!row) return { data: null, error: { message: 'missing' } };
                    Object.assign(row, patch);
                    return { data: clone(row), error: null };
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          select() {
            return {
              single: async () => ({ data: null, error: { message: 'insert unexpected' } }),
            };
          },
        };
      },
    };
  },
  async rpc(name, args) {
    state.lastRpc = { name, args: clone(args) };
    assert.equal(name, 'merge_candidat_axes_meta');
    const userId = args.p_user_id;
    const row = state.rows[userId];
    if (!row) return { data: null, error: { message: 'missing' } };
    // Simule une écriture concurrente (CV / ADN) entre lecture initiale et merge.
    if (state.concurrentMetaInjection) {
      row.axes = applyAxesMetaMerge(row.axes, state.concurrentMetaInjection);
    }
    row.axes = applyAxesMetaMerge(row.axes, args.p_meta_patch);
    return { data: clone(row.axes), error: null };
  },
};

mockModule('../supabase', fakeSupabase);
mockModule('../middleware/auth', (req, _res, next) => {
  req.user = { id: req.headers['x-test-user'] || 'user-cand' };
  next();
});
mockModule('../middleware/requireCandidatePlan', () => (_req, _res, next) => next());
mockModule('../middleware/requireRecruiterPlan', () => (_req, _res, next) => next());
mockModule('../utils/anthropic', { askClaude: async () => '' });
mockModule('../utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });
mockModule('../utils/ebookAccess', { accessibleEbooks: () => [] });
mockModule('../utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });

mockModule('../utils/profiles', {
  ensureCandidateProfile: async (userId) => {
    if (state.roleByUser[userId] && state.roleByUser[userId] !== 'candidat') {
      const error = new Error('Acces reserve aux profils candidats');
      error.status = 403;
      throw error;
    }
    const row = state.rows[userId];
    if (!row) {
      const error = new Error('Profil candidat introuvable');
      error.status = 404;
      throw error;
    }
    return clone(row);
  },
  ensureRecruiterProfile: async () => ({ id: 'rec-1' }),
  getCandidatePlan: async () => 'freemium',
  checkAndConsumeUsage: async () => ({ allowed: true }),
});

delete require.cache[require.resolve('../routes/candidats')];
const candidatsRouter = require('../routes/candidats');
const app = express();
app.use(express.json());
app.use('/candidats', candidatsRouter);

async function putProfil(body, userId = 'user-cand') {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/candidats/profil`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': userId,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('listes : 13 doublons → 1 valeur ; vides avant MAX_MULTI ; desired_contracts dédupliqué', () => {
  assert.deepEqual(
    parseOptionalStringList(Array(13).fill('SaaS'), { label: 'sectors' }),
    ['SaaS']
  );
  assert.deepEqual(
    parseOptionalStringList(['SaaS', '', '  ', 'Tech', 'SaaS'], { label: 'sectors' }),
    ['SaaS', 'Tech']
  );
  assert.throws(
    () => parseOptionalStringList(Array.from({ length: MAX_MULTI + 1 }, (_, i) => `S${i}`), { label: 'sectors' }),
    /trop de valeurs/
  );
  assert.deepEqual(
    normalizeCandidateProfileStructuredFields({ desired_contracts: ['CDI', 'CDI', 'Freelance'] }).desired_contracts,
    ['CDI', 'Freelance']
  );
  assert.deepEqual(assertAllowedList(['CDI', 'CDI', 'Mission'], CONTRACT_TYPES, 'desired_contracts'), ['CDI', 'Mission']);
});

test('sauvegarde partielle : clés absentes non écrasées ; score_adn hors patch', () => {
  const out = normalizeCandidateProfileStructuredFields({ sales_style: 'hunter' });
  assert.equal(out.sales_style, 'hunter');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'target_job_types'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'years_experience'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'score_adn'), false);
  assert.throws(() => normalizeCandidateProfileStructuredFields({ years_experience: MAX_YEARS + 1 }), /years_experience invalide/);
});

test('merge axes.meta préserve clés concurrentes (ADN/CV)', () => {
  const before = {
    resultat: { closing: 80 },
    meta: { ville: 'Lyon', cv_path: 'old.pdf' },
  };
  const afterConcurrent = applyAxesMetaMerge(before, { cv_path: 'new-concurrent.pdf', adn_note: 'fresh' });
  const afterSave = applyAxesMetaMerge(afterConcurrent, { ville: 'Paris', competences: { Vente: ['Closing'] } });
  assert.equal(afterSave.meta.ville, 'Paris');
  assert.equal(afterSave.meta.cv_path, 'new-concurrent.pdf');
  assert.equal(afterSave.meta.adn_note, 'fresh');
  assert.deepEqual(afterSave.resultat, { closing: 80 });
  assert.deepEqual(afterSave.meta.competences, { Vente: ['Closing'] });
});

test('PUT profil : user_id forgé → 403', async () => {
  state.lastUpdatePatch = null;
  const res = await putProfil({ user_id: 'other-user', sales_style: 'hunter' });
  assert.equal(res.status, 403);
  assert.equal(state.lastUpdatePatch, null);
});

test('PUT profil : recruteur refusé', async () => {
  const res = await putProfil({ sales_style: 'hunter' }, 'user-rec');
  assert.equal(res.status, 403);
});

test('PUT profil structuré sans ville/competences : axes absent de UPDATE', async () => {
  state.lastUpdatePatch = null;
  state.lastRpc = null;
  state.concurrentMetaInjection = null;
  const beforeAxes = clone(state.rows['user-cand'].axes);
  const beforeScore = state.rows['user-cand'].score_adn;
  const res = await putProfil({
    sales_style: 'farmer',
    years_experience: 4,
    desired_contracts: ['CDI', 'CDI'],
    target_job_types: ['Account Executive'],
  });
  assert.equal(res.status, 200);
  assert.ok(state.lastUpdatePatch);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastUpdatePatch, 'axes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastUpdatePatch, 'score_adn'), false);
  assert.equal(state.lastRpc, null);
  assert.equal(res.json.sales_style, 'farmer');
  assert.equal(res.json.years_experience, 4);
  assert.deepEqual(res.json.desired_contracts, ['CDI']);
  assert.equal(res.json.score_adn, beforeScore);
  assert.deepEqual(state.rows['user-cand'].axes, beforeAxes);
});

test('PUT profil ville/competences : RPC atomique + clés concurrentes préservées', async () => {
  state.lastUpdatePatch = null;
  state.lastRpc = null;
  state.concurrentMetaInjection = { cv_path: 'uploaded-during-save.pdf', questionnaire: { q1: 1 } };
  state.rows['user-cand'].axes = {
    resultat: { closing: 80 },
    meta: { ville: 'Lyon', cv_path: 'old.pdf' },
  };
  const res = await putProfil({
    ville: 'Nantes',
    competences: { Vente: ['Closing'] },
    sales_style: 'hunter',
  });
  assert.equal(res.status, 200);
  assert.ok(state.lastUpdatePatch);
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastUpdatePatch, 'axes'), false);
  assert.equal(state.lastRpc?.name, 'merge_candidat_axes_meta');
  assert.equal(state.lastRpc.args.p_user_id, 'user-cand');
  assert.deepEqual(state.lastRpc.args.p_meta_patch, {
    ville: 'Nantes',
    competences: { Vente: ['Closing'] },
  });
  assert.equal(res.json.ville, 'Nantes');
  assert.equal(res.json.axes.meta.cv_path, 'uploaded-during-save.pdf');
  assert.deepEqual(res.json.axes.meta.questionnaire, { q1: 1 });
  assert.deepEqual(res.json.axes.resultat, { closing: 80 });
  assert.equal(res.json.score_adn, 77);
});

test('ownership : UPDATE / RPC toujours scoped au JWT user_id', async () => {
  state.lastUpdatePatch = null;
  state.lastRpc = null;
  state.concurrentMetaInjection = null;
  await putProfil({ sales_style: 'full', ville: 'Nice' }, 'user-cand');
  assert.equal(state.lastRpc.args.p_user_id, 'user-cand');
});

test('buildAxesMetaPatch ignore champs structurés', () => {
  assert.deepEqual(buildAxesMetaPatch({ sales_style: 'hunter', ville: 'Lyon' }), { ville: 'Lyon' });
  assert.deepEqual(buildAxesMetaPatch({ target_job_types: ['SDR'] }), {});
});

test('migration RPC merge_candidat_axes_meta présente et sûre', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'merge_candidat_axes_meta_migration.sql'), 'utf8');
  assert.match(sql, /create or replace function public\.merge_candidat_axes_meta/);
  assert.match(sql, /jsonb_set/);
  assert.match(sql, /\|\| p_meta_patch/);
  assert.match(sql, /grant execute[\s\S]*service_role/);
  const bodyStart = sql.indexOf('as $$');
  const body = sql.slice(bodyStart);
  assert.doesNotMatch(body, /score_adn|deep_adn|drop table|delete from/i);
});

test('PUT profil route : pas de merge JS axes complet', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'candidats.js'), 'utf8');
  const start = source.indexOf("router.put('/profil'");
  const end = source.indexOf("router.get('/stats'", start);
  const block = source.slice(start, end);
  assert.match(block, /merge_candidat_axes_meta/);
  assert.match(block, /buildAxesMetaPatch/);
  assert.doesNotMatch(block, /axes:\s*nextAxes/);
  assert.doesNotMatch(block, /\.\.\.\(current\.axes/);
  assert.doesNotMatch(block, /score_adn\s*:/);
});

test('UI anti double-save profil', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'), 'utf8');
  assert.match(html, /PROFILE_SAVE_IN_FLIGHT/);
  assert.match(html, /Enregistrement…/);
  assert.match(html, /finally\s*\{[\s\S]*PROFILE_SAVE_IN_FLIGHT = false/);
});
