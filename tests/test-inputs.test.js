const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check } = require('../scripts/test-inputs.cjs');

test('incomplete declared test sources fail offline with the explicit setup command', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'test-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, stdio: 'pipe' });
  git(['init', '-q']);
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "source"]\npath = source\nurl = https://example.invalid/source.git\n');
  fs.writeFileSync(path.join(root, 'build/source-dependencies.json'), JSON.stringify({ schemaVersion: 1, submodules: ['source'] }));
  git(['add', '.gitmodules', 'build/source-dependencies.json']);
  git(['update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',source']);
  t.mock.method(globalThis, 'fetch', () => assert.fail('The test input check cannot fetch missing sources'));
  await assert.rejects(check({ repoRoot: root }), error => {
    assert.match(error.message, /Test inputs are not ready\. Run `npm run test:setup`\./);
    assert.match(error.message, /source at a{12}/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'source')), false, 'Readiness cannot initialize or create a source checkout');
});
