const { finished } = require("node:stream/promises");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { load: parse } = require('js-yaml');
const { verifyTagVersion, readConfiguration, verifyRunner, verifyAppVersion, releaseNotes, assertCopiedPayload, preparePython, prepareElectron, main } = require('../scripts/ci-macos.cjs');

const environment = { MACLAUNCHER_APP_ARCH: 'arm64' };
// The committed lock is checked against the current application plan by its
// own test below. Tests of other CI steps read this fixed selection instead.
const fixtureLock = Object.freeze({ repository: 'owner/runtime-builds', arch: 'arm64', maximumMacOS: '13.0', packages: [] });
test('explicit resource fetch prepares Electron before publisher and included-package downloads', async () => {
  const filename = path.resolve(__dirname, '../scripts/ci-macos.cjs');
  const originalRequire = require('node:module').createRequire(filename), calls = [];
  const reached = new Error('Electron installer reached');
  const ciRequire = name => name === 'node:child_process' ? { execFileSync(...args) { calls.push(args); throw reached; } } : originalRequire(name);
  const ciModule = { exports: {} }, repoRoot = path.resolve(os.tmpdir(), 'ci-electron-source');
  new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', fs.readFileSync(filename, 'utf8').replace(/^#!.*\n/, ''))(
    ciRequire, ciModule, ciModule.exports, path.dirname(filename), filename, { ...process, platform: 'darwin', arch: 'arm64' });
  await assert.rejects(ciModule.exports.fetchResources({ config: { arch: 'x64' }, repoRoot }), /runner CPU/);
  assert.deepEqual(calls, [], 'Invalid runners cannot start acquisition');
  await assert.rejects(ciModule.exports.fetchResources({ config: { arch: 'arm64' }, repoRoot }), error => error === reached);
  assert.deepEqual(calls, [[process.execPath, [path.join(repoRoot, 'node_modules/electron/install.js')], { cwd: repoRoot, stdio: 'inherit' }]]);
  const shared = [];
  prepareElectron({ repoRoot, tool: (...args) => shared.push(args) });
  assert.deepEqual(shared, calls, 'Development setup and CI use the same Electron installer');
});
test('packaging and repository tests initialize their own declared sources at Gitlink commits', async t => {
  const repoRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-test-sources-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const declaration = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../build/source-dependencies.json'), 'utf8'));
  const android = 'src/external/maclauncher-android';
  assert.equal(declaration.submodules.length, 6);
  assert.equal(declaration.submodules.includes(android), false, 'Android producer source is not an app packaging input');
  assert.deepEqual(declaration.testSubmodules, [android]);
  const plan = await require('../scripts/init-submodules.cjs').readPlan({ paths: [android] });
  assert.equal(plan.modules[0].path, android);
  assert.match(plan.modules[0].revision, /^[a-f0-9]{40}$/);
  fs.mkdirSync(path.join(repoRoot, 'build'));
  const metadata = path.join(repoRoot, 'build/source-dependencies.json');
  fs.writeFileSync(metadata, JSON.stringify(declaration));
  const calls = [], tool = (...args) => calls.push(args);
  assert.deepEqual(await main(['sources'], { repoRoot, tool }), { submodules: 6 });
  assert.deepEqual(await main(['test-sources'], { repoRoot, tool }), { submodules: 7 });
  const prefix = ['-c', 'submodule.recurse=false', 'submodule', 'update', '--init', '--checkout', '--'];
  assert.deepEqual(calls, [
    ['git', [...prefix, ...declaration.submodules], { cwd: repoRoot, stdio: 'inherit' }],
    ['git', [...prefix, ...declaration.submodules, android], { cwd: repoRoot, stdio: 'inherit' }]
  ]);
  for (const testSubmodules of [undefined, [], [android, android], ['../outside']]) {
    fs.writeFileSync(metadata, JSON.stringify({ ...declaration, testSubmodules }));
    await assert.rejects(main(['test-sources'], { repoRoot, tool }), /explicit pinned submodules|Unsafe/);
  }
  assert.equal(calls.length, 2, 'Invalid declarations cannot reach Git');
});
test('finalize CLI exposes payload verification during its synchronous packaging callback', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-cli-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../scripts/ci-macos.cjs');
  const originalRequire = require('node:module').createRequire(filename);
  const cliModule = { exports: {} }, errors = [], inventory = { packages: [] };
  let payloadVerified = false;
  const cliRequire = name => {
    if (name === 'node:fs') return { ...fs, readFileSync(file, ...args) {
      return String(file).endsWith('/dist/ci/native-payload-inventory.json')
        ? JSON.stringify(inventory) : fs.readFileSync(file, ...args);
    } };
    if (name === './runtime-packages.cjs') return { readLock: () => fixtureLock };
    if (name === './check-packaging.cjs') return { verifyApp() {
      // This callback runs before the CLI entrypoint returns its first promise.
      // The packaging module calls back into the still-loading CI module.
      cliModule.exports.assertCopiedPayload(root, inventory, []);
      payloadVerified = true;
      throw new Error('Synthetic archive boundary reached');
    } };
    return originalRequire(name);
  };
  cliRequire.main = cliModule;
  const cliProcess = { platform: 'darwin', arch: 'arm64', env: environment, argv: ['node', filename, 'finalize'] };
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: cliRequire, module: cliModule, __dirname: path.dirname(filename), process: cliProcess,
    console: { log() {}, error(message) { errors.push(message); } }, Buffer
  }, { filename });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payloadVerified, true);
  assert.deepEqual(errors, ['Synthetic archive boundary reached']);
  assert.equal(cliProcess.exitCode, 1);
});
test('release notes lead with the app download and use version-specific highlights', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs/releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/releases/0.3.0.md'), 'New native backends and game tools.');
  const options = { repoRoot: root, version: '0.3.0', minimumMacOS: '13.0', repository: 'owner/project',
    packageRepository: 'owner/runtime-builds' };
  const notes = releaseNotes(options);
  assert.ok(notes.startsWith('**[Download for Apple Silicon]'));
  assert.match(notes, /\[Download for Apple Silicon\]\(https:\/\/github.com\/owner\/project\/releases\/download\/v0.3.0\/MacLauncher.app.zip\)/);
  assert.match(notes, /\[Download for Intel\]\(https:\/\/github.com\/owner\/project\/releases\/download\/v0.3.0\/MacLauncher-Intel.app.zip\)/);
  assert.match(notes, /About This Mac/);
  assert.match(notes, /New native backends and game tools/);
  assert.match(notes, /https:\/\/github.com\/owner\/runtime-builds/);
  assert.match(notes, /release tags identify the matching source commits/);
  assert.doesNotMatch(notes, /distribution-plan|build-manifest|source pins|built from/);
  const later = releaseNotes({ ...options, version: '0.4.0' });
  assert.match(later, /v0.4.0\/MacLauncher.app.zip/); assert.match(later, /v0.4.0\/MacLauncher-Intel.app.zip/);
  assert.doesNotMatch(later, /New native backends/);
});
test('CI configuration builds each named architecture from the committed package lock', () => {
  const lock = require('../build/runtime-packages.json');
  assert.deepEqual(lock.architectures, ['arm64', 'x64']);
  for (const arch of lock.architectures) {
    const config = readConfiguration({ MACLAUNCHER_APP_ARCH: arch });
    assert.equal(config.arch, arch); assert.equal(config.maximumMacOS, lock.maximumMacOS);
    // A compatible fallback record is not also included when this CPU has its
    // own build. CI must use the same selected view as installation.
    const selected = require('../scripts/runtime-packages.cjs').selectArchitecture(lock, arch);
    assert.deepEqual(config.lock.packages.map(record => `${record.id}/${record.version}/${record.arch}`).sort(),
      selected.packages.map(record => `${record.id}/${record.version}/${record.arch}`).sort());
    assert.doesNotThrow(() => verifyRunner(config, { platform: 'darwin', arch }));
    assert.throws(() => verifyRunner(config, { platform: 'darwin', arch: arch === 'arm64' ? 'x64' : 'arm64' }), /runner CPU/);
  }
  assert.ok(readConfiguration({ MACLAUNCHER_APP_ARCH: 'arm64' }).lock.packages.length > readConfiguration({ MACLAUNCHER_APP_ARCH: 'x64' }).lock.packages.length);
  assert.equal(readConfiguration({}).arch, process.arch);
  for (const value of ['', 'universal', 'x86_64']) assert.throws(() => readConfiguration({ MACLAUNCHER_APP_ARCH: value }), /MACLAUNCHER_APP_ARCH/);
});
test('tag builds require the exact app version, preserving stable and prerelease identities', t => {
  t.mock.method(require('../scripts/runtime-packages.cjs'), 'readLock', () => fixtureLock);
  for (const version of ['1.2.3', '1.2.3-beta.4', '1.2.3-beta.4+build.7']) {
    assert.equal(verifyTagVersion(version, `refs/tags/v${version}`), `v${version}`);
    for (const tag of ['v1.2.2', 'v1.2.3-beta.5', version]) assert.throws(() => verifyTagVersion(version, `refs/tags/${tag}`), /package\.json\.version exactly/);
  }
  assert.equal(verifyTagVersion('1.2.3', 'refs/heads/main'), null);
  const actualVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
  assert.doesNotThrow(() => readConfiguration({ ...environment, GITHUB_REF: `refs/tags/v${actualVersion}` }));
  assert.throws(() => readConfiguration({ ...environment, GITHUB_REF: 'refs/tags/v999.0.0' }), /package\.json\.version exactly/);
  assert.doesNotThrow(() => readConfiguration({ ...environment, GITHUB_REF: 'refs/heads/main', MACLAUNCHER_RELEASE_TAG: `v${actualVersion}` }));
});
test('final app validation reads the real packaged version and rejects a different stable or prerelease build', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-app-version-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), archive = path.join(root, 'app.asar'); fs.mkdirSync(source);
  const version = '1.2.3-beta.4+build.7';
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  await finished(await require('@electron/asar').createPackage(source, archive));
  assert.equal(verifyAppVersion(archive, version), version);
  for (const other of ['1.2.3', '1.2.3-beta.5', '1.2.3-beta.4+build.8']) assert.throws(() => verifyAppVersion(archive, other), /packaged app version differs/);
});
test('version, manual and tag app workflow pins actions, installs locked dependencies and never permits a native subset', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/macos-app.yml'), 'utf8'));
  assert.ok(workflow.on.workflow_dispatch); assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.deepEqual(workflow.on.push.paths, ['package.json']);
  assert.deepEqual(workflow.on.push.branches, ['**']);
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs.build.steps;
  for (const step of Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses)) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.submodules, false); assert.equal(checkout.with['persist-credentials'], false);
  const initialize = steps.findIndex(step => step.run === 'node scripts/ci-macos.cjs sources');
  assert.ok(initialize > steps.findIndex(step => step.uses?.startsWith('actions/setup-node@')));
  assert.ok(initialize < steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'));
  assert.ok(steps.findIndex(step => step.run === 'node scripts/ci-macos.cjs configure') > steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'));
  const commands = steps.map(step => step.run || '').join('\n');
  assert.match(commands, /pnpm install --frozen-lockfile/); assert.match(commands, /ci-macos\.cjs fetch/);
  assert.match(commands, /package:mac -- --dir/); assert.doesNotMatch(commands, /runtime-only|ignore-scripts|no-verify|trustLockfile|minimumReleaseAge/);
  assert.match(commands, /ci-macos\.cjs finalize/);
  assert.doesNotMatch(commands, /pnpm test|pnpm run typecheck|package:check/);
  const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  const attestIndex = steps.findIndex(step => step.uses?.startsWith('actions/attest-build-provenance@'));
  assert.ok(attestIndex > steps.findIndex(step => step.run === 'node scripts/ci-macos.cjs finalize'));
  assert.ok(attestIndex < steps.findIndex(step => step === upload));
  assert.equal(steps[attestIndex].with['subject-path'],
    'dist/ci/${{ env.MACLAUNCHER_APP_ASSET }}\ndist/ci/${{ env.MACLAUNCHER_APP_MANIFEST }}\n');
  assert.match(upload.with.path, /MACLAUNCHER_APP_MANIFEST/);
  assert.doesNotMatch(upload.with.path, /\*/);
  assert.doesNotMatch(upload.with.path, /native-payload-inventory|source-pins|MacLauncher-source|MacLauncher-runtime-sources/);
  // configure names the architecture's app archive from release.cjs.
  assert.match(upload.with.path, /dist\/ci\/\$\{\{ env\.MACLAUNCHER_APP_ASSET \}\}/);
  assert.equal(upload.with.name, 'MacLauncher-macOS-${{ matrix.arch }}');
  assert.equal(upload.with['include-hidden-files'], false);
  // Each app builds on a runner with its own CPU, and the runner check confirms it.
  assert.equal(workflow.jobs.build['runs-on'], '${{ matrix.runner }}');
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include, [{ arch: 'arm64', runner: 'macos-26' }, { arch: 'x64', runner: 'macos-26-intel' }]);
  assert.equal(workflow.jobs.build.strategy['fail-fast'], false);
  assert.equal(workflow.jobs.build.env.MACLAUNCHER_APP_ARCH, '${{ matrix.arch }}');
  assert.deepEqual(workflow.jobs.release.steps.filter(step => step.uses?.startsWith('actions/download-artifact@')).map(step => step.with),
    [{ name: 'MacLauncher-macOS-arm64', path: 'release-assets/arm64' }, { name: 'MacLauncher-macOS-x64', path: 'release-assets/x64' }]);
  assert.doesNotMatch(JSON.stringify(workflow), /native_payload_url|native_payload_sha256|vars\.MACLAUNCHER_NATIVE/);
  assert.deepEqual(workflow.jobs.release.needs, ['plan', 'build']); assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  assert.equal(workflow.jobs.build.needs, 'plan');
  assert.equal(workflow.jobs.build.if, "needs.plan.outputs.build == 'true'");
  assert.equal(workflow.jobs.release.if, "needs.plan.outputs.publish == 'true'");
  assert.equal(workflow.jobs.release.steps.find(step => step.run)?.run, 'node scripts/release.cjs publish release-assets');
});
test('app payload comparison requires exact reviewed versions and rejects extra files, directories and links', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-copied-payload-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relative = 'native-example/1.0/arm64', packageRoot = path.join(root, relative);
  fs.mkdirSync(path.join(packageRoot, 'files/bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'files/bin/runtime'), 'Synthetic reviewed executable bytes');
  const manifest = Buffer.from(JSON.stringify({ files: [{ path: 'bin/runtime' }] }));
  fs.writeFileSync(path.join(packageRoot, 'manifest.json'), manifest);
  const record = { managerId: 'native-example', version: '1.0', arch: 'arm64', directoryRelative: relative,
    manifestSha256: createHash('sha256').update(manifest).digest('hex') };
  const inventory = { packages: [record] };
  assert.doesNotThrow(() => assertCopiedPayload(root, inventory, [record]));
  assert.throws(() => assertCopiedPayload(root, inventory, []), /differs from its pinned archive/);
  assert.throws(() => assertCopiedPayload(root, inventory, [record, { ...record, version: '2.0' }]), /differs from its pinned archive/);
  assert.throws(() => assertCopiedPayload(root, inventory, [{ ...record, manifestSha256: 'a'.repeat(64) }]), /differs from its pinned archive/);
  const extra = path.join(packageRoot, 'review-session.json');
  fs.writeFileSync(extra, 'Unreviewed content');
  assert.throws(() => assertCopiedPayload(root, inventory, [record]), /outside its sealed payload/);
  fs.rmSync(extra); fs.mkdirSync(extra);
  assert.throws(() => assertCopiedPayload(root, inventory, [record]), /outside its sealed payload/);
  fs.rmSync(extra, { recursive: true }); fs.symlinkSync('manifest.json', extra);
  assert.throws(() => assertCopiedPayload(root, inventory, [record]), /outside its sealed payload/);
  fs.rmSync(extra); fs.rmSync(path.join(packageRoot, 'files/bin/runtime'));
  assert.throws(() => assertCopiedPayload(root, inventory, [record]), /missing sealed native payload files/);
});
test('the fetch step installs the publisher Python build for the app architecture when the checkout holds another', async t => {
  const repoRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-python-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const { embeddedPythonProfile } = require('../src/modules/shared/runtime/python');
  const root = path.join(repoRoot, 'src/resources/python'), metadata = path.join(root, 'runtime.json');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'bin/python3'), 'publisher Python');
  fs.writeFileSync(metadata, JSON.stringify(embeddedPythonProfile('arm64')));
  const calls = [], install = profile => async args => { calls.push(args); fs.writeFileSync(metadata, JSON.stringify(profile)); };
  assert.deepEqual(await preparePython({ arch: 'arm64', repoRoot, install: install(null) }), { python: 'arm64', installed: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(await preparePython({ arch: 'x64', repoRoot, install: install(embeddedPythonProfile('x64')) }), { python: 'x86_64', installed: true });
  assert.deepEqual(calls, [['--arch', 'x64', '--dest', root]]);
  fs.rmSync(root, { recursive: true });
  assert.deepEqual(await preparePython({ arch: 'arm64', repoRoot, install: async () => {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'bin/python3'), 'publisher Python');
    fs.writeFileSync(metadata, JSON.stringify(embeddedPythonProfile('arm64')));
  } }), { python: 'arm64', installed: true });
  fs.writeFileSync(metadata, JSON.stringify(embeddedPythonProfile('arm64')));
  await assert.rejects(preparePython({ arch: 'x64', repoRoot, install: install(embeddedPythonProfile('arm64')) }), /not the x64 build/);
});
