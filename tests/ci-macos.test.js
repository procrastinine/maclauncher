const { finished } = require("node:stream/promises");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { load: parse } = require('js-yaml');
const { verifyTagVersion, readConfiguration, verifyRunner, verifyAppVersion, sourceArtifacts, assertSourceLinks, runtimeSourceArtifacts, assertCopiedPayload } = require('../scripts/ci-macos.cjs');

const environment = { MACLAUNCHER_NATIVE_PAYLOAD_URL: 'https://example.invalid/reviewed-native.tar.gz', MACLAUNCHER_NATIVE_PAYLOAD_SHA256: 'a'.repeat(64),
  MACLAUNCHER_NATIVE_PAYLOAD_ARCH: 'arm64', MACLAUNCHER_NATIVE_MAXIMUM_MACOS: '27.0' };
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
test('Git source links retain portable targets and reject absolute, missing, cyclic and escaping paths', () => {
  const regular = `100644 blob ${'a'.repeat(40)}\tsrc/runtime/runner`, link = `120000 blob ${'b'.repeat(40)}\tsrc/current`;
  assert.deepEqual(assertSourceLinks({ tree: [regular, link], repoRoot: '/source', tool: () => Buffer.from('runtime') }), { sourceSymlinks: 1 });
  for (const target of ['/private/runtime', '../../outside', 'missing', 'current', 'runtime\\runner']) {
    assert.throws(() => assertSourceLinks({ tree: [regular, link], repoRoot: '/source', tool: () => Buffer.from(target) }), /Source symlink/);
  }
  const second = `120000 blob ${'c'.repeat(40)}\tsrc/second`;
  assert.throws(() => assertSourceLinks({ tree: [regular, link, second], repoRoot: '/source',
    tool: (_, args) => Buffer.from(args.at(-1) === 'b'.repeat(40) ? 'second' : 'current') }), /cycle/);
});
test('CI exports exact runtime source archives as a separate checksummable release asset', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-runtime-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'sources'), outputRoot = path.join(root, 'release');
  fs.mkdirSync(path.join(sourceRoot, 'native-example'), { recursive: true }); fs.mkdirSync(outputRoot);
  const bytes = Buffer.from('Synthetic corresponding-source archive');
  const item = { managerId: 'native-example', version: '2.0', directoryRelative: 'native-example/2.0-source.tar.gz', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  fs.writeFileSync(path.join(sourceRoot, item.directoryRelative), bytes, { mode: 0o644 });
  const artifacts = await runtimeSourceArtifacts({ sourceRoot, outputRoot, items: [item] });
  assert.equal(artifacts.archive, 'MacLauncher-runtime-sources.tar.gz');
  assert.deepEqual(artifacts.sourceArtifacts, [item]);
  const archive = fs.readFileSync(path.join(outputRoot, artifacts.archive));
  assert.equal(createHash('sha256').update(archive).digest('hex'), artifacts.sha256);
  const expanded = gunzipSync(archive);
  assert.ok(expanded.includes(bytes));
  assert.ok(expanded.includes(Buffer.from(`runtime-sources/${item.directoryRelative}`)));
  await assert.rejects(runtimeSourceArtifacts({ sourceRoot, outputRoot, items: [item] }), /existing release artifacts/);
  fs.writeFileSync(path.join(sourceRoot, item.directoryRelative), Buffer.alloc(item.bytes));
  await assert.rejects(runtimeSourceArtifacts({ sourceRoot, outputRoot, items: [item] }), /source archive checksum/);
});
test('CI configuration needs all explicit payload identities and preserves the chosen runtime floor', () => {
  const config = readConfiguration(environment);
  assert.equal(config.arch, 'arm64'); assert.equal(config.maximumMacOS, '27.0');
  for (const key of Object.keys(environment)) { const omitted = { ...environment }; delete omitted[key]; assert.throws(() => readConfiguration(omitted)); }
  for (const arch of ['universal', 'arm64; echo injected']) assert.throws(() => readConfiguration({ ...environment, MACLAUNCHER_NATIVE_PAYLOAD_ARCH: arch }));
  assert.throws(() => readConfiguration({ ...environment, MACLAUNCHER_NATIVE_PAYLOAD_SHA256: 'latest' }));
  assert.throws(() => readConfiguration({ ...environment, MACLAUNCHER_NATIVE_MAXIMUM_MACOS: '27.0\nOTHER=value' }));
  assert.doesNotThrow(() => verifyRunner(config, { platform: 'darwin', arch: 'arm64' }));
  assert.throws(() => verifyRunner(config, { platform: 'darwin', arch: 'x64' }), /runner CPU/);
});
test('tag builds require the exact app version, preserving stable and prerelease identities', () => {
  for (const version of ['1.2.3', '1.2.3-beta.4', '1.2.3-beta.4+build.7']) {
    assert.equal(verifyTagVersion(version, `refs/tags/v${version}`), `v${version}`);
    for (const tag of ['v1.2.2', 'v1.2.3-beta.5', version]) assert.throws(() => verifyTagVersion(version, `refs/tags/${tag}`), /package\.json\.version exactly/);
  }
  assert.equal(verifyTagVersion('1.2.3', 'refs/heads/main'), null);
  const actualVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
  assert.doesNotThrow(() => readConfiguration({ ...environment, GITHUB_REF: `refs/tags/v${actualVersion}` }));
  assert.doesNotThrow(() => readConfiguration({ ...environment, MACLAUNCHER_NATIVE_PAYLOAD_ARCH: 'x64', GITHUB_REF: 'refs/heads/main' }));
  assert.throws(() => readConfiguration({ ...environment, MACLAUNCHER_NATIVE_PAYLOAD_ARCH: 'x64', GITHUB_REF: `refs/tags/v${actualVersion}` }), /target Apple Silicon/);
  assert.throws(() => readConfiguration({ ...environment, GITHUB_REF: 'refs/tags/v999.0.0' }), /package\.json\.version exactly/);
  assert.doesNotThrow(() => readConfiguration({ ...environment, GITHUB_REF: 'refs/heads/main', MACLAUNCHER_RELEASE_TAG: `v${actualVersion}` }));
  assert.throws(() => readConfiguration({ ...environment, GITHUB_REF: 'refs/heads/main', MACLAUNCHER_RELEASE_TAG: `v${actualVersion}`, MACLAUNCHER_NATIVE_PAYLOAD_ARCH: 'x64' }), /target Apple Silicon/);
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
test('source artifacts preserve committed overlays, notices and pins while omitting local and untracked files', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ci-source-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repository'), outputRoot = path.join(root, 'artifacts'); fs.mkdirSync(repoRoot);
  fs.mkdirSync(path.join(repoRoot, 'docs/runtimes'), { recursive: true }); fs.mkdirSync(path.join(repoRoot, '.local'));
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.local/\n');
  fs.writeFileSync(path.join(repoRoot, 'overlay.patch'), 'Owned source overlay');
  fs.mkdirSync(path.join(repoRoot, 'aliases'));
  fs.symlinkSync('../overlay.patch', path.join(repoRoot, 'aliases/current'));
  fs.symlinkSync('current', path.join(repoRoot, 'aliases/latest'));
  fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'Synthetic owned-code notice');
  fs.writeFileSync(path.join(repoRoot, 'docs/ATTRIBUTIONS.md'), 'Public project credits');
  fs.writeFileSync(path.join(repoRoot, 'docs/runtimes/RUNTIME_DISTRIBUTION.md'), 'Public runtime distribution guidance');
  fs.writeFileSync(path.join(repoRoot, '.local/private'), 'Private session marker');
  const git = args => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' });
  git(['init']); git(['config', 'user.name', 'Test Author']); git(['config', 'user.email', 'test@example.invalid']); git(['add', '.']); git(['commit', '-m', 'Source fixture']);
  fs.writeFileSync(path.join(repoRoot, 'untracked'), 'Untracked session marker');
  const commit = sourceArtifacts({ repoRoot, outputRoot });
  const source = gunzipSync(fs.readFileSync(path.join(outputRoot, 'MacLauncher-source.tar.gz'))).toString('utf8');
  assert.match(source, /Owned source overlay/); assert.match(source, /Synthetic owned-code notice/);
  assert.doesNotMatch(source, /Private session marker|Untracked session marker/);
  const extracted = path.join(root, 'extracted'); fs.mkdirSync(extracted);
  execFileSync('/usr/bin/tar', ['-xzf', path.join(outputRoot, 'MacLauncher-source.tar.gz'), '-C', extracted]);
  const sourceRoot = path.join(extracted, 'MacLauncher-source');
  assert.equal(fs.readlinkSync(path.join(sourceRoot, 'aliases/current')), '../overlay.patch');
  assert.equal(fs.readlinkSync(path.join(sourceRoot, 'aliases/latest')), 'current');
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'aliases/latest'), 'utf8'), 'Owned source overlay');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputRoot, 'source-pins.json'))).launcherCommit, commit);
  assert.equal(fs.readFileSync(path.join(outputRoot, 'LICENSE'), 'utf8'), 'Synthetic owned-code notice');
  assert.equal(fs.readFileSync(path.join(outputRoot, 'ATTRIBUTIONS.md'), 'utf8'), 'Public project credits');
  assert.equal(fs.readFileSync(path.join(outputRoot, 'RUNTIME_DISTRIBUTION.md'), 'utf8'), 'Public runtime distribution guidance');
  assert.throws(() => sourceArtifacts({ repoRoot, outputRoot }), /Existing source artifacts/);
  for (const name of ['pnpm-lock.yaml', '.npmrc', 'vite.config.mjs']) {
    const file = path.join(repoRoot, name), unpublishedOutput = path.join(root, 'uncommitted-build-source');
    fs.writeFileSync(file, 'Synthetic uncommitted build input');
    assert.throws(() => sourceArtifacts({ repoRoot, outputRoot: unpublishedOutput }), /Commit public build\/source files/);
    assert.equal(fs.existsSync(unpublishedOutput), false);
    fs.rmSync(file);
  }
  fs.writeFileSync(path.join(repoRoot, 'overlay.patch'), 'Changed owned overlay');
  assert.throws(() => sourceArtifacts({ repoRoot, outputRoot: path.join(root, 'changed-source') }), /clean committed launcher tree/);
  git(['checkout', '--', 'overlay.patch']);
  git(['add', '-f', '.local/private']); git(['commit', '-m', 'Private fixture in source tree']);
  const privateOutput = path.join(root, 'private-source');
  assert.throws(() => sourceArtifacts({ repoRoot, outputRoot: privateOutput }), /Private local files/);
  assert.equal(fs.existsSync(privateOutput), false);
});
test('version, manual and tag app workflow pins actions, installs locked dependencies and never permits a native subset', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/macos-app.yml'), 'utf8'));
  assert.ok(workflow.on.workflow_dispatch); assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.deepEqual(workflow.on.push.paths, ['package.json']);
  assert.deepEqual(workflow.on.push.branches, ['**']);
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) assert.equal(input.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const steps = workflow.jobs.build.steps;
  for (const step of Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.uses)) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.submodules, false); assert.equal(checkout.with['persist-credentials'], false);
  const initialize = steps.findIndex(step => step.run === 'node scripts/init-submodules.cjs');
  assert.ok(initialize > steps.findIndex(step => step.uses?.startsWith('actions/setup-node@')));
  assert.ok(initialize > steps.findIndex(step => step.run === 'node scripts/ci-macos.cjs configure'));
  assert.ok(initialize < steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'));
  const commands = steps.map(step => step.run || '').join('\n');
  assert.match(commands, /pnpm install --frozen-lockfile/); assert.match(commands, /ci-macos\.cjs fetch/);
  assert.match(commands, /package:mac -- --dir/); assert.doesNotMatch(commands, /runtime-only|ignore-scripts|no-verify|trustLockfile|minimumReleaseAge/);
  assert.match(commands, /ci-macos\.cjs finalize/);
  assert.match(commands, /package:check -- source --arch/);
  const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.doesNotMatch(upload.with.path, /\*/);
  assert.match(upload.with.path, /native-payload-inventory\.json/);
  assert.match(upload.with.path, /MacLauncher-source\.tar\.gz/);
  assert.match(upload.with.path, /MacLauncher-runtime-sources\.tar\.gz/);
  assert.match(upload.with.path, /distribution-plan\.json/);
  assert.match(upload.with.path, /packaging-checks\.json/);
  assert.equal(upload.with['include-hidden-files'], false);
  assert.match(workflow.jobs.build['runs-on'], /macos-26-intel/);
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
