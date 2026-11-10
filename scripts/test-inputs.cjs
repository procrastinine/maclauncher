#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Sources = require('./init-submodules.cjs');
const ROOT = path.resolve(__dirname, '..');
const COMMAND = 'npm run test:setup';
const git = (root, args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function sourceReady(root, source) {
  const directory = path.join(root, source.path);
  try {
    return !fs.lstatSync(directory).isSymbolicLink() &&
      fs.realpathSync(git(directory, ['rev-parse', '--show-toplevel'])) === fs.realpathSync(directory) &&
      git(directory, ['rev-parse', 'HEAD']) === source.revision;
  } catch { return false; }
}

const primaryOf = root => git(root, ['worktree', 'list', '--porcelain']).split('\n').find(line => line.startsWith('worktree ')).slice(9);

// True when `existing` is a checkout of its own repository and that repository holds `revision`.
function holds(existing, revision) {
  try {
    if (fs.realpathSync(git(existing, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(existing)) return false;
    git(existing, ['cat-file', '-e', revision + '^{commit}']);
    return true;
  } catch { return false; }
}

// Attach `existing`, a checkout of the primary worktree, at `target` as a detached worktree of
// its own repository at `revision`; false when it is not a repository holding that commit.
function attach(existing, target, revision) {
  if (fs.existsSync(target) && fs.readdirSync(target).length || !holds(existing, revision)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmdirSync(target);
  git(existing, ['worktree', 'add', '--detach', target, revision]);
  return true;
}

// The nested sources of an attached source, each attached from the primary's checkout of it at
// the commit the attached tree records.
function attachNested(existing, target, root, notAttached) {
  for (const line of git(target, ['ls-files', '--stage']).split('\n')) {
    const match = /^160000 ([0-9a-f]{40}) \d\t(.+)$/.exec(line);
    if (!match) continue;
    const [, revision, location] = match, nested = path.join(target, location);
    if (fs.existsSync(path.join(nested, '.git'))) continue;
    if (attach(path.join(existing, location), nested, revision)) attachNested(path.join(existing, location), nested, root, notAttached);
    else notAttached.push(path.relative(root, nested));
  }
}

async function prepareSources(repoRoot) {
  const plan = await Sources.readPlan({ repoRoot });
  const primary = primaryOf(repoRoot);
  const linked = fs.realpathSync(primary) !== fs.realpathSync(repoRoot);
  // A linked app checkout shares the primary worktree's existing source repositories. No source
  // checkout, index, branch or configuration of the primary worktree is changed. A source with
  // nested sources is never cloned here: it is attached from the primary's checkout together with
  // its nested sources, or left out with a message when the primary has no checkout at its pin.
  if (linked) {
    for (const source of plan.modules) {
      if (sourceReady(repoRoot, source)) continue;
      const target = path.join(repoRoot, source.path), existing = path.join(primary, source.path);
      if (!attach(existing, target, source.revision)) {
        if (source.recursive) console.warn('test-inputs: ' + source.path + ' has nested sources and the primary checkout ' + primary +
          ' holds no checkout of it at ' + source.revision.slice(0, 12) + '; a linked worktree does not clone it. Initialize it in the primary checkout.');
        continue;
      }
      if (!source.recursive) continue;
      const notAttached = [];
      attachNested(existing, target, repoRoot, notAttached);
      if (notAttached.length) console.warn('test-inputs: the primary checkout holds no checkout of ' + notAttached.join(', ') + '; a linked worktree does not clone them.');
    }
  }
  const pending = plan.modules.filter(source => !(linked && source.recursive) && !sourceReady(repoRoot, source)).map(source => source.path);
  if (pending.length) await Sources.initSubmodules({ repoRoot, select: pending });
  return plan;
}

async function check({ repoRoot = ROOT } = {}) {
  const problems = [];
  try {
    const plan = await Sources.readPlan({ repoRoot });
    const leftOut = [];
    for (const source of plan.modules) {
      if (sourceReady(repoRoot, source)) continue;
      // A linked worktree leaves out a source with nested sources that the primary worktree has
      // not checked out at its pin.
      const primary = source.recursive && primaryOf(repoRoot);
      if (primary && fs.realpathSync(primary) !== fs.realpathSync(repoRoot) && !holds(path.join(primary, source.path), source.revision)) leftOut.push(source.path);
      else problems.push(source.path + ' at ' + source.revision.slice(0, 12));
    }
    if (problems.length) throw new Error(problems.join(', '));
    const regular = (file, expected) => {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular input: ' + path.relative(repoRoot, file));
      const bytes = fs.readFileSync(file);
      if (bytes.length !== expected.size || sha(bytes) !== expected.sha256) throw new Error('Changed input: ' + path.relative(repoRoot, file));
    };
    const native = path.join(repoRoot, 'src/modules/android/native');
    for (const name of ['asm-binary.json', 'apksig-binary.json']) {
      for (const pin of JSON.parse(fs.readFileSync(path.join(native, name))).files)
        regular(path.join(native, 'tools', pin.path), pin);
    }
    const encoding = path.join(repoRoot, 'src/modules/catsystem2/resources/encoding');
    const cp932 = JSON.parse(fs.readFileSync(path.join(encoding, 'cp932.json')));
    regular(path.join(encoding, cp932.table), { size: cp932.tableBytes, sha256: cp932.tableSha256 });
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'build/runtime-packages.json')));
    const resources = path.join(repoRoot, 'src/resources');
    const B = require('../src/modules/shared/runtime/bundled-native');
    const P = require('../src/modules/shared/runtime/package-dependencies');
    for (const record of lock.packages) {
      const declaration = JSON.parse(B.readRegular(path.join(resources, 'native-runtimes/.declarations', record.asset.sha256 + '.json'), B.LIMITS.manifestBytes).bytes);
      P.assertDeclaration(declaration, record);
      const manifest = B.readRegular(path.join(resources, 'native-runtimes', declaration.directoryRelative, record.manifestRelative), B.LIMITS.manifestBytes);
      if (manifest.sha256 !== record.manifestSha256) throw new Error('Changed included package: ' + record.id);
    }
    const preparedLock = JSON.parse(fs.readFileSync(path.join(resources, 'runtime-packages.json')));
    if (JSON.stringify(preparedLock) !== JSON.stringify(lock)) throw new Error('Prepared package lock differs from build/runtime-packages.json');
    const tools = require('../tests/helpers/android-fixture-tools.cjs').paths(repoRoot);
    for (const name of ['aapt2', 'android', 'r8']) {
      if (!fs.lstatSync(tools[name]).isFile()) throw new Error('Missing Android fixture tool: ' + name);
    }
    if (leftOut.length) console.warn('test-inputs: left out ' + leftOut.join(', ') + ', which the primary checkout has not checked out.');
    return { ready: true, sources: plan.modules.length - leftOut.length, packages: lock.packages.length, ...(leftOut.length ? { leftOut } : {}) };
  } catch (error) {
    throw new Error('Test inputs are not ready. Run `' + COMMAND + '`. ' + error.message.replace(/\s+/g, ' '), { cause: error });
  }
}

async function setup({ repoRoot = ROOT } = {}) {
  await prepareSources(repoRoot);
  await require('./published-inputs.cjs').prepareDeclaredPublishers({ repoRoot });
  await require('../src/modules/catsystem2/runtime/stage-cp932.cjs').prepare({ repoRoot });
  const R = require('./runtime-packages.cjs');
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, R.LOCK)));
  for (const arch of lock.architectures) await R.fetchPackages({ repoRoot, lock: R.readLock({ repoRoot, arch }) });
  const tools = await require('../tests/helpers/android-fixture-tools.cjs').prepareTools({ root: repoRoot, fetch: true });
  if (!tools.ready) throw new Error(tools.reason);
  return check({ repoRoot });
}

module.exports = { check, setup, prepareSources };
if (require.main === module) {
  const action = process.argv[2];
  Promise.resolve().then(() => {
    if (process.argv.length !== 3 || !['check', 'setup'].includes(action)) throw new Error('Usage: node scripts/test-inputs.cjs check|setup');
    return action === 'setup' ? setup() : check();
  }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
