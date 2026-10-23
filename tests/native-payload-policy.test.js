const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {applyPayloadPolicy} = require('../scripts/stage-native-runtimes.cjs');

test('payload projection removes producer material while retaining runtime fonts, shaders and notices', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-payload-policy-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['bin/engine', 'build/profile.json', 'build/source.js', 'share/font.ttf', 'temporal/fsr4/build/bindings.json', 'licenses/LICENSE']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), name);
  }
  const input = {executableRelative: 'bin/engine', notices: [{path: 'licenses/LICENSE'}], runtimeFiles: {profile: 'build/profile.json', font: 'share/font.ttf'}};
  assert.throws(() => applyPayloadPolicy(root, input, {omitPaths: ['share']}), /required/);
  assert.equal(fs.existsSync(path.join(root, 'share/font.ttf')), true);
  const result = applyPayloadPolicy(root, input, require('../src/modules/ai5/runtime/payload-policy.json'));
  assert.deepEqual(result.removed, ['build/profile.json', 'build/source.js']);
  assert.deepEqual(result.runtimeFiles, {font: 'share/font.ttf'});
  assert.equal(input.runtimeFiles.profile, 'build/profile.json');
  for (const name of ['bin/engine', 'share/font.ttf', 'temporal/fsr4/build/bindings.json', 'licenses/LICENSE']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name);
});
