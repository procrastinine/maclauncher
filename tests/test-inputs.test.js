const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check, prepareSources } = require('../scripts/test-inputs.cjs');

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

test('setup in a linked worktree leaves the primary checkout module configuration unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'test-inputs-linked-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'global-config'), GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const saved = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  Object.assign(process.env, environment);
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const repository = (name, add = () => {}) => {
    const root = path.join(directory, name);
    fs.mkdirSync(root); git(root, ['init', '-q']);
    fs.writeFileSync(path.join(root, 'content.txt'), name + '\n'); add(root);
    git(root, ['add', '-A']); git(root, ['commit', '-qm', name]);
    return { root, revision: git(root, ['rev-parse', 'HEAD']) };
  };
  const leaf = repository('leaf'), plain = repository('plain'), fresh = repository('fresh');
  const nested = repository('nested', root => git(root, ['submodule', 'add', '-q', leaf.root, 'deps/leaf']));
  const primary = repository('primary', root => {
    for (const source of [plain, fresh, nested]) git(root, ['submodule', 'add', '-q', source.root, 'src/external/' + path.basename(source.root)]);
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build/source-dependencies.json'), JSON.stringify({ schemaVersion: 1,
      submodules: ['src/external/plain', 'src/external/fresh'], testSubmodules: ['src/external/nested'], recursiveSubmodules: ['src/external/nested'] }));
  }).root;
  git(primary, ['submodule', 'update', '--init', '--recursive']);
  // The primary checkout has not checked out every source, so setup initializes some sources itself.
  git(primary, ['submodule', 'deinit', '-q', '-f', 'src/external/fresh']);
  const linked = path.join(directory, 'linked');
  git(primary, ['worktree', 'add', '-q', '--detach', linked]);
  const configs = () => fs.readdirSync(path.join(primary, '.git/modules'), { recursive: true }).filter(name => path.basename(name) === 'config')
    .sort().map(name => [name, fs.readFileSync(path.join(primary, '.git/modules', name), 'utf8')]);
  const before = configs();
  assert.ok(before.length >= 3, 'The primary checkout holds its own source module configuration');
  await prepareSources(linked);
  assert.deepEqual(configs(), before);
  for (const [location, source] of [['src/external/plain', plain], ['src/external/fresh', fresh], ['src/external/nested', nested], ['src/external/nested/deps/leaf', leaf]])
    assert.equal(git(path.join(linked, location), ['rev-parse', 'HEAD']), source.revision, location);
  for (const location of ['src/external/plain', 'src/external/nested'])
    assert.equal(fs.realpathSync(git(path.join(primary, location), ['rev-parse', '--show-toplevel'])), fs.realpathSync(path.join(primary, location)));
});
