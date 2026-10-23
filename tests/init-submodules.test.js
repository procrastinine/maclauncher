const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ROOT, parseGitModules, readPlan, initSubmodules, parseArgs, runGit } = require('../scripts/init-submodules.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'maclauncher-submodules-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'global-config'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, '');
  const git = (args, cwd = directory, input) => execFileSync('git', ['-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', ...args],
  { cwd, env: environment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const calls = [];
  const run = (args, options) => {
    calls.push({ args, mutation: !!options.mutation, cwd: options.cwd });
    return runGit(args, { ...options, environment });
  };
  function repository(name, content, child) {
    const root = path.join(directory, name);
    fs.mkdirSync(root); git(['init', '-q'], root);
    fs.writeFileSync(path.join(root, 'content.txt'), content);
    if (child) {
      fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "leaf"]\n\tpath = deps/leaf\n\turl = ' + child.url + '\n');
      git(['update-index', '--add', '--cacheinfo', '160000,' + child.revision + ',deps/leaf'], root);
    }
    git(['add', 'content.txt', ...(child ? ['.gitmodules'] : [])], root);
    git(['commit', '-qm', 'Fixture source'], root);
    return { root, revision: git(['rev-parse', 'HEAD'], root), url: pathToFileURL(root).href };
  }
  const leaf = repository('leaf', 'Pinned leaf bytes');
  const declaredLeaf = 'https://source.invalid/leaf';
  const primary = repository('primary', 'Primary source', leaf);
  const recursive = repository('recursive', 'Recursive source', { revision: leaf.revision, url: declaredLeaf });
  const root = repository('root-source', 'Launcher source');
  const entries = [
    { path: 'src/external/primary', source: primary, recursive: false },
    { path: 'src/external/recursive', source: recursive },
    { path: 'src/external/reference', source: leaf, initialize: false }
  ];
  const gitmodules = entries.map(item => '[submodule "' + item.path + '"]\n\tpath = ' + item.path + '\n\turl = ' + item.source.url + '\n' +
    (item.recursive === false ? '\tmaclauncher-recursive = false\n' : '') +
    (item.initialize === false ? '\tmaclauncher-init = false\n' : '')).join('');
  fs.writeFileSync(path.join(root.root, '.gitmodules'), gitmodules);
  fs.mkdirSync(path.join(root.root, 'scripts'));
  fs.writeFileSync(path.join(root.root, 'scripts/upstream-overlays.json'), JSON.stringify({ schemaVersion: 1, projects: [
    { id: 'recursive', path: entries[1].path, repository: recursive.url, revision: recursive.revision },
    { id: 'recursive-leaf', path: entries[1].path + '/deps/leaf', parent: 'recursive', repository: declaredLeaf,
      revision: leaf.revision, checkoutOrigin: leaf.url, checkoutOriginReason: 'Public mirror for the pinned source.' }
  ], recipes: [] }));
  for (const entry of entries) git(['update-index', '--add', '--cacheinfo', '160000,' + entry.source.revision + ',' + entry.path], root.root);
  git(['add', '.gitmodules', 'scripts/upstream-overlays.json'], root.root); git(['commit', '-qm', 'Pinned dependencies'], root.root);
  const checkout = path.join(directory, 'checkout');
  git(['clone', '--no-recurse-submodules', '-q', root.root, checkout]);
  git(['config', 'submodule.recurse', 'true'], checkout);
  git(['config', 'fetch.recurseSubmodules', 'true'], checkout);
  return { directory, checkout, entries, primary, recursive, leaf, declaredLeaf, git, run, calls };
}

