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

const normalized = url => String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();

// The repository URL of each source a checkout declares, by path.
function sourceUrls(checkout) {
  const names = new Map(), urls = new Map();
  let lines = [];
  try { lines = git(checkout, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$']).split('\n'); } catch { return urls; }
  for (const line of lines) {
    const match = /^submodule\.(.+)\.(path|url) (.+)$/.exec(line);
    if (match) names.set(match[1], { ...names.get(match[1]), [match[2]]: match[3] });
  }
  for (const { path: location, url } of names.values()) if (location && url) urls.set(location, url);
  return urls;
}

// The one local clone of a source's repository: the checkout beside the primary worktree that is
// named after the repository and whose origin is that repository.
function canonicalClone(primary, url) {
  const name = path.posix.basename(normalized(url));
  if (!name || !url) return null;
  const clone = path.join(path.dirname(primary), name);
  try { return normalized(git(clone, ['remote', 'get-url', 'origin'])) === normalized(url) ? clone : null; } catch { return null; }
}

// The repositories a source can be attached from: in a linked worktree, the primary checkout's
// checkout of it; in any checkout, the one local clone of its repository.
function origins(repoRoot, primary, location, url) {
  const linked = fs.realpathSync(primary) !== fs.realpathSync(repoRoot);
  return [linked && path.join(primary, location), canonicalClone(primary, url)].filter(Boolean);
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

// The nested sources of an attached source, each attached at the commit the attached tree records,
// from the attached repository's own checkout of it or from the one local clone of its repository.
function attachNested(existing, target, root, notAttached, primary) {
  const urls = sourceUrls(target);
  for (const line of git(target, ['ls-files', '--stage']).split('\n')) {
    const match = /^160000 ([0-9a-f]{40}) \d\t(.+)$/.exec(line);
    if (!match) continue;
    const [, revision, location] = match, nested = path.join(target, location);
    if (fs.existsSync(path.join(nested, '.git'))) continue;
    const used = [path.join(existing, location), canonicalClone(primary, urls.get(location))].filter(Boolean).find(candidate => attach(candidate, nested, revision));
    if (used) attachNested(used, nested, root, notAttached, primary);
    else notAttached.push(path.relative(root, nested));
  }
}

async function prepareSources(repoRoot) {
  const plan = await Sources.readPlan({ repoRoot });
  const primary = primaryOf(repoRoot), urls = sourceUrls(repoRoot);
  const linked = fs.realpathSync(primary) !== fs.realpathSync(repoRoot);
  // A source is attached as a detached worktree of an existing repository: in a linked app checkout,
  // the primary worktree's checkout of it, and in any checkout, the one local clone of its repository
  // beside the primary worktree. No source checkout, index, branch or configuration of the primary
  // worktree or of that clone is changed. A source with nested sources that can be attached is never
  // cloned here: it is attached together with its nested sources, or left out with a message when
  // no such repository holds its pin. Only a checkout with no such repository clones it.
  const attachable = new Set();
  for (const source of plan.modules) {
    const candidates = origins(repoRoot, primary, source.path, urls.get(source.path));
    if (!candidates.length) continue;
    if (source.recursive) attachable.add(source.path);
    const target = path.join(repoRoot, source.path), ready = sourceReady(repoRoot, source);
    const existing = candidates.find(candidate => ready ? holds(candidate, source.revision) : attach(candidate, target, source.revision));
    if (!existing) {
      if (!ready && source.recursive) console.warn('test-inputs: ' + source.path + ' has nested sources and ' + (linked ? 'the primary checkout ' + primary : candidates.join(' and ')) +
        ' holds no checkout of it at ' + source.revision.slice(0, 12) + '; ' + (linked ? 'a linked worktree does not clone it. Initialize it in the primary checkout.' : 'setup does not clone it. Fetch that commit there.'));
      continue;
    }
    if (!source.recursive) continue;
    const notAttached = [];
    attachNested(existing, target, repoRoot, notAttached, primary);
    if (notAttached.length) console.warn('test-inputs: no local repository holds a checkout of ' + notAttached.join(', ') + '; ' + (linked ? 'a linked worktree' : 'setup') + ' does not clone them.');
  }
  const pending = plan.modules.filter(source => !attachable.has(source.path) && !sourceReady(repoRoot, source)).map(source => source.path);
  if (pending.length) await Sources.initSubmodules({ repoRoot, select: pending });
  return plan;
}

// A checkout whose tracked .gitmodules is not written to its working tree (for example
// skip-worktree) cannot read its source plan; setup cannot repair that either.
function assertSourceDeclarations(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) return;
  let tracked = '';
  try { tracked = git(repoRoot, ['ls-files', '-v', '--', '.gitmodules']); } catch {}
  if (!tracked) return;
  const restore = (tracked.startsWith('S ') ? 'git update-index --no-skip-worktree .gitmodules && ' : '') + 'git checkout -- .gitmodules';
  throw Object.assign(new Error('The tracked .gitmodules is missing from this checkout. Restore it with `' + restore + '`, then run `' + COMMAND + '`.'), { sourceDeclarations: true });
}

// The executable 7-Zip and embedded Python that macOS app setup prepares, which tests run.
function assertPreparedTools(repoRoot) {
  if (process.platform !== 'darwin') return;
  const sevenZip = path.join(repoRoot, 'src/resources/7zip/7zz'), pin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/resources/7zip/source.json')));
  const stat = fs.lstatSync(sevenZip, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('Missing 7-Zip executable: src/resources/7zip/7zz');
  if (sha(fs.readFileSync(sevenZip)) !== pin.executableSha256) throw new Error('Changed input: src/resources/7zip/7zz');
  const python = path.join(repoRoot, 'src/resources/python'), expected = require('../src/modules/shared/runtime/python').embeddedPythonProfile(process.arch);
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(path.join(python, 'runtime.json'), 'utf8')); } catch {}
  if (installed?.architecture !== expected.architecture || installed.sha256 !== expected.sha256 || !fs.existsSync(path.join(python, 'bin/python3')))
    throw new Error('Missing or different embedded Python ' + expected.version + ' (' + expected.architecture + '): src/resources/python');
}

async function check({ repoRoot = ROOT } = {}) {
  const problems = [];
  try {
    assertSourceDeclarations(repoRoot);
    const plan = await Sources.readPlan({ repoRoot });
    const leftOut = [];
    for (const source of plan.modules) {
      if (sourceReady(repoRoot, source)) continue;
      // Setup leaves out a source with nested sources that it can only attach, when no repository
      // it can attach from holds its pin.
      const candidates = source.recursive ? origins(repoRoot, primaryOf(repoRoot), source.path, sourceUrls(repoRoot).get(source.path)) : [];
      if (candidates.length && !candidates.some(candidate => holds(candidate, source.revision))) leftOut.push(source.path);
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
    assertPreparedTools(repoRoot);
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
    if (leftOut.length) console.warn('test-inputs: left out ' + leftOut.join(', ') + ', which no local repository holds at its pin.');
    return { ready: true, sources: plan.modules.length - leftOut.length, packages: lock.packages.length, ...(leftOut.length ? { leftOut } : {}) };
  } catch (error) {
    if (error.sourceDeclarations) throw new Error('Test inputs are not ready. ' + error.message, { cause: error });
    throw new Error('Test inputs are not ready. Run `' + COMMAND + '`. ' + error.message.replace(/\s+/g, ' '), { cause: error });
  }
}

async function setup({ repoRoot = ROOT } = {}) {
  await prepareSources(repoRoot);
  await require('./published-inputs.cjs').prepareDeclaredPublishers({ repoRoot });
  await require('../src/modules/catsystem2/runtime/stage-cp932.cjs').prepare({ repoRoot });
  if (process.platform === 'darwin') {
    await require('./published-inputs.cjs').prepareSevenZip({ repoRoot });
    await require('./ci-macos.cjs').preparePython({ repoRoot, arch: process.arch });
  }
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
