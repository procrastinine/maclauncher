'use strict';
// A Wine source declared only by its JSON file. Its releases are the GitHub
// releases with an asset matching one of the source's CPU patterns, verified by
// the publisher's SHA-256: the checksum file published beside the archive, or
// the digest GitHub lists for it. The installed Wine tree is found by its
// files, never by a declared path, and nothing inside the download is moved,
// so a signed application keeps its signature.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Upstream = require('../modules/shared/runtime/upstream');
const Host = require('../modules/shared/runtime/bundled-native');
const {throwIfAborted} = require('../modules/shared/runtime/download-utils');
const {normalizeArchitecture} = require('../modules/shared/runtime/architecture');

const UNIX = {arm64: 'aarch64-unix', x64: 'x86_64-unix'};
const missingApplication = (source, version) => `${source.label} ${version} runs through ${String(Object.values(source.upstream.app).find(Boolean)).split('/')[0].replace(/\.app$/i, '')}, which is not installed.`;
// A CPU whose downloads a source declares incomplete on their own (`upstream.unavailable`, CPU to the wording that
// follows the build's name): its builds are listed with that reason and never download.
const declaredUnavailable = (source, architecture, version) => {
  const phrase = Object.entries(source.upstream?.unavailable && typeof source.upstream.unavailable === 'object' ? source.upstream.unavailable : {})
    .find(([cpu]) => normalizeArchitecture(cpu) === architecture)?.[1];
  return phrase ? `${source.label} ${version} ${phrase}.` : null;
};
// A release's version starts at the first dotted number of its tag.
const tagVersion = tag => /\d+\.\d+.*$/.exec(String(tag || ''))?.[0] || null;
// An application whose executable a CPU's build runs through, in the system or
// the user's Applications folder. Null when it is not installed.
function applicationLoader(source, architecture, {applicationDirectories} = {}) {
  const relative = Object.entries(source.upstream?.app && typeof source.upstream.app === 'object' ? source.upstream.app : {})
    .find(([cpu]) => normalizeArchitecture(cpu) === architecture)?.[1];
  if (!relative) return undefined;
  for (const directory of applicationDirectories || ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const file = path.join(directory, relative);
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

function createCatalog(source, dependencies = {}) {
  const upstream = source.upstream, label = source.label;
  const patterns = Object.entries(upstream.assets || {}).map(([cpu, pattern]) => [normalizeArchitecture(cpu), new RegExp(pattern, 'i')]);
  const architectureOf = name => patterns.find(([, pattern]) => pattern.test(name || ''))?.[0] || null;
  const SOURCE_URL = `https://github.com/${upstream.github}/releases`;
  const checksumOf = (files, name) => files.find(file => file.name === `${name}.sha256`) || files.find(file => /^sha256sums(?:\.txt)?$/i.test(file.name));
  const github = Upstream.github({repository: upstream.github, prerelease: upstream.prereleases === true, allArchitectures: true,
    // One archive per CPU: among several matching names, the one with its own
    // checksum file, then the shortest name.
    recognize: release => {
      const assets = release.assets || [], version = tagVersion(release.tag_name), byCpu = new Map();
      for (const asset of assets.filter(asset => architectureOf(asset.name))) byCpu.set(architectureOf(asset.name), [...(byCpu.get(architectureOf(asset.name)) || []), asset]);
      const archives = [...byCpu.values()].map(found => found.sort((a, b) => Number(!assets.some(item => item.name === `${a.name}.sha256`)) -
        Number(!assets.some(item => item.name === `${b.name}.sha256`)) || a.name.length - b.name.length)[0]);
      return version ? archives.map(asset => ({version: archives.length > 1 ? `${version}-${architectureOf(asset.name)}` : version,
        assets: [asset, ...[checksumOf(assets, asset.name)].filter(Boolean)]})) : [];
    }});
  const versionLabel = (pin, installed) => {
    const record = pin || installed?.catalogEntry || installed;
    return record?.version ? `${label} ${record.version}` : record?.versionLabel;
  };
  function entryFor(row) {
    const archive = row.files.find(file => architectureOf(file.name) && !/\.sha256$/i.test(file.name));
    if (!archive) return null;
    const checksum = checksumOf(row.files, archive.name), asset = Upstream.asset(archive);
    const tag = row.sourceUrl ? decodeURIComponent(row.sourceUrl.split('/').pop()) : '';
    return {version: row.version, versionLabel: versionLabel({version: row.version}), upstreamTag: tag,
      upstreamRevision: `${tag || row.version}:${asset.sha256 ? 'sha256:' + asset.sha256 : asset.url}`.slice(0, 200),
      sourceUrl: SOURCE_URL, localBuild: false, asset, ...(checksum ? {checksum: Upstream.asset(checksum)} : {}),
      downloadBytes: asset.bytes || 0, ...(row.publishedAt ? {publishedAt: row.publishedAt} : {})};
  }
  function validateEntry(pin) {
    try { return Boolean(pin?.version && pin.asset?.filename && architectureOf(pin.asset.filename) && (pin.asset.sha256 || pin.checksum?.url) &&
      [pin.asset.url, ...(pin.checksum ? [pin.checksum.url] : [])].every(url => new URL(url).protocol === 'https:')); }
    catch { return false; }
  }
  const {compareRuntimeVersions} = require('../modules/shared/runtime/pinned-native-manager');
  // Every listed release, newest first.
  async function discover(options = {}) {
    const result = new Map();
    for (const row of await github.discover(options)) {
      const pin = entryFor(row);
      if (pin && validateEntry(pin) && !result.has(pin.version)) result.set(pin.version, pin);
    }
    return [...result.values()].sort((a, b) => compareRuntimeVersions(a.version, b.version));
  }
  discover.allArchitectures = true;
  // A build that runs through an application's executable is installable only
  // while that application is installed; a build of a CPU the source declares
  // unavailable never is.
  function describeRequirements(pins, requirements) {
    for (const pin of pins) {
      const architecture = architectureOf(pin.asset?.filename), loader = applicationLoader(source, architecture, dependencies);
      const reason = declaredUnavailable(source, architecture, pin.version) || (loader === null ? missingApplication(source, pin.version) : null);
      requirements[pin.version] = {...requirements[pin.version], downloadBytes: pin.downloadBytes, ...(reason ? {installReason: reason} : {})};
    }
  }
  async function verify({archiveSha256, pin, signal}) {
    if (pin?.checksum) return require('../runtime-sources/verification').verifySumsFile({archiveSha256, checksum: pin.checksum, filename: pin.asset?.filename, signal, label}, dependencies);
    if (pin?.asset?.sha256 !== archiveSha256) throw new Error(`The ${label} archive does not match its published SHA-256. No runtime was installed.`);
    return {verified: true, archiveSha256, identity: `publisher-sha256:${archiveSha256}`};
  }
  return {SOURCE_URL, source: github, versionLabel, entryFor, validateEntry, discover, describeRequirements, verify, architectureOf};
}

// The Wine tree of an unpacked download: the folder holding lib/wine with a
// wine executable in bin or, inside an application, MacOS.
function findWine(unpacked) {
  const found = [];
  (function visit(directory, depth) {
    let entries;
    try { entries = fs.readdirSync(directory, {withFileTypes: true}); } catch { return; }
    // A tools folder that is only a link to another (an application's bin to
    // its MacOS) comes after the real one.
    const linked = name => entries.some(entry => entry.name === name && entry.isSymbolicLink());
    if (entries.some(entry => entry.name === 'lib' && entry.isDirectory()) && fs.existsSync(path.join(directory, 'lib', 'wine')))
      for (const bin of ['bin', 'MacOS'].sort((a, b) => linked(a) - linked(b))) for (const name of ['wine', 'wine64']) {
        const file = path.join(directory, bin, name);
        try { fs.lstatSync(file); } catch { continue; }
        if (!found.some(item => item.root === directory)) found.push({root: directory, entry: file,
          server: ['wineserver'].map(server => path.join(directory, bin, server)).find(server => fs.existsSync(server)) || null});
      }
    if (depth < 6) for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '__MACOSX') visit(path.join(directory, entry.name), depth + 1);
  })(unpacked, 0);
  if (found.length !== 1) return null;
  const relative = file => file && path.relative(unpacked, file).split(path.sep).join('/');
  return {root: relative(found[0].root) || '.', entry: relative(found[0].entry), server: relative(found[0].server)};
}

function createPayload(source, dependencies = {}) {
  const Shared = require('../modules/crossover/sources/wine-payload'), label = source.label;
  async function preparePayload({unpacked, pin, signal, onProgress}) {
    throwIfAborted(signal);
    const tree = findWine(unpacked);
    if (!tree) throw new Error(`The ${label} download contains no complete Wine tree. No runtime was installed.`);
    onProgress?.({downloaded: pin?.downloadBytes || 0, total: pin?.downloadBytes || 0, detail: `${pin?.versionLabel || label} · Checking installed files…`});
    // A build that runs through an application's signed loader reaches it
    // through the Wine tree's own Unix loader path, where Wine looks for it.
    const architecture = require('./wine').assetArchitecture(source, pin?.asset?.filename);
    const unavailable = declaredUnavailable(source, architecture, pin?.version || '');
    if (unavailable) throw new Error(unavailable);
    const loader = applicationLoader(source, architecture, dependencies);
    if (loader === null) throw new Error(missingApplication(source, pin?.version || ''));
    const external = loader ? [loader, fs.realpathSync(loader)] : [];
    if (loader) {
      const link = path.join(unpacked, tree.root, 'lib', 'wine', UNIX[architecture], 'wine');
      fs.rmSync(link, {force: true}); fs.symlinkSync(loader, link);
    }
    const records = Shared.walk(unpacked, signal, label, external);
    const required = records.some(row => row.relative === tree.entry && row.kind === 'file') ? [tree.entry] : [];
    // Wine loads native code from its bin and lib folders. Native files a
    // download keeps under share (an application's own assets) are not Wine's
    // and do not decide its CPU.
    const share = path.posix.join(tree.root, 'share') + '/';
    const native = Shared.inspectClosure(unpacked, records, signal, {label, required, skip: relative => relative.startsWith(share),
      executableRoot: path.join(unpacked, path.dirname(tree.entry))});
    if (!Host.versionAtLeast((dependencies.systemVersionSync || Host.systemVersionSync)(), native.minimumMacOS)) throw new Error(Shared.requiresMacOS(native.minimumMacOS));
    const wineRoot = path.join(unpacked, tree.root);
    const inventory = await Shared.writeInventory(unpacked, records, signal, label);
    return {schemaVersion: 1, wineRoot: tree.root, entry: tree.entry, ...(tree.server ? {server: tree.server} : {}), ...(loader ? {loader} : {}), inventory,
      minimumMacOS: native.minimumMacOS, architectures: native.architectures, nativeComponents: native.nativeComponents,
      inspectionVersion: Shared.INSPECTION_VERSION, capabilities: Shared.wineCapabilities(wineRoot), wineVersion: Shared.wineVersion(wineRoot)};
  }
  function createPayloadResolver({systemVersionSync = Host.systemVersionSync} = {}) {
    const check = Shared.createInventoryCheck({label, systemVersionSync});
    function resolvePayload(install, {verification = 'full', signal} = {}) {
      if (!install) return {install: null, reason: `${label} is not installed.`};
      try {
        throwIfAborted(signal);
        const evidence = install.installationMetadata;
        if (evidence?.schemaVersion !== 1 || !Shared.safeRelative(evidence.entry) || !(evidence.wineRoot === '.' || Shared.safeRelative(evidence.wineRoot)))
          throw new Error(`${label} registration is incomplete. Remove and install this version again.`);
        if (evidence.loader && !fs.existsSync(evidence.loader)) return {install: null, reason: missingApplication(source, install.version)};
        const external = evidence.loader ? [evidence.loader, fs.realpathSync(evidence.loader)] : [];
        const supported = check(install.installDir, evidence.inventory, {verification, signal, important: new Set([evidence.entry]), minimumMacOS: evidence.minimumMacOS, external});
        if (!supported.supported) return {install: null, reason: supported.reason, minimumMacOS: evidence.minimumMacOS};
        const wineRoot = path.join(install.installDir, evidence.wineRoot), inspected = Shared.currentInspection(install.installDir, evidence, wineRoot);
        return {install: {...install, wineRoot, engineRoot: wineRoot, executablePath: path.join(install.installDir, evidence.entry),
          ...(evidence.server ? {serverPath: path.join(install.installDir, evidence.server)} : {}), libraryRoot: path.join(wineRoot, 'lib'),
          capabilities: inspected.capabilities, minimumMacOS: evidence.minimumMacOS, architectures: evidence.architectures,
          wineVersion: inspected.wineVersion || '', engineVersion: inspected.wineVersion || install.version, componentVersions: {}},
        reason: null, minimumMacOS: evidence.minimumMacOS};
      } catch (error) { if (error.name === 'AbortError') throw error; return {install: null, reason: error.message}; }
    }
    resolvePayload.prepare = (install, options) => { const loader = install.installationMetadata?.loader;
      return check.prepare(install.installDir, install.installationMetadata?.inventory, {...options, external: loader && fs.existsSync(loader) ? [loader, fs.realpathSync(loader)] : []}); };
    return resolvePayload;
  }
  const installDetail = (pin, selection) => `${selection.repairRequired ? 'Reinstalls' : 'Downloads'} ${label}${pin.downloadBytes ? ` (${Math.ceil(pin.downloadBytes / 1024 / 1024)} MB)` : ''}.`;
  // A Wine folder or application the user selects, used where it is: its tree
  // is found by its files, as in a download, and nothing in it is moved,
  // linked or written. A build that runs through an application's loader must
  // already reach it from its own Unix loader path.
  function inspectCustom(selected, {verification} = {}) {
    let root = fs.statSync(selected).isDirectory() ? selected : path.dirname(selected), tree = findWine(root);
    for (let depth = 0; !tree && root !== selected && depth < 4 && path.dirname(root) !== root; depth += 1) tree = findWine(root = path.dirname(root));
    if (!tree) throw new Error(`Select a complete ${label} folder or application, including its Wine engine and libraries.`);
    const loaders = Object.keys(source.upstream?.app || {}).map(cpu => [normalizeArchitecture(cpu), applicationLoader(source, normalizeArchitecture(cpu), dependencies)]);
    const external = loaders.flatMap(([, file]) => file ? [file, fs.realpathSync(file)] : []);
    const share = path.posix.join(tree.root, 'share') + '/', wineRoot = path.join(root, tree.root);
    const inspected = Shared.inspectCustomTree(root, {label, wineRoot, quick: [tree.entry, tree.server].filter(Boolean),
      required: fs.lstatSync(path.join(root, tree.entry)).isFile() ? [tree.entry] : [], external, skip: relative => relative.startsWith(share),
      executableRoot: path.join(root, path.dirname(tree.entry)), verification, systemVersionSync: dependencies.systemVersionSync || Host.systemVersionSync});
    for (const [architecture, loader] of loaders) {
      if (!inspected.architectures.map(normalizeArchitecture).includes(architecture) || fs.existsSync(path.join(wineRoot, 'lib', 'wine', UNIX[architecture], 'wine'))) continue;
      throw new Error(loader === null ? missingApplication(source, path.basename(root)) : `The selected ${label} does not reach its application's Wine loader.`);
    }
    return {installDir: root, wineRoot, engineRoot: wineRoot, executablePath: path.join(root, tree.entry),
      ...(tree.server ? {serverPath: path.join(root, tree.server)} : {}), libraryRoot: path.join(wineRoot, 'lib'),
      capabilities: inspected.capabilities, minimumMacOS: inspected.minimumMacOS, architectures: inspected.architectures,
      architecture: Shared.customArchitecture(inspected.architectures), wineVersion: inspected.wineVersion || '',
      engineVersion: inspected.wineVersion || '', componentVersions: {}, ...(inspected.wineVersion ? {runtimeVersion: inspected.wineVersion, versionLabel: `${label} ${inspected.wineVersion}`} : {})};
  }
  const configureCustom = manager => Shared.configureCustom(manager, inspectCustom);
  return {preparePayload, createPayloadResolver, installDetail, inspectCustom, configureCustom};
}

const managers = new Map();
// The source-backed manager of a Wine declared only by its JSON file.
function createManager(id, {dependencies = {}} = {}) {
  const Wine = require('./wine'), source = Wine.definition(id);
  const Catalog = createCatalog(source, dependencies), Payload = createPayload(source, dependencies);
  return require('../runtime-sources/manager').createSourceBackedManager({source, adapter: Wine, dependencies: {...dependencies, catalog: Catalog, payload: Payload,
    discoverCatalog: dependencies.discoverCatalog || Catalog.discover, extractArchive: dependencies.extractArchive || require('../modules/shared/runtime/safe-archive').extractArchive,
    verifyArtifact: options => Catalog.verify(options)}});
}
function manager(id) { if (!managers.has(id)) managers.set(id, createManager(id)); return managers.get(id); }
module.exports = {createCatalog, createPayload, createManager, manager, findWine, applicationLoader};