test('submodule metadata rejects unsafe paths, duplicate declarations and invalid options', () => {
  const rows = values => values.map(([key, value]) => key + '\n' + value + '\0').join('');
  const valid = [['submodule.source.path', 'src/with spaces'], ['submodule.source.url', 'https://source.invalid/project'],
    ['submodule.source.maclauncher-init', 'false'], ['submodule.source.maclauncher-recursive', 'no']];
  assert.deepEqual(parseGitModules(rows(valid)), [{ name: 'source', path: 'src/with spaces', url: 'https://source.invalid/project',
    initialize: false, recursive: false }]);
  for (const unsafe of ['../source', '/tmp/source', 'src/../source', 'src/.git/source', 'src\\source', 'src//source'])
    assert.throws(() => parseGitModules(rows([['submodule.source.path', unsafe], valid[1]])), /safe repository-relative/);
  assert.throws(() => parseGitModules(rows([...valid, valid[0]])), /Duplicate submodule metadata/);
  assert.throws(() => parseGitModules(rows([...valid, ['submodule.other.path', 'SRC/with spaces'], ['submodule.other.url', valid[1][1]]])), /Duplicate submodule checkout path/);
  assert.throws(() => parseGitModules(rows([valid[0], valid[1], ['submodule.source.maclauncher-init', 'sometimes']])), /Invalid boolean/);
  assert.throws(() => parseGitModules('malformed\0'), /Invalid Git submodule metadata/);
  assert.throws(() => parseGitModules(rows([valid[0]])), /URL is missing/);
  assert.deepEqual(parseArgs(['--dry-run', '--jobs', '2', '--', 'src/with spaces']), { paths: ['src/with spaces'], dryRun: true, jobs: 2 });
  assert.throws(() => parseArgs(['src/other']), /Use --/);
});

test('actual offline initialization skips primary-only children and references, pins recursive children and preserves warm work', async t => {
  const value = fixture(t), { checkout, run, git, calls, entries, leaf } = value;
  const indexBefore = git(['ls-files', '--stage', '-z'], checkout);
  const configBefore = fs.readFileSync(path.join(checkout, '.git/config'));
  const plan = await initSubmodules({ repoRoot: checkout, run, dryRun: true });
  assert.deepEqual(plan.modules.map(item => [item.path, item.recursive]), [[entries[0].path, false], [entries[1].path, true]]);
  assert.equal(plan.skipped[0].reason, 'reference-only');
  assert.equal(plan.mirrors[0].revision, leaf.revision);
  assert.equal(git(['ls-files', '--stage', '-z'], checkout), indexBefore);
  assert.deepEqual(fs.readFileSync(path.join(checkout, '.git/config')), configBefore);
  assert.ok(entries.every(item => !fs.existsSync(path.join(checkout, item.path, '.git'))));
  assert.ok(calls.every(call => !call.mutation));
  const initialized = await initSubmodules({ repoRoot: checkout, run, jobs: 2 });
  assert.deepEqual(initialized, plan);
  const primaryPath = path.join(checkout, entries[0].path), recursivePath = path.join(checkout, entries[1].path);
  assert.equal(git(['rev-parse', 'HEAD'], primaryPath), value.primary.revision);
  assert.equal(fs.existsSync(path.join(primaryPath, 'deps/leaf/.git')), false);
  const child = path.join(recursivePath, 'deps/leaf');
  assert.equal(git(['rev-parse', 'HEAD'], child), leaf.revision);
  assert.equal(git(['config', '--get', 'remote.origin.url'], child), leaf.url);
  assert.equal(fs.existsSync(path.join(checkout, entries[2].path, '.git')), false);
  assert.equal(git(['ls-files', '--stage', '-z'], checkout), indexBefore);
  const sourceText = fs.readFileSync(path.join(recursivePath, '.gitmodules'), 'utf8');
  assert.match(sourceText, /https:\/\/source\.invalid\/leaf/);
  fs.writeFileSync(path.join(child, 'content.txt'), 'Local tracked work remains intact');
  fs.writeFileSync(path.join(leaf.root, 'content.txt'), 'New upstream branch bytes');
  git(['add', 'content.txt'], leaf.root); git(['commit', '-qm', 'Later upstream version'], leaf.root);
  await initSubmodules({ repoRoot: checkout, run });
  assert.equal(git(['rev-parse', 'HEAD'], child), leaf.revision);
  assert.equal(fs.readFileSync(path.join(child, 'content.txt'), 'utf8'), 'Local tracked work remains intact');
  assert.equal(git(['config', '--get', 'remote.origin.url'], child), leaf.url);
  assert.equal(fs.readFileSync(path.join(recursivePath, '.gitmodules'), 'utf8'), sourceText);
  await initSubmodules({ repoRoot: checkout, run, paths: [entries[2].path] });
  assert.equal(git(['rev-parse', 'HEAD'], path.join(checkout, entries[2].path)), leaf.revision);
  await initSubmodules({ repoRoot: checkout, run, all: true });
  assert.equal(fs.existsSync(path.join(primaryPath, 'deps/leaf/.git')), false);
  assert.equal(fs.readFileSync(path.join(child, 'content.txt'), 'utf8'), 'Local tracked work remains intact');
  assert.ok(calls.filter(call => call.mutation).every(call => !call.args.includes('--force') && !call.args.includes('--remote')));
});

