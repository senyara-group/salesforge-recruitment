const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PIN = Object.freeze({ archive: 'e6f23dc08d3624daab7094b701aa3954923c6bbb', node: '22.14.0', minimum: '22.13.0' });
function atLeast(version, minimum) {
  const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true;
}
function checkRuntime({ pkg, lock, nixpacks, railway, version, deployment = false }) {
  assert.equal(pkg.engines.node, '>=' + PIN.minimum, 'Unexpected Node engine contract');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node, 'Lockfile engine mismatch');
  assert.ok(atLeast(version, PIN.minimum), 'Node >=22.13.0 required');
  assert.match(nixpacks, /nixPkgs\s*=\s*\["nodejs_22"\]/);
  assert.ok(nixpacks.includes(`nixpkgsArchive = "${PIN.archive}"`), 'Missing verified Nix archive');
  assert.ok(nixpacks.includes('npm --prefix backend ci --omit=optional'));
  assert.equal(railway.build.builder, 'NIXPACKS');
  assert.equal(railway.deploy.startCommand, 'npm --prefix backend start');
  assert.ok(nixpacks.includes(railway.deploy.startCommand));
  assert.ok(atLeast(PIN.node, PIN.minimum));
  if (deployment) assert.equal(version, PIN.node, 'Deployment runtime differs from the pinned Nix archive');
}
if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  checkRuntime({
    pkg: require('../package.json'), lock: require('../package-lock.json'),
    nixpacks: fs.readFileSync(path.join(root, 'nixpacks.toml'), 'utf8'),
    railway: require('../../railway.json'), version: process.versions.node,
    deployment: process.argv.includes('--deployment'),
  });
  console.log(`Runtime OK: Node ${process.versions.node}; deployment pin ${PIN.node}`);
}
module.exports = { PIN, checkRuntime };
