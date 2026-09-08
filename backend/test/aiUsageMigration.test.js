const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'ai_usage_migration.sql'),
  'utf8',
);

test('RPC quota sont SECURITY DEFINER avec search_path vide et service_role seul', () => {
  assert.equal((sql.match(/security definer set search_path = ''/gi) || []).length, 3);
  assert.equal((sql.match(/grant execute on function public\.(?:reserve|finalize|release)_ai_usage[^;]+to service_role/gi) || []).length, 3);
  assert.equal((sql.match(/revoke all on function public\.(?:reserve|finalize|release)_ai_usage[^;]+from public, anon, authenticated/gi) || []).length, 3);
});

test('RLS limite les lectures et masque les réservations', () => {
  assert.match(sql, /Users read own AI usage[\s\S]+auth\.uid\(\) = user_id/);
  assert.match(sql, /Users read own AI usage events[\s\S]+auth\.uid\(\) = user_id/);
  assert.match(sql, /revoke all on public\.ai_monthly_usage, public\.ai_usage_reservations, public\.ai_usage_events from authenticated/);
  assert.match(sql, /grant select on public\.ai_monthly_usage, public\.ai_usage_events to authenticated/);
  assert.doesNotMatch(sql, /grant select on public\.ai_usage_reservations/);
});

test('TTL réservation laisse une marge au timeout CV sans données sensibles', () => {
  assert.match(sql, /interval '3 minutes'/);
  assert.ok(3 * 60 > 55);
  const eventColumns = sql.match(/create table if not exists public\.ai_usage_events \(([\s\S]*?)\n\);/i)?.[1] || '';
  assert.doesNotMatch(eventColumns, /prompt|response|content|cv_text/i);
});
