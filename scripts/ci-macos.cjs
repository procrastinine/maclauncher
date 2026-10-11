#!/usr/bin/env node
// CI orchestration, separate from launcher behavior and runtime policy.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Payload = require('./native-payload.cjs');
const B = require('../src/modules/shared/runtime/bundled-native');
const Sources = require('./native-source-artifacts.cjs');

function verifyTagVersion(version, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/tags/')) return null;
  if (typeof version !== 'string' || !version || ref !== `refs/tags/v${version}`) {
    throw new Error('Release tags must match package.json.version exactly as v<version>, including prerelease suffixes.');
  }
  return ref.slice('refs/tags/'.length);
}
function readConfiguration(env = process.env) {
  const config = Payload.configuration({ arch: env.MACLAUNCHER_NATIVE_PAYLOAD_ARCH, maximumMacOS: env.MACLAUNCHER_NATIVE_MAXIMUM_MACOS });
  const url = Payload.publishedUrl(env.MACLAUNCHER_NATIVE_PAYLOAD_URL);
  const sha256 = env.MACLAUNCHER_NATIVE_PAYLOAD_SHA256;
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('Set the exact lowercase SHA-256 of the pinned native payload archive.');
  const releaseTag = verifyTagVersion(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version,
    env.MACLAUNCHER_RELEASE_TAG ? `refs/tags/${env.MACLAUNCHER_RELEASE_TAG}` : env.GITHUB_REF);
  if (releaseTag && config.arch !== 'arm64') throw new Error('MacLauncher releases target Apple Silicon. Configure an arm64 native payload for tag builds.');
  return { ...config, url, sha256 };
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
  const result = await Payload.importPayload({ ...config, resourceRoot: path.join(repoRoot, 'src/resources/native-runtimes') });
  publicJson(path.join(repoRoot, 'dist/ci/native-payload-inventory.json'), result.inventory);
  return { nativeManagers: new Set(result.inventory.packages.map(item => item.managerId)).size, nativePackages: result.inventory.packages.length, nativeSupplementals: result.inventory.supplementals.length, sha256: result.sha256 };
}
function sourceArtifacts({ repoRoot = path.resolve(__dirname, '..'), outputRoot = path.join(repoRoot, 'dist/ci'), tool = execFileSync } = {}) {
  const commit = tool('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('The build source commit is unavailable.');
  try { tool('git', ['-C', repoRoot, 'diff', '--quiet', '--ignore-submodules=untracked', commit], { stdio: 'pipe' }); }
  catch { throw new Error('Source artifacts require a clean committed launcher tree.'); }
  const untracked = tool('git', ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (untracked.some(file => /^(?:src|scripts|tests|docs|build|\.github)\//.test(file) ||
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'vite.config.mjs', 'tsconfig.json', 'LICENSE', '.gitmodules'].includes(file))) {
    throw new Error('Commit public build/source files before creating a source artifact.');
  }
  const tree = tool('git', ['-C', repoRoot, 'ls-tree', '-rz', commit], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const privatePart = /^(?:\.git|\.local|\.playwright-mcp|\.env(?:\..*)?|localconfig.*\.json|settings\.local\.json|__pycache__|\.DS_Store|\._.*|game_tests|example_games|example_repos)$|\.(?:log|har|pcap|heapsnapshot|trace|pyc|pyo)$/i;
  if (tree.some(row => row.slice(row.indexOf('\t') + 1).split('/').some(part => privatePart.test(part)))) {
    throw new Error('Private local files, game fixtures or diagnostics are committed in the source archive tree.');
  }
  const source = path.join(outputRoot, 'MacLauncher-source.tar.gz');
  const links = assertSourceLinks({ tree, repoRoot, tool });
  B.realDirectory(outputRoot, { create: true });
  if (fs.existsSync(source)) throw new Error('Existing source artifacts are preserved.');
  tool('git', ['-C', repoRoot, 'archive', '--format=tar.gz', '--prefix=MacLauncher-source/', '--output', source, commit], { stdio: 'pipe' });
  if (links.sourceSymlinks) {
    try {
      const exported = new Set(tool('/usr/bin/tar', ['-tzf', source], { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 })
        .split('\n').filter(Boolean).map(name => name.replace(/^MacLauncher-source\//, '').replace(/\/$/, '')));
      assertSourceLinks({ tree: tree.filter(row => exported.has(row.slice(row.indexOf('\t') + 1))), repoRoot, tool });
    } catch (error) { fs.unlinkSync(source); throw error; }
  }
  for (const [name, relative] of [['ATTRIBUTIONS.md', 'docs/ATTRIBUTIONS.md'], ['RUNTIME_DISTRIBUTION.md', 'docs/runtimes/RUNTIME_DISTRIBUTION.md']]) {
    const bytes = fs.readFileSync(path.join(repoRoot, relative));
    fs.writeFileSync(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o644 });
  }
  fs.writeFileSync(path.join(outputRoot, 'LICENSE'), fs.readFileSync(path.join(repoRoot, 'LICENSE')), { flag: 'wx', mode: 0o644 });
  const modules = tree
    .map(row => /^160000 commit ([a-f0-9]{40,64})\t(.+)$/.exec(row)).filter(Boolean).map(match => ({ path: match[2], revision: match[1] }));
  publicJson(path.join(outputRoot, 'source-pins.json'), { schemaVersion: 1, launcherCommit: commit, submodules: modules,
    sourceArchiveScope: 'Committed launcher source and module-owned overlays. Submodule source locations remain in .gitmodules; native source/version and dependency notices are retained in the payload inventory/manifests.' });
  return commit;
}
function assertSourceLinks({ tree, repoRoot, tool = execFileSync }) {
  const files = new Map(), directories = new Set(['.']), links = new Map();
  if (!Array.isArray(tree) || tree.length > 100000) throw new Error('Source tree exceeds its packaging limit.');
  for (const row of tree) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t(.+)$/.exec(row);
    if (!match) throw new Error('Source tree entry is malformed.');
    const file = Payload.safeFile(match[3]); files.set(file, match[1]);
    for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
    if (match[1] === '120000') {
      const bytes = tool('git', ['-C', repoRoot, 'cat-file', 'blob', match[2]], { maxBuffer: 4096 });
      const target = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
      if (!target || path.posix.isAbsolute(target) || /[\\\x00-\x1f\x7f]/.test(target)) throw new Error('Source symlink target must be a relative portable path.');
      links.set(file, target);
    }
  }
  function resolve(start) {
    let pending = start; const seen = new Set();
    for (let count = 0; count < 128; count++) {
      pending = path.posix.normalize(pending);
      if (pending === '..' || pending.startsWith('../') || path.posix.isAbsolute(pending)) throw new Error('Source symlink escapes its exported tree.');
      if (seen.has(pending)) throw new Error('Source symlink cycle is unsupported.');
      seen.add(pending);
      const parts = pending.split('/'); let replaced = false;
      for (let index = 1; index <= parts.length; index++) {
        const prefix = parts.slice(0, index).join('/');
        if (!links.has(prefix)) continue;
        pending = path.posix.join(path.posix.dirname(prefix), links.get(prefix), ...parts.slice(index)); replaced = true; break;
      }
      if (replaced) continue;
      if (!files.has(pending) && !directories.has(pending)) throw new Error('Source symlink has a missing exported target.');
      if (files.get(pending) === '160000') throw new Error('Source symlink targets an excluded submodule checkout.');
      return;
    }
    throw new Error('Source symlink chain exceeds its limit.');
  }
  for (const file of links.keys()) resolve(file);
  return { sourceSymlinks: links.size };
}
async function runtimeSourceArtifacts({ sourceRoot, outputRoot, items }) {
  const verified = Sources.verify(sourceRoot, items || []);
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceArtifacts: items || [] }, null, 2) + '\n');
  const entries = [{ name: 'runtime-sources.json', bytes: metadata, size: metadata.length, sha256: B.digest(metadata), mode: 0o644 },
    ...verified.map(({ item, file }) => ({ name: `runtime-sources/${item.directoryRelative}`, file,
      size: item.bytes, sha256: item.sha256, mode: 0o644 }))];
  const archive = await Payload.writeArchive(entries, path.join(outputRoot, 'MacLauncher-runtime-sources.tar.gz'));
  return { ...archive, sourceArtifacts: items || [] };
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
  const sourceCommit = sourceArtifacts({ repoRoot, outputRoot, tool });
  const runtimeSources = await runtimeSourceArtifacts({ sourceRoot: path.join(repoRoot, 'src/resources/native-runtime-sources'), outputRoot,
    items: inventory.sourceArtifacts });
  const name = `${product}-macOS-${config.arch}-runtimes-${config.maximumMacOS}.zip`;
  const archive = path.join(outputRoot, name);
  if (fs.existsSync(archive)) throw new Error('Existing app artifacts are preserved.');
  // ditto retains app/framework symlinks and executable modes; upload a zip,
  // since Actions file upload does not preserve these attributes itself.
  tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], { stdio: 'pipe' });
  const sha256 = await Payload.checksum(archive);
  const zipCheck = await packaging.verifyZip({ archive, sha256, appPath: app, product });
  publicJson(path.join(outputRoot, 'packaging-checks.json'), { schemaVersion: 1, app: appCheck, zip: zipCheck });
  publicJson(path.join(outputRoot, 'distribution-plan.json'), require('./distribution-model.cjs').createPlan({ arch: config.arch, maximumMacOS: config.maximumMacOS, packageConfig: pkg }));
  fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS.txt'), `${sha256}  ${name}\n${await Payload.checksum(path.join(outputRoot, 'MacLauncher-source.tar.gz'))}  MacLauncher-source.tar.gz\n` +
    `${runtimeSources.sha256}  ${runtimeSources.archive}\n`, { flag: 'wx', mode: 0o644 });
  publicJson(path.join(outputRoot, 'build-manifest.json'), { schemaVersion: 1, product, version: pkg.version, releaseTag, sourceCommit, arch: config.arch,
    launcherMinimumMacOS: pkg.build.mac.minimumSystemVersion, maximumNativeMacOS: config.maximumMacOS, nativePayloadSha256: config.sha256,
    nativePackages: inventory.packages, nativeSupplementals: inventory.supplementals, nativeSourceArtifacts: runtimeSources,
    appArchive: name, appArchiveSha256: sha256, signing: 'Ad hoc signed; not Developer ID signed or notarized' });
  fs.writeFileSync(path.join(outputRoot, 'RELEASE_NOTES.md'), `MacLauncher ${pkg.version} (${config.arch}), built from ${sourceCommit}.\n\nPlay Windows and Linux games through native macOS runtimes, with automatic setup and game tools.\n\nThe launcher requires macOS ${pkg.build.mac.minimumSystemVersion} or later; included native runtimes enforce their individual requirements. The app is ad hoc signed and is not notarized.\n\nThe app zip retains native notices. Accompanying files include the project license, source pins, the launcher and overlay source archive, project attributions, runtime distribution guidance, inventory and checksums. MacLauncher-runtime-sources.tar.gz contains the corresponding-source archives listed in its runtime-sources.json inventory. Other upstream submodule sources are identified by exact pins in the launcher source archive.\n`, { flag: 'wx', mode: 0o644 });
  return { archive: name, sha256, sourceCommit, nativePackages: inventory.packages.length, nativeSupplementals: inventory.supplementals.length };
}
async function main(args) {
  if (args.length !== 1) throw new Error('Usage: node scripts/ci-macos.cjs configure|fetch|finalize');
  const config = readConfiguration();
  if (args[0] === 'configure') { verifyRunner(config); return { arch: config.arch, maximumMacOS: config.maximumMacOS, configured: true }; }
  if (args[0] === 'fetch') return fetchResources({ config });
  if (args[0] === 'finalize') return finalize({ config });
  throw new Error('Usage: node scripts/ci-macos.cjs configure|fetch|finalize');
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyTagVersion, readConfiguration, verifyRunner, verifyAppVersion, fetchResources, sourceArtifacts, assertSourceLinks, runtimeSourceArtifacts, assertCopiedPayload, finalize, main };