test('missing or conflicted Gitlinks and unsafe checkout locations fail before mutation', async t => {
  const value = fixture(t), { checkout, run, git, calls, entries } = value;
  await assert.rejects(initSubmodules({ repoRoot: checkout, run, paths: ['undeclared'] }), /Unknown top-level/);
  await assert.rejects(initSubmodules({ repoRoot: checkout, run, jobs: 0 }), /jobs must/);
  fs.rmSync(path.join(checkout, 'src/external'), { recursive: true });
  fs.symlinkSync(value.directory, path.join(checkout, 'src/external'));
  await assert.rejects(initSubmodules({ repoRoot: checkout, run }), /symbolic links/);
  fs.unlinkSync(path.join(checkout, 'src/external'));
  const gitmodulesPath = path.join(checkout, '.gitmodules'), original = fs.readFileSync(gitmodulesPath);
  fs.appendFileSync(gitmodulesPath, '[submodule "missing"]\n\tpath = missing\n\turl = https://source.invalid/missing\n');
  await assert.rejects(initSubmodules({ repoRoot: checkout, run }), /Missing pinned Gitlink/);
  fs.writeFileSync(gitmodulesPath, original);
  git(['update-index', '--index-info'], checkout, '0 ' + '0'.repeat(40) + '\t' + entries[0].path + '\n' +
    '160000 ' + entries[0].source.revision + ' 1\t' + entries[0].path + '\n' +
    '160000 ' + entries[0].source.revision + ' 2\t' + entries[0].path + '\n');
  await assert.rejects(initSubmodules({ repoRoot: checkout, run }), /unambiguous staged Gitlinks/);
  assert.ok(calls.every(call => !call.mutation));
});

test('mirror pin drift refuses origin rewriting', async t => {
  const value = fixture(t), { checkout, run, git } = value;
  const file = path.join(checkout, 'scripts/upstream-overlays.json');
  const inventory = JSON.parse(fs.readFileSync(file));
  inventory.projects[1].revision = 'a'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(inventory));
  await assert.rejects(initSubmodules({ repoRoot: checkout, run }), /checkout differs from its pinned Gitlink/);
  assert.equal(git(['config', '--get', 'remote.origin.url'], path.join(checkout, 'src/external/recursive/deps/leaf')), value.declaredLeaf);
});

test('production checkout metadata matches every top-level source pin without initializing references', async () => {
  const plan = await readPlan();
  const yuri = plan.modules.find(item => item.path === 'src/external/onscripter-yuri');
  assert.ok(yuri); assert.equal(yuri.recursive, false);
  assert.ok(plan.modules.filter(item => item !== yuri).every(item => item.recursive));
  assert.ok(plan.skipped.length > 0 && plan.skipped.every(item => item.reason === 'reference-only'));
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/upstream-overlays.json')));
  const top = new Map([...plan.modules, ...plan.skipped].map(item => [item.path, item]));
  const projects = new Map(inventory.projects.map(item => [item.id, item]));
  for (const project of inventory.projects) {
    assert.ok(project.path, project.id + ' needs a tracked checkout path');
    if (!project.parent) assert.equal(top.get(project.path)?.revision, project.revision, project.id);
    else {
      const parent = projects.get(project.parent);
      assert.ok(parent && project.path.startsWith(parent.path + '/'), project.id + ' needs its actual parent checkout');
      assert.equal(top.has(project.path), false, 'Nested sources retain the upstream parent Gitlink');
    }
  }
  assert.equal(plan.mirrors.length, inventory.projects.filter(project => project.checkoutOrigin &&
    plan.modules.some(item => project.path === item.path || item.recursive && project.path.startsWith(item.path + '/'))).length);
});
