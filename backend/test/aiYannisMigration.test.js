const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'ai_yannis_spec_migration.sql'), 'utf8');

test('migration Yannis est additive et préserve simulation', () => {
  assert.match(sql, /add column if not exists experience_years/);
  assert.match(sql, /add column if not exists sector/);
  assert.match(sql, /'interview', 'objections', 'pitch', 'simulation'/);
  assert.doesNotMatch(sql, /drop table|truncate|delete from|drop column/i);
});
