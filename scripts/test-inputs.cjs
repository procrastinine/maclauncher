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

async function prepareSources(repoRoot) {
  const plan = await Sources.readPlan({ repoRoot });
  const primary = git(repoRoot, ['worktree', 'list', '--porcelain']).split('\n').find(line => line.startsWith('worktree ')).slice(9);
  // A linked app checkout can share the existing exact source repositories.
  // No source checkout, index or branch in the primary worktree is changed.
  if (fs.realpathSync(primary) !== fs.realpathSync(repoRoot)) {
    for (const source of plan.modules) {
      if (sourceReady(repoRoot, source)) continue;
      const target = path.join(repoRoot, source.path), existing = path.join(primary, source.path);
      if (fs.existsSync(target) && fs.readdirSync(target).length) continue;
      try {
        if (fs.realpathSync(git(existing, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(existing)) continue;
        git(existing, ['cat-file', '-e', source.revision + '^{commit}']);
      } catch { continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) fs.rmdirSync(target);
      git(existing, ['worktree', 'add', '--detach', target, source.revision]);
    }
  }
  if (plan.modules.some(source => !sourceReady(repoRoot, source))) await Sources.initSubmodules({ repoRoot });
  return plan;
}

async function check({ repoRoot = ROOT } = {}) {
  const problems = [];
  try {
    const plan = await Sources.readPlan({ repoRoot });
    for (const source of plan.modules) if (!sourceReady(repoRoot, source)) problems.push(source.path + ' at ' + source.revision.slice(0, 12));
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
    return { ready: true, sources: plan.modules.length, packages: lock.packages.length };
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

module.exports = { check, setup };
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
