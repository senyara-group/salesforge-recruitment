const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeOfferStructuredFields,
  MAX_JOB_TYPE,
  MAX_SECTOR,
  MAX_SALARY,
} = require('../utils/offerWrite');

test('contract_type valide / invalide ; canonicalisation depuis type', () => {
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', contract_type: 'CDI' }).contract_type, 'CDI');
  assert.equal(normalizeOfferStructuredFields({ type: 'Freelance' }).contract_type, 'Freelance');
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', contract_type: 'Stage' }), /contract_type invalide/);
});

test('remote_mode valide / invalide ; vide → null ; pas nationwide', () => {
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', remote_mode: 'hybrid' }).remote_mode, 'hybrid');
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', remote_mode: '' }).remote_mode, null);
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', remote_mode: 'nationwide' }), /remote_mode invalide/);
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', remote_mode: 'France entière' }), /remote_mode invalide/);
});

test('salary min/max bornés ; max < min rejeté', () => {
  const ok = normalizeOfferStructuredFields({
    type: 'CDI',
    salary_fixed_min: 35000,
    salary_fixed_max: 45000,
  });
  assert.equal(ok.salary_fixed_min, 35000);
  assert.equal(ok.salary_fixed_max, 45000);
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', salary_fixed_min: '' }).salary_fixed_min, null);
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', salary_fixed_min: -1 }), /salary_fixed_min invalide/);
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', salary_fixed_min: MAX_SALARY + 1 }), /salary_fixed_min invalide/);
  assert.throws(
    () => normalizeOfferStructuredFields({ type: 'CDI', salary_fixed_min: 50000, salary_fixed_max: 40000 }),
    /salary_fixed_max doit être/
  );
});

test('job_type et sector : trim, longueur, vide → null', () => {
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', job_type: '  AE SaaS  ' }).job_type, 'AE SaaS');
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', job_type: '   ' }).job_type, null);
  assert.equal(normalizeOfferStructuredFields({ type: 'CDI', sector: '  Fintech ' }).sector, 'Fintech');
  assert.throws(
    () => normalizeOfferStructuredFields({ type: 'CDI', job_type: 'x'.repeat(MAX_JOB_TYPE + 1) }),
    /job_type trop long/
  );
  assert.throws(
    () => normalizeOfferStructuredFields({ type: 'CDI', sector: 'y'.repeat(MAX_SECTOR + 1) }),
    /sector trop long/
  );
});

test('tags vides restent [] ; hors vocabulaire refusés ; pas d’injection implicite', () => {
  assert.deepEqual(normalizeOfferStructuredFields({ type: 'CDI' }).tags, []);
  assert.deepEqual(normalizeOfferStructuredFields({ type: 'CDI', tags: [] }).tags, []);
  assert.deepEqual(
    normalizeOfferStructuredFields({ type: 'CDI', tags: ['SaaS', 'Closing'] }).tags,
    ['SaaS', 'Closing']
  );
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', tags: ['Inconnu'] }), /tags invalide/);
  assert.throws(() => normalizeOfferStructuredFields({ type: 'CDI', tags: 'SaaS' }), /tags doit être un tableau/);
});

test('legacy type / salaire texte non parsés pour remplir les champs structurés', () => {
  const result = normalizeOfferStructuredFields({
    type: 'CDI',
    salaire: '45-65K€ + variable',
    lieu: 'Remote / Télétravail',
  });
  assert.equal(result.salary_fixed_min, null);
  assert.equal(result.salary_fixed_max, null);
  assert.equal(result.remote_mode, null);
  assert.equal(result.contract_type, 'CDI');
});

test('routes offres branchent les champs structurés à l’écriture', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'offres.js'), 'utf8');
  assert.match(source, /normalizeOfferStructuredFields/);
  assert.match(source, /contract_type: structured\.contract_type/);
  assert.match(source, /remote_mode: structured\.remote_mode/);
  assert.match(source, /salary_fixed_min: structured\.salary_fixed_min/);
  assert.match(source, /salary_fixed_max: structured\.salary_fixed_max/);
  assert.match(source, /job_type: structured\.job_type/);
  assert.match(source, /sector: structured\.sector/);
  assert.match(source, /tags: structured\.tags/);
});
