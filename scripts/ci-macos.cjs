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
function readConfiguration(env = process.env) {
  const lock = require('./runtime-packages.cjs').readLock();
  verifyTagVersion(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version,
    env.MACLAUNCHER_RELEASE_TAG ? 'refs/tags/' + env.MACLAUNCHER_RELEASE_TAG : env.GITHUB_REF);
  return { arch: lock.arch, maximumMacOS: lock.maximumMacOS, lock };
}
function verifyRunner(config, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || arch !== config.arch) throw new Error('The macOS runner CPU must match the explicitly selected launcher architecture.');
}
function verifyAppVersion(archive, expectedVersion) {
  const packed = JSON.parse(require('@electron/asar').extractFile(archive, 'package.json').toString('utf8'));
  if (typeof expectedVersion !== 'string' || !expectedVersion || packed.version !== expectedVersion) {
    throw new Error('The packaged app version differs from package.json.version. Rebuild the candidate before creating artifacts.');
  }
  return packed.version;
}
function publicJson(file, value) {
  require('./native-supplementals.cjs').validatePublicMetadata(value);
  B.realDirectory(path.dirname(file), { create: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
}
async function fetchResources({ config = readConfiguration(), repoRoot = path.resolve(__dirname, '..') } = {}) {
  verifyRunner(config);
  const result = await require('./runtime-packages.cjs').fetchPackages({ lock: config.lock, repoRoot });
  publicJson(path.join(repoRoot, 'dist/ci/native-payload-inventory.json'), result.inventory);
  return { nativePackages: result.inventory.packages.length, nativeSupplementals: result.inventory.supplementals.length,
    projectPackages: result.packages };
}
function releaseNotes({ repoRoot = path.resolve(__dirname, '..'), version, arch, minimumMacOS, packageRepository = 'procrastinine/maclauncher-builds',
  repository = process.env.GITHUB_REPOSITORY || 'procrastinine/maclauncher' }) {
  require('./release.cjs').parseVersion(version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Release notes require a GitHub repository.');
  const base = `https://github.com/${repository}`, tag = `v${version}`;
  const file = path.join(repoRoot, 'docs/releases', `${version}.md`);
  const highlights = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : `MacLauncher ${version}.`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(packageRepository)) throw new Error('Runtime source links require a GitHub repository.');
  const sources = '[Runtime source and build recipes](https://github.com/' + packageRepository + '). Runtime release tags identify the matching source commits.';
  return `**[Download MacLauncher.app.zip](${base}/releases/download/${tag}/MacLauncher.app.zip)** — ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}, macOS ${minimumMacOS} or later.\n\n` +
    'Open the ZIP, move `MacLauncher.app` to Applications, then open it. If macOS blocks the first launch, use **System Settings → Privacy & Security → Open Anyway**.\n\n' +
    `${highlights}\n\n<details>\n<summary>Source code and licences</summary>\n\n` +
    `[Launcher source and build instructions](${base}/tree/${tag}). ${sources} ` +
    `[Upstream licences](${base}/blob/${tag}/docs/ATTRIBUTIONS.md) are also retained in the app.\n\n</details>\n`;
}
function assertCopiedPayload(resourceRoot, inventory, verified) {
  if (verified.length !== inventory.packages.length || inventory.packages.some(item => !verified.some(found =>
    found.managerId === item.managerId && found.version === item.version && found.arch === item.arch && found.manifestSha256 === item.manifestSha256))) {
    throw new Error('Packaged native payload differs from its pinned archive.');
  }
  const expectedFiles = new Set(), expectedDirectories = new Set(['']);
  for (const item of inventory.packages) {
    const relative = Payload.safeFile(item.directoryRelative);
    const stored = B.readRegular(path.join(resourceRoot, relative, 'manifest.json'), B.LIMITS.manifestBytes);
    if (stored.sha256 !== item.manifestSha256) throw new Error('Packaged native manifest changed after verification.');
    const manifest = JSON.parse(stored.bytes);
    for (const name of [`${relative}/manifest.json`, ...manifest.files.map(file => `${relative}/files/${file.path}`)]) {
      const safe = Payload.safeFile(name);
      expectedFiles.add(safe);
      for (let directory = path.posix.dirname(safe); directory !== '.'; directory = path.posix.dirname(directory)) expectedDirectories.add(directory);
    }
  }
  for (const item of inventory.supplementals || []) for (const file of item.files) {
    const safe = Payload.safeFile(`${item.directoryRelative}/${file.path}`);
    expectedFiles.add(safe);
    for (let directory = path.posix.dirname(safe); directory !== '.'; directory = path.posix.dirname(directory)) expectedDirectories.add(directory);
  }
  function walk(relative) {
    const directory = path.join(resourceRoot, relative);
    B.realDirectory(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && expectedDirectories.has(name)) walk(name);
      else if (entry.isFile() && expectedFiles.delete(name)) continue;
      else throw new Error('The app contains a native file or directory outside its sealed payload.');
    }
  }
  walk('');
  if (expectedFiles.size) throw new Error('The app is missing sealed native payload files.');
}
async function finalize({ config = readConfiguration(), repoRoot = path.resolve(__dirname, '..'), outputRoot = path.join(repoRoot, 'dist/ci'), tool = execFileSync } = {}) {
  verifyRunner(config);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const releaseTag = verifyTagVersion(pkg.version, process.env.MACLAUNCHER_RELEASE_TAG ? `refs/tags/${process.env.MACLAUNCHER_RELEASE_TAG}` : process.env.GITHUB_REF);
  const product = pkg.build.productName;
  if (product !== 'MacLauncher') throw new Error('The package product must be MacLauncher before producing its named CI archive.');
  const app = path.join(repoRoot, pkg.build.directories.output, config.arch === 'arm64' ? 'mac-arm64' : 'mac', `${product}.app`);
  const inventory = JSON.parse(fs.readFileSync(path.join(outputRoot, 'native-payload-inventory.json'), 'utf8'));
  const packaging = require('./check-packaging.cjs');
  const appCheck = packaging.verifyApp({ appPath: app, arch: config.arch, maximumMacOS: config.maximumMacOS, inventory, packageConfig: pkg, tool });
  const sourceCommit = tool('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('The application source commit is unavailable.');
  const name = `${product}.app.zip`;
  const archive = path.join(outputRoot, name);
  if (fs.existsSync(archive)) throw new Error('Existing app artifacts are preserved.');
  // ditto retains app/framework symlinks and executable modes; upload a zip,
  // since Actions file upload does not preserve these attributes itself.
  tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], { stdio: 'pipe' });
  const sha256 = await Payload.checksum(archive);
  const zipCheck = await packaging.verifyZip({ archive, sha256, appPath: app, product });
  publicJson(path.join(outputRoot, 'packaging-checks.json'), { schemaVersion: 1, app: appCheck, zip: zipCheck });
  publicJson(path.join(outputRoot, 'distribution-plan.json'), require('./distribution-model.cjs').createPlan({ arch: config.arch, maximumMacOS: config.maximumMacOS, packageConfig: pkg }));
  fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`, { flag: 'wx', mode: 0o644 });
  publicJson(path.join(outputRoot, 'build-manifest.json'), { schemaVersion: 1, product, version: pkg.version, releaseTag, sourceCommit, arch: config.arch,
    launcherMinimumMacOS: pkg.build.mac.minimumSystemVersion, maximumNativeMacOS: config.maximumMacOS,
    runtimePackageLockSha256: B.digest(Buffer.from(JSON.stringify(config.lock))),
    nativePackages: inventory.packages, nativeSupplementals: inventory.supplementals, 
    appArchive: name, appArchiveSha256: sha256, signing: 'Ad hoc signed; not Developer ID signed or notarized' });
  fs.writeFileSync(path.join(outputRoot, 'RELEASE_NOTES.md'), releaseNotes({ repoRoot, version: pkg.version, arch: config.arch,
    minimumMacOS: pkg.build.mac.minimumSystemVersion, packageRepository: inventory.packageRepository }), { flag: 'wx', mode: 0o644 });
  return { archive: name, sha256, sourceCommit, nativePackages: inventory.packages.length, nativeSupplementals: inventory.supplementals.length };
}
async function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/ci-macos.cjs sources|configure|fetch|finalize');
  if (args[0] === 'sources') {
    const value = JSON.parse(fs.readFileSync(path.join(__dirname, '../build/source-dependencies.json'), 'utf8'));
    if (value.schemaVersion !== 1 || !Array.isArray(value.submodules) || !value.submodules.length ||
        new Set(value.submodules).size !== value.submodules.length || value.submodules.some(file => Payload.safeFile(file) !== file))
      throw new Error('Application source dependencies require explicit pinned submodules.');
    execFileSync('git', ['-c', 'submodule.recurse=false', 'submodule', 'update', '--init', '--checkout', '--', ...value.submodules],
      { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    return { submodules: value.submodules.length };
  }
  const config = readConfiguration();
  if (args[0] === 'configure') {
    verifyRunner(config);
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV,
      `MACLAUNCHER_NATIVE_PAYLOAD_ARCH=${config.arch}\nMACLAUNCHER_NATIVE_MAXIMUM_MACOS=${config.maximumMacOS}\n`);
    return { arch: config.arch, maximumMacOS: config.maximumMacOS, configured: true };
  }
  if (args[0] === 'fetch') return fetchResources({ config });
  if (args[0] === 'finalize') return finalize({ config });
  throw new Error('Usage: node scripts/ci-macos.cjs configure|fetch|finalize');
}
module.exports = { verifyTagVersion, readConfiguration, verifyRunner, verifyAppVersion, fetchResources, releaseNotes, assertCopiedPayload, finalize, main };
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
