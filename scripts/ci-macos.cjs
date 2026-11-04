#!/usr/bin/env node
// CI orchestration, separate from launcher behavior and runtime policy.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Payload = require('./native-payload.cjs');
const B = require('../src/modules/shared/runtime/bundled-native');

function verifyTagVersion(version, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/tags/')) return null;
  if (typeof version !== 'string' || !version || ref !== `refs/tags/v${version}`) {
    throw new Error('Release tags must match package.json.version exactly as v<version>, including prerelease suffixes.');
  }
  return ref.slice('refs/tags/'.length);
}
// Each workflow job selects its launcher CPU explicitly. Local commands default
// to their Node process architecture, including an Intel process under Rosetta.
function readConfiguration(env = process.env) {
  const arch = env.MACLAUNCHER_APP_ARCH ?? process.arch;
  if (!require('./release.cjs').APP_ARCHITECTURES.includes(arch)) throw new Error('Set MACLAUNCHER_APP_ARCH to arm64 or x64 for this app build.');
  const lock = require('./runtime-packages.cjs').readLock({ arch });
  verifyTagVersion(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version,
    env.MACLAUNCHER_RELEASE_TAG ? 'refs/tags/' + env.MACLAUNCHER_RELEASE_TAG : env.GITHUB_REF);
  return { arch, maximumMacOS: lock.maximumMacOS, lock };
}
function verifyRunner(config, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || arch !== config.arch) throw new Error('The macOS runner CPU must match the explicitly selected launcher architecture.');
}
function publicJson(file, value) {
  B.realDirectory(path.dirname(file), { create: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
}
// Checkout setup and app builds install the pinned publisher build for their CPU.
async function preparePython({ arch, repoRoot, force = false, install = async args => (await import('./setup-python-runtime.mjs')).main(args) }) {
  const root = path.join(repoRoot, 'src/resources/python');
  const metadata = path.join(root, 'runtime.json');
  const installed = fs.existsSync(metadata) ? JSON.parse(B.readRegular(metadata, B.LIMITS.manifestBytes).bytes) : null;
  const expected = require('../src/modules/shared/runtime/python').embeddedPythonProfile(arch);
  if (!force && installed?.architecture === expected.architecture && installed.sha256 === expected.sha256 && fs.existsSync(path.join(root, 'bin/python3'))) return { python: expected.architecture, installed: false };
  await install(['--arch', arch, '--dest', root]);
  require('./python-resources.cjs').assertProfile(JSON.parse(B.readRegular(path.join(root, 'runtime.json'), B.LIMITS.manifestBytes).bytes), arch);
  return { python: expected.architecture, installed: true };
}
function prepareElectron({ repoRoot = path.resolve(__dirname, '..'), tool = execFileSync } = {}) {
  tool(process.execPath, [path.join(repoRoot, 'node_modules/electron/install.js')], { cwd: repoRoot, stdio: 'inherit' });
}
async function fetchResources({ config = readConfiguration(), repoRoot = path.resolve(__dirname, '..') } = {}) {
  verifyRunner(config);
  prepareElectron({ repoRoot });
  require('./app-host.cjs').readHost({ repoRoot, arch: config.arch });
  const python = await preparePython({ arch: config.arch, repoRoot, force: true });
  await require('./published-inputs.cjs').prepareSevenZip({ repoRoot });
  await require('./published-inputs.cjs').prepareDeclaredPublishers({ repoRoot });
  const result = await require('./runtime-packages.cjs').fetchPackages({ lock: config.lock, repoRoot });
  require('./published-inputs.cjs').downloadBuildAttestations({ repoRoot, lock: config.lock });
  publicJson(path.join(repoRoot, 'dist/ci/native-payload-inventory.json'), result.inventory);
  return { nativePackages: result.inventory.packages.length, nativeSupplementals: result.inventory.supplementals.length,
    projectPackages: result.packages, ...python };
}
function releaseNotes({ repoRoot = path.resolve(__dirname, '..'), version, minimumMacOS, packageRepository = 'procrastinine/maclauncher-builds',
  repository = process.env.GITHUB_REPOSITORY || 'procrastinine/maclauncher' }) {
  require('./release.cjs').parseVersion(version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Release notes require a GitHub repository.');
  const base = `https://github.com/${repository}`, tag = `v${version}`;
  const file = path.join(repoRoot, 'docs/releases', `${version}.md`);
  const highlights = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : `MacLauncher ${version}.`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(packageRepository)) throw new Error('Runtime source links require a GitHub repository.');
  const sources = '[Runtime source and build recipes](https://github.com/' + packageRepository + '). Runtime release tags identify the matching source commits.';
  const { APP_ARCHITECTURES, appAsset } = require('./release.cjs');
  const downloads = APP_ARCHITECTURES.map(arch => `**[Download for ${appAsset(arch).label}](${base}/releases/download/${tag}/${appAsset(arch).name})**`);
  return `${downloads.join(' · ')} — macOS ${minimumMacOS} or later.\n\n` +
    'Choose the download for the Mac\'s chip, shown in **Apple menu → About This Mac**. Open the ZIP, move `MacLauncher.app` to Applications, then open it. If macOS blocks the first launch, use **System Settings → Privacy & Security → Open Anyway**.\n\n' +
    `${highlights}\n\n<details>\n<summary>Source code and licences</summary>\n\n` +
    `[Launcher source and build instructions](${base}/tree/${tag}). ${sources} ` +
    `[Upstream licences](${base}/blob/${tag}/docs/ATTRIBUTIONS.md) are also retained in the app. ` +
    `[Build provenance and package verification](${base}/blob/${tag}/docs/development/VERIFYING.md).\n\n</details>\n`;
}
async function finalize({ config = readConfiguration(), repoRoot = path.resolve(__dirname, '..'), outputRoot = path.join(repoRoot, 'dist/ci'), tool = execFileSync } = {}) {
  verifyRunner(config);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const releaseTag = verifyTagVersion(pkg.version, process.env.MACLAUNCHER_RELEASE_TAG ? `refs/tags/${process.env.MACLAUNCHER_RELEASE_TAG}` : process.env.GITHUB_REF);
  const product = pkg.build.productName;
  const app = path.join(repoRoot, pkg.build.directories.output, config.arch === 'arm64' ? 'mac-arm64' : 'mac', `${product}.app`);
  const inventory = JSON.parse(fs.readFileSync(path.join(outputRoot, 'native-payload-inventory.json'), 'utf8'));
  const publishedInputs = require('./published-inputs.cjs').verifyBuildAttestations({ repoRoot, lock: config.lock });
  const sourceCommit = tool('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const name = require('./release.cjs').appAsset(config.arch).name;
  const archive = path.join(outputRoot, name);
  // ditto retains app/framework symlinks and executable modes; upload a zip,
  // since Actions file upload does not preserve these attributes itself.
  tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], { stdio: 'pipe' });
  const sha256 = await Payload.checksum(archive);
  fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`, { mode: 0o644 });
  publicJson(path.join(outputRoot, require('./release.cjs').appManifest(config.arch)), { schemaVersion: 1, product, version: pkg.version, releaseTag, sourceCommit, arch: config.arch,
    toolchain: { node: process.versions.node,
      pnpm: tool('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      xcode: tool('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim(),
      macosSDK: tool('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { encoding: 'utf8' }).trim(),
      macOS: tool('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() },
    launcherMinimumMacOS: pkg.build.mac.minimumSystemVersion, maximumNativeMacOS: config.maximumMacOS,
    runtimePackageLockSha256: B.digest(Buffer.from(JSON.stringify(config.lock))),
    nativePackages: inventory.packages, nativeSupplementals: inventory.supplementals, 
    publishedInputs: { builds: publishedInputs },
    appArchive: name, appArchiveSha256: sha256, signing: 'Ad hoc signed; not Developer ID signed or notarized' });
  fs.writeFileSync(path.join(outputRoot, 'RELEASE_NOTES.md'), releaseNotes({ repoRoot, version: pkg.version,
    minimumMacOS: pkg.build.mac.minimumSystemVersion, packageRepository: inventory.packageRepository }), { mode: 0o644 });
  return { archive: name, sha256, sourceCommit, nativePackages: inventory.packages.length, nativeSupplementals: inventory.supplementals.length };
}
function initializeSources({ repoRoot = path.resolve(__dirname, '..'), tests = false, tool = execFileSync } = {}) {
  const value = JSON.parse(fs.readFileSync(path.join(repoRoot, 'build/source-dependencies.json'), 'utf8'));
  const groups = [value.submodules, ...(tests ? [value.testSubmodules] : [])];
  if (value.schemaVersion !== 1 || groups.some(group => !Array.isArray(group) || !group.length ||
      new Set(group).size !== group.length || group.some(file => Payload.safeFile(file) !== file)))
    throw new Error('Application source dependencies require explicit pinned submodules.');
  const submodules = [...new Set(groups.flat())];
  tool('git', ['-c', 'submodule.recurse=false', 'submodule', 'update', '--init', '--checkout', '--', ...submodules],
    { cwd: repoRoot, stdio: 'inherit' });
  return { submodules: submodules.length };
}
async function main(args, sourceOptions) {
  if (args.length !== 1) throw new Error('Usage: node scripts/ci-macos.cjs sources|test-sources|configure|fetch|finalize');
  if (args[0] === 'sources' || args[0] === 'test-sources')
    return initializeSources({ ...sourceOptions, tests: args[0] === 'test-sources' });
  const config = readConfiguration();
  if (args[0] === 'configure') {
    verifyRunner(config);
    const asset = require('./release.cjs').appAsset(config.arch).name;
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
      `MACLAUNCHER_NATIVE_PAYLOAD_ARCH=${config.arch}\nMACLAUNCHER_NATIVE_MAXIMUM_MACOS=${config.maximumMacOS}\nMACLAUNCHER_APP_ASSET=${asset}\nMACLAUNCHER_APP_MANIFEST=${require('./release.cjs').appManifest(config.arch)}\n`);
    return { arch: config.arch, maximumMacOS: config.maximumMacOS, asset, configured: true };
  }
  if (args[0] === 'fetch') return fetchResources({ config });
  if (args[0] === 'finalize') return finalize({ config });
  throw new Error('Usage: node scripts/ci-macos.cjs sources|test-sources|configure|fetch|finalize');
}
module.exports = { verifyTagVersion, readConfiguration, verifyRunner, preparePython, prepareElectron, fetchResources, releaseNotes, finalize, initializeSources, main };
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
