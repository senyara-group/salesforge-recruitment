// Harnais de test des decks (/offres/deck, /candidats/deck) : faux PostgREST en
// mémoire (sémantique NULL de PostgreSQL) + vraies routes Express. Doit être
// requis AVANT les routes : il remplace ../supabase et les middlewares d'accès.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function readPath(row, column) {
  const parts = column.split(/->>|->/);
  let value = row[parts[0]];
  for (const key of parts.slice(1)) value = value == null || typeof value !== 'object' ? undefined : value[key];
  if (value === undefined) return null;
  if (column.includes('->>') && value !== null) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  return value;
}
function compare(op, actual, raw) {
  if (op === 'is') return raw === 'null' ? actual == null : String(actual) === raw;
  if (actual == null) return false; // NULL op x -> NULL -> exclu
  if (op === 'eq') return String(actual) === raw;
  if (op === 'neq') return String(actual) !== raw;
  const num = (v) => (typeof v === 'number' ? v : Number.isFinite(Number(v)) && String(v).trim() !== '' && !/^\d{4}-/.test(String(v)) ? Number(v) : v);
  if (op === 'lt') return num(actual) < num(raw);
  if (op === 'lte') return num(actual) <= num(raw);
  if (op === 'gte') return num(actual) >= num(raw);
  throw new Error(`op non supporté: ${op}`);
}
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { out.push(current); current = ''; } else current += char;
  }
  out.push(current);
  return out;
}
function orCondition(expression) {
  if (expression.startsWith('and(')) {
    const inner = splitTopLevel(expression.slice(4, -1)).map(orCondition);
    return (row) => inner.every((fn) => fn(row));
  }
  const [column, op, ...rest] = expression.split('.');
  const raw = rest.join('.');
  return (row) => compare(op, readPath(row, column), raw);
}
function makeQuery(rows, log) {
  const predicates = [];
  let limit = Infinity;
  const order = [];
  const api = {
    select() { return api; },
    eq(column, value) { log.push(['eq', column, value]); predicates.push((row) => compare('eq', readPath(row, column), String(value))); return api; },
    neq(column, value) { predicates.push((row) => compare('neq', readPath(row, column), String(value))); return api; },
    is(column, value) { predicates.push((row) => readPath(row, column) == null && value === null); return api; },
    in(column, values) { log.push(['in', column, values]); predicates.push((row) => values.map(String).includes(String(readPath(row, column)))); return api; },
    gte(column, value) { log.push(['gte', column, value]); predicates.push((row) => compare('gte', readPath(row, column), value)); return api; },
    lt(column, value) { predicates.push((row) => compare('lt', readPath(row, column), value)); return api; },
    not(column, op, list) {
      assert.equal(op, 'in');
      const values = list.slice(1, -1).split(',');
      predicates.push((row) => { const v = readPath(row, column); return v != null && !values.includes(String(v)); });
      return api;
    },
    overlaps(column, values) {
      log.push(['overlaps', column, values]);
      predicates.push((row) => { const v = readPath(row, column); return Array.isArray(v) && v.some((x) => values.includes(x)); });
      return api;
    },
    or(expression) {
      log.push(['or', expression]);
      const branches = splitTopLevel(expression).map(orCondition);
      predicates.push((row) => branches.some((fn) => fn(row)));
      return api;
    },
    filter(column, op, pattern) {
      log.push(['filter', column, op, pattern]);
      assert.equal(op, 'match');
      const regex = new RegExp(pattern);
      predicates.push((row) => { const v = readPath(row, column); return typeof v === 'string' && regex.test(v); });
      return api;
    },
    order(column, { ascending }) { order.push([column, ascending]); return api; },
    limit(n) { limit = n; return api; },
    maybeSingle() { return api.then((result) => ({ data: result.data[0] || null, error: null })); },
    then(resolve, reject) {
      let out = rows.filter((row) => predicates.every((fn) => fn(row)));
      for (const [column, ascending] of [...order].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[column]; const bv = b[column];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return Promise.resolve({ data: out.slice(0, limit), error: null }).then(resolve, reject);
    },
  };
  return api;
}

function createDeckHarness() {
  const db = {
    users: [{ id: 'user-rec', role: 'recruteur' }, { id: 'user-cand', role: 'candidat' }],
    recruteurs: [{ id: 'rec-1', user_id: 'user-rec', matching: {} }],
    candidatures: [],
    matchs: [],
    offres: [],
    candidats: [],
  };
  const queryLog = [];
  const fakeSupabase = {
    from(table) { return makeQuery(db[table] || [], queryLog); },
    storage: { from() { return { createSignedUrl: async () => ({ data: null, error: { message: 'none' } }) }; } },
  };
  const backend = path.resolve(__dirname, '../..');
  const mockModule = (request, exports) => {
    const filename = require.resolve(path.join(backend, request));
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  };
  mockModule('supabase', fakeSupabase);
  mockModule('middleware/auth', (req, _res, next) => { req.user = { id: req.headers['x-test-user'] || 'user-cand' }; next(); });
  mockModule('middleware/requireCandidatePlan', () => (_req, _res, next) => next());
  mockModule('middleware/requireRecruiterPlan', (_req, _res, next) => next());
  mockModule('utils/anthropic', { askClaude: async () => '' });
  mockModule('utils/cvReplacement', { finalizeCvReplacement: async () => ({}) });
  mockModule('utils/ebookAccess', { accessibleEbooks: () => [] });
  mockModule('utils/brevoEvents', { trackBrevoEvent: async () => {}, upsertBrevoContact: async () => {} });
  mockModule('utils/profiles', {
    ensureCandidateProfile: async (userId) => {
      const row = db.candidats.find((c) => c.user_id === userId);
      if (!row) { const e = new Error('Acces reserve aux profils candidats'); e.status = 403; throw e; }
      return row;
    },
    ensureRecruiterProfile: async (userId) => {
      const row = db.recruteurs.find((r) => r.user_id === userId);
      if (!row) { const e = new Error('Acces reserve aux profils recruteurs'); e.status = 403; throw e; }
      return row;
    },
    getCandidatePlan: async () => 'freemium',
    checkAndConsumeUsage: async () => ({ allowed: true }),
    getUserEmail: async () => '',
  });

  const app = express();
  app.use(express.json());
  app.use('/offres', require(path.join(backend, 'routes/offres')));
  app.use('/candidats', require(path.join(backend, 'routes/candidats')));

  async function get(url, user) {
    const server = app.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers: { 'x-test-user': user } });
      return { status: response.status, body: await response.json() };
    } finally {
      server.close();
    }
  }
  return { db, queryLog, get };
}

module.exports = { createDeckHarness };
