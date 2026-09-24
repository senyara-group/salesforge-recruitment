const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PIN, checkRuntime } = require('../scripts/check-runtime');
const config = {
  pkg: require('../package.json'), lock: require('../package-lock.json'), railway: require('../../railway.json'),
  nixpacks: fs.readFileSync(path.join(__dirname, '../../nixpacks.toml'), 'utf8'), version: PIN.node, deployment: true,
};
test('Railway install/start and Node engines match the verified Nix archive', () => checkRuntime(config));
test('runtime check rejects old Node, missing archive and drifting deployment version', () => {
  assert.throws(() => checkRuntime({ ...config, version: '22.11.0' }));
  assert.throws(() => checkRuntime({ ...config, nixpacks: config.nixpacks.replace(PIN.archive, 'missing') }));
  assert.throws(() => checkRuntime({ ...config, version: '22.15.0' }));
});
