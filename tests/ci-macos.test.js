const { finished } = require("node:stream/promises");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { load: parse } = require('js-yaml');
const { verifyTagVersion, readConfiguration, verifyRunner, verifyAppVersion, releaseNotes, assertCopiedPayload } = require('../scripts/ci-macos.cjs');

const environment = {};
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
test('release notes lead with the app download and use version-specific highlights', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs/releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/releases/0.3.0.md'), 'New native backends and game tools.');
  const options = { repoRoot: root, version: '0.3.0', arch: 'arm64', minimumMacOS: '13.0', repository: 'owner/project',
    packageRepository: 'owner/runtime-builds' };
  const notes = releaseNotes(options);
  assert.ok(notes.startsWith('**[Download MacLauncher.app.zip]'));
  assert.match(notes, /releases\/download\/v0.3.0\/MacLauncher.app.zip/);
  assert.match(notes, /New native backends and game tools/);
  assert.match(notes, /https:\/\/github.com\/owner\/runtime-builds/);
  assert.match(notes, /release tags identify the matching source commits/);
  assert.doesNotMatch(notes, /distribution-plan|build-manifest|source pins|built from/);
  const later = releaseNotes({ ...options, version: '0.4.0' });
  assert.match(later, /v0.4.0\/MacLauncher.app.zip/);
  assert.doesNotMatch(later, /New native backends/);
});
test('CI configuration uses the committed package lock without repository variables', () => {
  const config = readConfiguration({});
  const lock = require('../build/runtime-packages.json');
  assert.equal(config.arch, lock.arch); assert.equal(config.maximumMacOS, lock.maximumMacOS);
  assert.equal(config.lock.packages.length, lock.packages.length);
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
  assert.doesNotMatch(upload.with.path, /\*/);
  assert.doesNotMatch(upload.with.path, /native-payload-inventory|source-pins|MacLauncher-source|MacLauncher-runtime-sources/);
  assert.match(upload.with.path, /MacLauncher\.app\.zip/);
  assert.equal(upload.with['include-hidden-files'], false);
  assert.equal(workflow.jobs.build['runs-on'], 'macos-26');
  assert.doesNotMatch(JSON.stringify(workflow), /native_payload_url|native_payload_sha256|vars\.MACLAUNCHER_NATIVE|macos-26-intel/);
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
