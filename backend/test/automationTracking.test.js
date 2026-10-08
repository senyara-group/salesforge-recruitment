const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.resolve(__dirname, '../../frontend');

test('adn_started is sent when the questionnaire really opens, even before tracking finished loading', async () => {
  const html = fs.readFileSync(path.join(frontend, '_spaces/candidat.html'), 'utf8');
  const questionnaire = html.slice(html.indexOf('function showAdnQuestionnaire()'), html.indexOf('function formatAdnEligibleDate'));
  assert.ok(questionnaire.includes('SwipAutomation?.adnStarted()'), 'hooked on the real questionnaire display');
  assert.ok(!html.includes("if (id === 'ts-jobs') globalThis.SwipAutomation"), 'not only on the "Retour" button');

  const calls = [];
  let releaseConfig;
  const configReady = new Promise((resolve) => { releaseConfig = resolve; });
  const sandbox = {
    API: '/api', TOKEN: 'token', document: { hidden: false, getElementById: () => null, querySelector: () => null, addEventListener() {} },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Date,
    fetch: async (url, options = {}) => {
      calls.push(`${options.method || 'GET'} ${url}`);
      if (url === '/api/config') { await configReady; return { json: async () => ({ AUTOMATION_ENABLED: true }) }; }
      if (url.endsWith('/preferences')) return { ok: true, status: 200, json: async () => ({ marketing_enabled: false }) };
      return { ok: true, status: 204 };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(frontend, 'automation-tracking.js'), 'utf8'), sandbox);
  await sandbox.SwipAutomation.adnStarted();
  assert.ok(!calls.some((c) => c.includes('adn-started')), 'nothing sent before the deployment flag is known');
  releaseConfig();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c === 'POST /api/automation/adn-started').length, 1);
  await sandbox.SwipAutomation.adnStarted();
  assert.equal(calls.filter((c) => c === 'POST /api/automation/adn-started').length, 1, 'once per page');
});
