#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { createInflateRaw } = require('node:zlib');
const Model = require('./distribution-model.cjs');
const B = require('../src/modules/shared/runtime/bundled-native');
const S = require('./native-supplementals.cjs');
const Sources = require('./native-source-artifacts.cjs');
const Payload = require('./native-payload.cjs');
const Content = require('./runtime-content.cjs');

const LIMITS = Object.freeze({ files: 100000, bytes: 8 * 1024 ** 3, zipBytes: 4 * 1024 ** 3, headerBytes: 64 * 1024 ** 2 });
const PRIVATE = /^(?:\.git|\.local|\.env(?:\..*)?|localconfig.*\.json|__pycache__|\.DS_Store|\._.*)$|\.(?:log|har|pcap|heapsnapshot|pyc|pyo)$/i;
function safePath(value) {
  const relative = B.relativeFile(value);
  if (relative.split('/').some(part => PRIVATE.test(part))) throw new Error(`Application contains an excluded file: ${relative}.`);
  Content.assertRuntimePath(relative);
  return relative;
}
function configurationCheck(plan, packageConfig) {
  const { FileMatcher, getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
  const root = path.resolve(__dirname, '..'), build = Content.applyBuildPolicy(packageConfig.build);
  if (build.productName !== 'MacLauncher' || build.appId !== 'com.maclauncher.launcher' || !build.asar ||
      build.beforePack !== 'scripts/before-pack.js' || build.afterPack !== 'scripts/after-pack.js') throw new Error('Application identity or distribution hooks are missing.');
  const packager = { info: { projectDir: root, buildResourcesDir: 'build', config: build,
    isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const matchers = getMainFileMatchers(root, '/application', value => value, build.mac, packager,
    path.join(root, build.directories.output), false);
  function selected(matcher, relative) { return matcher.createFilter()(path.join(matcher.from, relative), { isDirectory: () => false }); }
  for (const file of ['.local/config.json', 'AGENTS.md', 'tests/game.test.js', 'docs/README.md', 'scripts/dev.mjs',
    'src/external/engine/source.c', 'src/resources/native-runtime-sources/runtime-source.tar.gz',
    'src/modules/rgss/resources/mkxpz/old.app/Contents/MacOS/runner', 'src/modules/flash/resources/flash-player/Flash Player.app/Contents/MacOS/Flash Player',
    'src/modules/example/.env.local', 'src/modules/example/session.log']) {
    if (matchers.some(matcher => selected(matcher, file))) throw new Error(`Application archive selects an excluded input: ${file}.`);
  }
  const rules = Model.resourceRules(plan, build.extraResources);
  for (const rule of rules) {
    const matcher = new FileMatcher(path.join(root, rule.from), '/resources', value => value, rule.filter);
    const resourcePackage = plan.packages[0] || plan.supplementals[0];
    const base = rule.from === 'src/resources' ? resourcePackage ? `native-runtimes/${resourcePackage.directoryRelative}` : 'native-runtimes' :
      rule.from === 'src/external' ? 'evbunpack' : rule.from.endsWith('unren') ? 'third_party/rpatool' : '__urw';
    for (const suffix of ['.local/config.json', '.git/config', '.env.local', 'localconfig.json', 'session.log', '__pycache__/tool.pyc']) {
      if (selected(matcher, `${base}/${suffix}`)) throw new Error(`Application resource filter selects excluded data: ${rule.from}/${suffix}.`);
    }
    if (rule.from === 'src/resources') {
      for (const file of ['native-runtime-sources/runtime-source.tar.gz', 'native-runtimes/obsolete/1.0/arm64/manifest.json', 'python-old/bin/python3']) {
        if (selected(matcher, file)) throw new Error(`Application resources select an unlisted payload: ${file}.`);
      }
      for (const item of [...plan.packages, ...plan.supplementals]) {
        const marker = `native-runtimes/${item.directoryRelative}/${item.manifestRelative || 'manifest.json'}`;
        if (!selected(matcher, marker)) throw new Error(`Application resources omit a required native package: ${item.directoryRelative}.`);
      }
    }
  }
  return { applicationRules: matchers.length, resourceRules: rules.length };
}
function verifySource({ arch, maximumMacOS, resourceRoot, sourceRoot, inventory, signingIdentity, packageConfig = require('../package.json'), dependencies = {} } = {}) {
  const plan = Model.assertPublishable(Model.createPlan({ arch, maximumMacOS, packageConfig, dependencies }));
  const rules = configurationCheck(plan, packageConfig);
  const root = path.resolve(resourceRoot || path.join(__dirname, '../src/resources/native-runtimes'));
  const packages = require('./verify-native-runtimes.cjs').verifyPackages({ resourceRoot: root, architectures: [arch],
    managerIds: [...new Set(plan.packages.map(item => item.managerId))], requiredOnly: true, maximumMacOS, signingIdentity, dependencies });
  S.verifySupplementals({ resourceRoot: root, arch, maximumMacOS, items: plan.supplementals, dependencies });
  if (inventory?.sourceDownload || inventory?.projectPackages) {
    Payload.validateInventory(inventory, { arch, maximumMacOS }, dependencies);
    // The source workspace may retain other managed versions. Their exclusion
    // is checked by the resource matchers; the final app receives a full-tree
    // inventory check. Bind every selected source package to its locked seal.
    for (const item of packages) {
      const expected = inventory.packages.find(record => record.managerId === item.managerId && record.version === item.version && record.arch === item.arch);
      if (!expected || expected.manifestSha256 !== item.manifestSha256) throw new Error('A selected native source package differs from the locked payload.');
    }
  } else Sources.verify(path.resolve(sourceRoot || path.join(path.dirname(root), 'native-runtime-sources')), plan.sourceArtifacts);
  return { passed: true, mode: 'source', product: plan.product, version: plan.version, arch,
    maximumNativeMacOS: maximumMacOS, packages, supplementalCount: plan.supplementals.length,
    correspondingSourceCount: plan.sourceArtifacts.length, deliveryPlanSha256: B.digest(Buffer.from(JSON.stringify(plan))), ...rules };
}
function appTree(root) {
  const files = [], realRoot = fs.realpathSync(root); let bytes = 0, entries = 0;
  function walk(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), item = safePath(relative ? `${relative}/${name}` : name), stat = fs.lstatSync(file);
      if (++entries > LIMITS.files) throw new Error('Application file inventory exceeds its limits.');
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file), resolved = fs.realpathSync(file);
        if (path.isAbsolute(target) || !(resolved === realRoot || resolved.startsWith(realRoot + path.sep))) throw new Error(`Application link escapes its bundle: ${item}.`);
        files.push(item); continue;
      }
      if (stat.isDirectory()) { walk(file, item); continue; }
      if (!stat.isFile() || (bytes += stat.size) > LIMITS.bytes) throw new Error('Application file inventory exceeds its limits or contains a special file.');
      files.push(item);
    }
  }
  walk(realRoot); return { files, bytes };
}
function inspectAsar(archive, plan) {
  const asar = require('@electron/asar'), size = fs.statSync(archive).size, prefix = Buffer.alloc(8), fd = fs.openSync(archive, 'r');
  try {
    if (fs.readSync(fd, prefix, 0, 8, 0) !== 8 || prefix.readUInt32LE(4) < 8 ||
        prefix.readUInt32LE(4) > LIMITS.headerBytes || prefix.readUInt32LE(4) > size - 8) throw new Error('Application archive header is truncated or exceeds its limit.');
  } finally { fs.closeSync(fd); }
  asar.uncache(archive);
  const raw = asar.getRawHeader(archive), nodes = new Map(), pending = [['', raw.header]];
  while (pending.length) {
    const [name, node] = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node) || nodes.has(name) || nodes.size > LIMITS.files) throw new Error('Application archive metadata is invalid or exceeds its limits.');
    nodes.set(name, node);
    const kinds = ['files', 'link', 'size'].filter(key => Object.hasOwn(node, key));
    if (kinds.length !== 1 || !name && kinds[0] !== 'files') throw new Error('Application archive entry has an invalid type.');
    if (kinds[0] === 'files') {
      if (!node.files || typeof node.files !== 'object' || Array.isArray(node.files)) throw new Error('Application archive directory is invalid.');
      for (const [child, metadata] of Object.entries(node.files)) {
        if (!child || child.includes('/') || child.includes('\\')) throw new Error('Application archive entry has an invalid name.');
        pending.push([safePath(name ? `${name}/${child}` : child), metadata]);
      }
    } else if (kinds[0] === 'link') {
      safePath(node.link);
    } else if (!Number.isSafeInteger(node.size) || node.size < 0 || node.size > LIMITS.bytes ||
        !node.unpacked && (!/^\d+$/.test(node.offset || '') || !Number.isSafeInteger(Number(node.offset)) || Number(node.offset) + node.size > size - 8 - raw.headerSize)) {
      throw new Error('Application archive file size or offset is invalid.');
    }
  }
  const files = [...nodes.keys()].filter(Boolean), links = files.filter(name => Object.hasOwn(nodes.get(name), 'link'));
  for (const name of files) {
    const node = nodes.get(name);
    if (node.unpacked || !Object.hasOwn(node, 'size') || !node.integrity) continue;
    if (node.integrity.algorithm !== 'SHA256' || !/^[a-f0-9]{64}$/.test(node.integrity.hash || '') ||
        B.digest(asar.extractFile(archive, name)) !== node.integrity.hash)
      throw new Error(`Application archive file failed checksum verification: ${name}. Rebuild the app.`);
  }
  for (const name of links) {
    let current = name; const seen = new Set();
    for (let steps = 0; ; steps++) {
      if (steps >= 128 || seen.has(current)) throw new Error(`Application archive has a cyclic link: ${name}.`);
      seen.add(current);
      const parts = current.split('/'); let redirected = false;
      for (let index = 0; index < parts.length; index++) {
        const node = nodes.get(parts.slice(0, index + 1).join('/'));
        if (!node) throw new Error(`Application archive link is missing its target: ${name}.`);
        if (Object.hasOwn(node, 'link')) {
          current = safePath([node.link, ...parts.slice(index + 1)].join('/')); redirected = true; break;
        }
        if (index < parts.length - 1 && !Object.hasOwn(node, 'files')) throw new Error(`Application archive link crosses a file: ${name}.`);
      }
      if (!redirected) break;
    }
  }
  for (const file of files) if (/^(?:\.local|docs|scripts|tests)(?:\/|$)|^src\/(?:external|resources)(?:\/|$)|^src\/modules\/rgss\/resources\/mkxpz(?:\/|$)/.test(file)) {
    throw new Error(`Application archive contains a separately packaged or excluded tree: ${file}.`);
  }
  for (const file of ['package.json', 'dist/renderer/index.html', 'src/main/bootstrap.js']) {
    if (!files.includes(file)) throw new Error(`Application archive is missing ${file}.`);
  }
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (pkg.version !== plan.version || pkg.productName !== plan.product) throw new Error('Packaged application version or product differs from its source.');
  return { archiveFiles: files.length, archiveLinks: links.length };
}
function inspectSourceArchive(file) {
  const entries = execFileSync('/usr/bin/tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: LIMITS.headerBytes, timeout: 30000 }).trim().split('\n');
  if (entries.length > LIMITS.files) throw new Error('Source archive has too many entries.');
  for (const name of entries) {
    if (name.startsWith('/') || name.split('/').includes('..') || /[\0\r]/.test(name)) throw new Error('Source archive has an unsafe path.');
    Content.assertRuntimePath(name);
  }
  return { entries: entries.length };
}
function assertRuntimeBoundary(appPath, { packageConfig = require('../package.json') } = {}) {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const root = path.resolve(__dirname, '..'), build = Content.applyBuildPolicy(packageConfig.build);
  const rules = build.extraResources.filter(rule => typeof rule === 'object' && rule.from === 'src/external')
    .map(rule => ({ rule, matcher: new FileMatcher(path.join(root, rule.from), '/resources', value => value, rule.filter) }));
  const tree = appTree(appPath);
  for (const file of tree.files) {
    if (/(?:^|\/)source\.tar\.gz$/.test(file)) inspectSourceArchive(path.join(appPath, file));
    if (!file.startsWith('Contents/Resources/external/')) continue;
    const resource = file.slice('Contents/Resources/'.length);
    const selected = rules.some(({ rule, matcher }) => {
      const prefix = rule.to === '.' ? '' : rule.to + '/';
      return resource.startsWith(prefix) && matcher.createFilter()(path.join(matcher.from, resource.slice(prefix.length)), { isDirectory: () => false });
    });
    if (!selected) throw new Error(`Application contains an undeclared upstream resource: ${resource}.`);
  }
  const archive = inspectAsar(path.join(appPath, 'Contents/Resources/app.asar'), {
    version: packageConfig.version, product: packageConfig.build.productName
  });
  return { files: tree.files.length, ...archive };
}
function verifyApp({ appPath, arch, maximumMacOS, inventory, packageConfig = require('../package.json'), dependencies = {}, tool = execFileSync } = {}) {
  const plan = Model.assertPublishable(Model.createPlan({ arch, maximumMacOS, packageConfig, dependencies }));
  configurationCheck(plan, packageConfig);
  const app = path.resolve(appPath), stat = fs.lstatSync(app);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.basename(app) !== `${plan.product}.app`) throw new Error('Choose the real MacLauncher.app bundle.');
  const tree = appTree(app), resources = path.join(app, 'Contents/Resources');
  assertRuntimeBoundary(app, { packageConfig });
  for (const file of tree.files) if (/^Contents\/Resources\/(?:native-runtime-sources|Z-universal\.app|external\/.+\/\.git)(?:\/|$)|^Contents\/Resources\/app\.asar\.unpacked\/src\/modules\/rgss\/resources\/mkxpz(?:\/|$)/.test(file)) {
    throw new Error(`Application contains an unlisted source archive or duplicate runtime tree: ${file}.`);
  }
  const info = JSON.parse(tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 30000 }));
  if (info.CFBundleDisplayName !== plan.product || info.CFBundleIdentifier !== packageConfig.build.appId ||
      info.CFBundleShortVersionString !== plan.version || info.LSMinimumSystemVersion !== plan.launcherMinimumMacOS) throw new Error('Application Info.plist identity, version or macOS minimum differs from its source.');
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable || plan.product);
  if (info.CFBundleExecutable !== undefined && (typeof info.CFBundleExecutable !== 'string' || info.CFBundleExecutable !== path.basename(info.CFBundleExecutable))) throw new Error('Application executable must be a bundle-local filename.');
  const read = dependencies.readMachOLoadCommands || require('../src/modules/shared/runtime/macho-load-commands').readMachOLoadCommands;
  const image = read(executable, { architecture: arch }), expectedCPU = arch === 'x64' ? 'x86_64' : 'arm64';
  if (!image.architectures.includes(expectedCPU) || image.slices.some(slice => !slice.minimumMacOS || !B.versionAtLeast(plan.launcherMinimumMacOS, slice.minimumMacOS))) throw new Error('Launcher executable CPU or actual macOS floor differs from its package metadata.');
  tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 30000, stdio: 'pipe' });
  const archived = inspectAsar(path.join(resources, 'app.asar'), plan), nativeRoot = path.join(resources, 'native-runtimes');
  Payload.validateInventory(inventory, { arch, maximumMacOS }, dependencies);
  const keys = items => items.map(item => `${item.managerId}/${item.version}/${item.arch}`).sort();
  if (!isDeepStrictEqual(keys(inventory.packages), keys(plan.packages))) throw new Error('Application payload includes versions outside the distribution plan.');
  const packages = require('./verify-native-runtimes.cjs').verifyPackages({ resourceRoot: nativeRoot, architectures: [arch],
    managerIds: [...new Set(plan.packages.map(item => item.managerId))], requiredOnly: true, maximumMacOS, dependencies });
  S.verifySupplementals({ resourceRoot: nativeRoot, arch, maximumMacOS, items: plan.supplementals, dependencies });
  require('./ci-macos.cjs').assertCopiedPayload(nativeRoot, inventory, packages);
  return { passed: true, mode: 'app', product: plan.product, version: plan.version, arch,
    maximumNativeMacOS: maximumMacOS, files: tree.files.length, bytes: tree.bytes, nativePackages: packages.length,
    supplementalCount: plan.supplementals.length, deliveryPlanSha256: B.digest(Buffer.from(JSON.stringify(plan))), ...archived };
}
function releaseZipEntries(archive) {
  const { readZipEntries } = require('../src/modules/shared/runtime/zip'), parsed = readZipEntries(archive);
  if (!parsed || parsed.info.zipBase !== 0 || parsed.info.entries === 0xffff || parsed.info.cdSize > 64 * 1024 ** 2 ||
      !parsed.info.entries || parsed.entries.length !== parsed.info.entries || parsed.entries.length > LIMITS.files) {
    throw new Error('App zip has an unsupported or incomplete directory.');
  }
  const fd = fs.openSync(archive, 'r');
  try {
    const footer = Buffer.alloc(22), directory = Buffer.alloc(parsed.info.cdSize), entries = [];
    fs.readSync(fd, footer, 0, footer.length, parsed.info.eocdOffset);
    if (footer.readUInt16LE(4) || footer.readUInt16LE(6) || footer.readUInt16LE(8) !== parsed.info.entries) throw new Error('App zip must be a single-volume archive.');
    if (fs.readSync(fd, directory, 0, directory.length, parsed.info.cdOffset) !== directory.length) throw new Error('App zip directory is truncated.');
    let offset = 0;
    for (const record of parsed.entries) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('App zip directory is malformed.');
      const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10);
      const nameLength = directory.readUInt16LE(offset + 28), extraLength = directory.readUInt16LE(offset + 30), commentLength = directory.readUInt16LE(offset + 32);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length || flags & 1 || ![0, 8].includes(method) || record.compressedSize === 0xffffffff || record.uncompressedSize === 0xffffffff) throw new Error('App zip compression or entry size is unsupported.');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(offset + 46, offset + 46 + nameLength));
      const mode = directory.readUInt32LE(offset + 38) >>> 16, type = mode & 0o170000;
      if (name !== record.name || ![0, 0o040000, 0o100000, 0o120000].includes(type)) throw new Error('App zip contains an invalid name or special file.');
      const local = Buffer.alloc(30);
      if (record.absoluteLocalHeaderOffset + local.length > parsed.info.cdOffset ||
          fs.readSync(fd, local, 0, local.length, record.absoluteLocalHeaderOffset) !== local.length || local.readUInt32LE(0) !== 0x04034b50 ||
          local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw new Error('App zip local header differs from its directory.');
      const localName = Buffer.alloc(local.readUInt16LE(26)), dataOffset = record.absoluteLocalHeaderOffset + 30 + localName.length + local.readUInt16LE(28);
      if (dataOffset + record.compressedSize > parsed.info.cdOffset ||
          fs.readSync(fd, localName, 0, localName.length, record.absoluteLocalHeaderOffset + 30) !== localName.length ||
          new TextDecoder('utf-8', { fatal: true }).decode(localName) !== name) throw new Error('App zip local name or data range differs from its directory.');
      entries.push({ ...record, method, mode, type, dataOffset }); offset = end;
    }
    if (offset !== directory.length) throw new Error('App zip directory has unlisted entries.');
    return entries;
  } finally { fs.closeSync(fd); }
}
async function zipFileDigest(archive, entry, limit) {
  if (entry.uncompressedSize > limit) throw new Error('App zip entry exceeds its expected file size.');
  const hash = createHash('sha256'); let size = 0;
  if (!entry.compressedSize) {
    if (entry.uncompressedSize) throw new Error('App zip entry is truncated.');
    return hash.digest('hex');
  }
  const input = fs.createReadStream(archive, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  const output = entry.method === 8 ? input.pipe(createInflateRaw()) : input;
  if (output !== input) input.on('error', error => output.destroy(error));
  try {
    for await (const chunk of output) {
      if ((size += chunk.length) > limit || size > entry.uncompressedSize) throw new Error('App zip entry exceeds its declared size.');
      hash.update(chunk);
    }
    if (size !== entry.uncompressedSize) throw new Error('App zip expanded size differs from its directory.');
    return hash.digest('hex');
  } finally { input.destroy(); if (output !== input) output.destroy(); }
}
async function verifyZip({ archive, sha256, appPath, product = 'MacLauncher' }) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.zipBytes || !/^[a-f0-9]{64}$/.test(sha256 || '') ||
      await Payload.checksum(archive) !== sha256) throw new Error('App archive checksum or file identity differs.');
  if (!appPath) throw new Error('App zip validation requires its verified application bundle.');
  const app = path.resolve(appPath), tree = appTree(app), expected = new Set(tree.files), entries = releaseZipEntries(archive);
  if (path.basename(app) !== `${product}.app`) throw new Error('App zip product differs from the application bundle.');
  const names = new Set(); let expanded = 0, compared = 0;
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, ''); B.relativeFile(name);
    if (names.has(name) || (expanded += entry.uncompressedSize) > LIMITS.bytes) throw new Error('App zip has duplicate paths or exceeds its expanded limit.');
    names.add(name);
    // ditto's resource-fork metadata belongs only to an existing app entry.
    if (name.startsWith('__MACOSX')) {
      if (['__MACOSX', `__MACOSX/${product}.app`].includes(name) && entry.name.endsWith('/')) continue;
      if (name.startsWith(`__MACOSX/${product}.app/`) && entry.name.endsWith('/')) {
        const relative = safePath(name.slice(`__MACOSX/${product}.app/`.length));
        if (!fs.lstatSync(path.join(app, relative)).isDirectory() || entry.uncompressedSize || ![0, 0o040000].includes(entry.type)) throw new Error('App zip resource directory has no matching application directory.');
        await zipFileDigest(archive, entry, 0); continue;
      }
      if (!name.startsWith(`__MACOSX/${product}.app/`) || !path.posix.basename(name).startsWith('._')) throw new Error('App zip contains unrelated resource-fork metadata.');
      const relative = name.slice(`__MACOSX/${product}.app/`.length).replace(/(^|\/)\._([^/]+)$/, '$1$2');
      safePath(relative);
      if (!fs.existsSync(path.join(app, relative)) || entry.uncompressedSize > 1024 ** 2 || ![0, 0o100000].includes(entry.type)) throw new Error('App zip resource metadata has no matching application file.');
      await zipFileDigest(archive, entry, 1024 ** 2); continue;
    }
    safePath(name);
    if (name !== `${product}.app` && !name.startsWith(`${product}.app/`)) throw new Error('App zip contains files outside its single application.');
    const relative = name === `${product}.app` ? '' : name.slice(`${product}.app/`.length), file = path.join(app, relative), fileStat = fs.lstatSync(file);
    if (entry.name.endsWith('/')) {
      if (!fileStat.isDirectory() || entry.uncompressedSize || ![0, 0o040000].includes(entry.type)) throw new Error('App zip directory differs from its application.');
      await zipFileDigest(archive, entry, 0); continue;
    }
    if (!expected.delete(relative)) throw new Error('App zip contains an unlisted application file.');
    let digest;
    if (fileStat.isSymbolicLink()) {
      const link = Buffer.from(fs.readlinkSync(file));
      if (entry.type !== 0o120000 || link.length !== entry.uncompressedSize) throw new Error('App zip does not preserve an application link.');
      digest = B.digest(link);
    } else {
      if (!fileStat.isFile() || ![0, 0o100000].includes(entry.type) || fileStat.size !== entry.uncompressedSize ||
          entry.mode && (entry.mode & 0o777) !== (fileStat.mode & 0o777)) throw new Error('App zip does not preserve application file sizes or permissions.');
      digest = await Payload.checksum(file);
    }
    if (await zipFileDigest(archive, entry, entry.uncompressedSize) !== digest) throw new Error('App zip contents differ from the verified application.');
    compared++;
  }
  if (!names.has(`${product}.app/Contents/Resources/app.asar`) || !names.has(`${product}.app/Contents/Info.plist`)) throw new Error('App zip is missing the application archive or Info.plist.');
  if (expected.size) throw new Error('App zip is missing application files.');
  return { passed: true, mode: 'zip', sha256, bytes: stat.size, entries: entries.length, expandedBytes: expanded, comparedFiles: compared };
}
async function main(args) {
  const [mode, ...rest] = args.filter(value => value !== '--'), options = {};
  const names = new Set(['--arch', '--maximum-macos', '--resources', '--sources', '--app', '--inventory', '--archive', '--sha256', '--sign-identity']);
  for (let index = 0; index < rest.length; index += 2) {
    if (!names.has(rest[index]) || !rest[index + 1] || options[rest[index]]) throw new Error('Use unique packaging-check options with explicit values.');
    options[rest[index]] = rest[index + 1];
  }
  const config = { arch: options['--arch'], maximumMacOS: options['--maximum-macos'] };
  if (mode === 'plan') return Model.createPlan(config);
  if (mode === 'source') return verifySource({ ...config, resourceRoot: options['--resources'], sourceRoot: options['--sources'], signingIdentity: options['--sign-identity'],
    inventory: options['--inventory'] ? JSON.parse(B.readRegular(options['--inventory'], Payload.LIMITS.metadataBytes).bytes) : undefined });
  if (mode === 'app' && options['--app'] && options['--inventory']) {
    const app = verifyApp({ ...config, appPath: options['--app'], inventory: JSON.parse(B.readRegular(options['--inventory'], Payload.LIMITS.metadataBytes).bytes) });
    if (options['--archive']) return { app, zip: await verifyZip({ archive: options['--archive'], sha256: options['--sha256'], appPath: options['--app'] }) };
    return app;
  }
  throw new Error('Usage: node scripts/check-packaging.cjs plan|source|app --arch arm64 --maximum-macos 13.0 [--resources DIR --sources DIR] [--app MacLauncher.app --inventory JSON --archive ZIP --sha256 SHA256]');
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { LIMITS, safePath, configurationCheck, verifySource, appTree, inspectAsar, inspectSourceArchive, assertRuntimeBoundary, verifyApp, verifyZip, main };
