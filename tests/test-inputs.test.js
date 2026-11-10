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

// A primary checkout with a plain source, a source it has not checked out, and a source with a
// nested source (recursive), plus a linked worktree of it.
function linkedFixture(t, { deinit = [] } = {}) {
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
  const nested = repository('nested', root => git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leaf.root, 'deps/leaf']));
  const primary = repository('primary', root => {
    for (const source of [plain, fresh, nested]) git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'src/external/' + path.basename(source.root)]);
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build/source-dependencies.json'), JSON.stringify({ schemaVersion: 1,
      submodules: ['src/external/plain', 'src/external/fresh'], testSubmodules: ['src/external/nested'], recursiveSubmodules: ['src/external/nested'] }));
  }).root;
  git(primary, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive']);
  // The primary checkout has not checked out every source, so setup initializes some sources itself.
  for (const location of ['src/external/fresh', ...deinit]) git(primary, ['submodule', 'deinit', '-q', '-f', location]);
  const linked = path.join(directory, 'linked');
  git(primary, ['worktree', 'add', '-q', '--detach', linked]);
  return { git, primary, linked, leaf, plain, fresh, nested };
}

test('setup in a linked worktree leaves the primary checkout module configuration unchanged', async t => {
  const { git, primary, linked, leaf, plain, fresh, nested } = linkedFixture(t);
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

test('a linked worktree attaches a source with nested sources from the primary and never clones it', async t => {
  const { git, primary, linked } = linkedFixture(t);
  // Readiness asks for setup while the primary holds a checkout this worktree has not attached.
  await assert.rejects(check({ repoRoot: linked }), /src\/external\/nested at /);
  await prepareSources(linked);
  // Each checkout of the recursive source and its nested source is a worktree of the primary's repository.
  for (const [location, store] of [['src/external/nested', 'src/external/nested'], ['src/external/nested/deps/leaf', 'src/external/nested/modules/deps/leaf']])
    assert.equal(fs.realpathSync(path.resolve(path.join(linked, location), git(path.join(linked, location), ['rev-parse', '--git-common-dir']))),
      fs.realpathSync(path.join(primary, '.git/modules', store)), location);
  assert.equal(fs.existsSync(path.join(primary, '.git/worktrees/linked/modules/src/external/nested')), false, 'No second repository of the recursive source');
});

test('a linked worktree leaves out a source with nested sources that the primary has not checked out', async t => {
  const { primary, linked, plain } = linkedFixture(t, { deinit: ['src/external/nested'] });
  const warnings = [];t.mock.method(console, 'warn', message => warnings.push(String(message)));
  await prepareSources(linked);
  assert.equal(fs.existsSync(path.join(linked, 'src/external/nested/.git')), false, 'The recursive source is not cloned');
  assert.equal(fs.existsSync(path.join(primary, '.git/worktrees/linked/modules/src/external/nested')), false);
  assert.match(warnings.join('\n'), /src\/external\/nested has nested sources .* a linked worktree does not clone it/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(linked, 'src/external/plain'), encoding: 'utf8' }).trim(), plain.revision);
  // Readiness leaves it out as well and goes on to the package inputs, which this fixture lacks.
  await assert.rejects(check({ repoRoot: linked }), error => {
    assert.doesNotMatch(error.message, /src\/external\//);
    assert.match(error.message, /asm-binary\.json/);
    return true;
  });
});

test('a primary checkout attaches a source with nested sources from the local clone of its repository and never clones it', async t => {
  const { git, primary, nested, leaf } = linkedFixture(t, { deinit: ['src/external/nested'] });
  // Each source repository is the one local clone of itself, beside the primary checkout.
  for (const source of [nested, leaf]) git(source.root, ['remote', 'add', 'origin', source.root]);
  fs.rmSync(path.join(primary, '.git/modules/src/external/nested'), { recursive: true, force: true });
  await assert.rejects(check({ repoRoot: primary }), /src\/external\/nested at /);
  await prepareSources(primary);
  const commonDirectory = location => fs.realpathSync(path.resolve(path.join(primary, location), git(path.join(primary, location), ['rev-parse', '--git-common-dir'])));
  assert.equal(commonDirectory('src/external/nested'), fs.realpathSync(path.join(nested.root, '.git')));
  assert.equal(commonDirectory('src/external/nested/deps/leaf'), fs.realpathSync(path.join(nested.root, '.git/modules/deps/leaf')));
  assert.equal(git(path.join(primary, 'src/external/nested'), ['rev-parse', 'HEAD']), nested.revision);
  assert.equal(git(path.join(primary, 'src/external/nested/deps/leaf'), ['rev-parse', 'HEAD']), leaf.revision);
  assert.equal(fs.existsSync(path.join(primary, '.git/modules/src/external/nested')), false, 'The recursive source is not cloned');
  await assert.rejects(check({ repoRoot: primary }), error => {
    assert.doesNotMatch(error.message, /src\/external\//);
    return true;
  });
});

test('a primary checkout leaves out a source with nested sources that the local clone of its repository does not hold', async t => {
  const { git, primary, nested } = linkedFixture(t, { deinit: ['src/external/nested'] });
  // The local clone is another repository that has never fetched the pinned commit.
  const clone = path.join(path.dirname(nested.root), 'clone-root');
  fs.mkdirSync(clone); git(clone, ['init', '-q']); git(clone, ['remote', 'add', 'origin', nested.root]);
  fs.renameSync(nested.root, nested.root + '-published'); fs.renameSync(clone, nested.root);
  fs.rmSync(path.join(primary, '.git/modules/src/external/nested'), { recursive: true, force: true });
  const warnings = []; t.mock.method(console, 'warn', message => warnings.push(String(message)));
  await prepareSources(primary);
  assert.equal(fs.existsSync(path.join(primary, 'src/external/nested/.git')), false, 'The recursive source is not cloned');
  assert.equal(fs.existsSync(path.join(primary, '.git/modules/src/external/nested')), false);
  assert.match(warnings.join('\n'), /src\/external\/nested has nested sources .* setup does not clone it/);
  await assert.rejects(check({ repoRoot: primary }), error => {
    assert.doesNotMatch(error.message, /src\/external\//);
    assert.match(error.message, /asm-binary\.json/);
    return true;
  });
});
