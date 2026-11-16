'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {validateSource, validateBuild} = require('./schema');
const Catalog = require('../modules/shared/runtime/runtime-catalog');
const {writeJsonAtomic, readJsonObject} = require('../core/json-files');
const {runDownloadTask} = require('../modules/shared/runtime/download-manager');
const {buildRuntimeDownloadMeta} = require('../modules/shared/runtime/runtime-downloads');
const {throwIfAborted} = require('../modules/shared/runtime/download-utils');
const {fileDigest} = require('../modules/shared/runtime/verified-identity');
const {inspectBinary} = require('../core/binary-arch');
const {getKind} = require('../core/component-kinds');
const {discoverSource} = require('./discovery');
const {projectAvailableBuild} = require('./available-build');
const {installBuild} = require('./install');

const contained = (root, file) => { const relative = path.relative(root, file); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const sectionId = source => source.manager?.sectionId || source.id;
const sourceUrl = source => source.credits?.url || (source.discover.repo ? 'https://github.com/' + source.discover.repo : source.discover.catalog || null);

// The ordinary runtime receipt owns integrity metadata outside the publisher's
// payload. These are file facts, not a second package or architecture policy.
function payloadInventory(root) {
  const base = fs.realpathSync(root), files = [];
  function walk(relative, depth) {
    if (depth > 128 || files.length > 250000) throw new Error('The runtime payload exceeds inventory bounds.');
    for (const entry of fs.readdirSync(path.join(base, relative), {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + entry.name : entry.name, file = path.join(base, name);
      if (entry.isSymbolicLink()) {
        if (!contained(base, fs.realpathSync(file))) throw new Error('A runtime link is outside its payload.');
        files.push({path: name, target: fs.readlinkSync(file)});
      } else if (entry.isDirectory()) walk(name, depth + 1);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        files.push({path: name, size: stat.size, mode: stat.mode & 0o777, sha256: fileDigest(file).sha256});
      } else throw new Error('The runtime payload contains an unsupported filesystem member.');
    }
  }
  walk('', 0);
  return files;
}

function decorate(build, source) {
  return {...build, label: build.label || source.label, order: source.order,
    ...(source.manager?.engine ? {engine: source.manager.engine} : {}),
    ...(source.selector ? {selector: structuredClone(source.selector)} : {}),
    ...(source.automatic ? {automatic: structuredClone(source.automatic)} : {}),
    ...(source.labels ? {labels: structuredClone(source.labels)} : {}),
    ...(source.layer ? {layer: structuredClone(source.layer)} : {})};
}

function createSourceBackend({id, source, sources = source ? [source] : [], dependencies = {}} = {}) {
  if (!sources.length) throw new TypeError('A runtime source declaration is required.');
  sources.forEach(validateSource);
  sources = structuredClone(sources);
  const kind = sources[0].kind;
  if (sources.some(item => item.kind !== kind) || new Set(sources.map(item => item.id)).size !== sources.length)
    throw new TypeError('A source backend requires distinct sources of one kind.');
  id ||= sources[0].manager?.id || sources[0].id;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new TypeError('A safe runtime manager id is required.');
  const byId = new Map(sources.map(item => [item.id, item])), pending = new Map();
  const label = sources.length === 1 ? sources[0].label : getKind(kind).label;
  const root = userDataDir => path.dirname(Catalog.catalogPath(userDataDir, id));
  const cached = userDataDir => Catalog.readRuntimeCatalog({userDataDir, managerId: id, maxEntries: 2000,
    validateEntry: item => byId.has(item.source) && typeof item.id === 'string' && typeof item.version === 'string' && item.asset});
  const storageVersion = build => {
    const version = build.version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80).replace(/^[^A-Za-z0-9]+/, '') || 'build';
    return version + '-' + crypto.createHash('sha256').update(build.id).digest('hex').slice(0, 24);
  };
  const installDirectory = (userDataDir, build) => path.join(root(userDataDir), storageVersion(build));
  const normalizeSettings = settings => ({...settings, defaultVersion: typeof settings?.defaultVersion === 'string' ? settings.defaultVersion : null});

  function available(offer) {
    const declaration = byId.get(offer.source), name = offer.asset?.filename || offer.asset?.name;
    const rules = declaration.assets?.filter(rule => new RegExp(rule.match).test(name || '')) || [];
    if (rules.length !== 1) throw new Error('The cached runtime asset has no unique current declaration.');
    const projected = projectAvailableBuild({source: declaration, asset: rules[0], id: offer.id, version: offer.version,
      bytes: offer.asset.bytes, provenance: {...offer.provenance, assetUrl: offer.asset.url}});
    if (JSON.stringify(projected.declares) !== JSON.stringify(offer.declares)) throw new Error('The cached runtime declaration changed. Refresh versions.');
    return {...decorate(projected, declaration), prerelease: offer.prerelease === true,
      legacy: {managerId: id, version: offer.version, installOptions: {buildId: offer.id, sectionId: sectionId(declaration)}}};
  }

  function readInstallation(directory) {
    const receiptFile = path.join(directory, 'runtime.json');
    if (fs.lstatSync(receiptFile).isSymbolicLink() || fs.statSync(receiptFile).size > 8 * 1024 * 1024) throw new Error('The runtime receipt is not a bounded regular file.');
    const record = readJsonObject(receiptFile), measured = record?.installationMetadata?.build;
    validateBuild(measured);
    const declaration = byId.get(measured.source), payloadRoot = fs.realpathSync(path.join(directory, 'payload'));
    if (!declaration || measured.installed !== true || measured.measured !== true || measured.kind !== kind ||
        measured.root !== path.join(directory, 'payload') || !contained(fs.realpathSync(directory), payloadRoot))
      throw new Error('The runtime receipt does not describe this managed payload.');
    if (JSON.stringify(payloadInventory(payloadRoot)) !== JSON.stringify(record.installationMetadata.files))
      throw new Error('The installed runtime payload changed; its integrity check failed.');
    const binaries = measured.binaries.map(binary => ({...binary, ...inspectBinary(path.join(payloadRoot, binary.path))}));
    if (JSON.stringify(binaries) !== JSON.stringify(measured.binaries)) throw new Error('The installed runtime binary measurements changed.');
    const build = decorate({...measured, root: payloadRoot}, declaration);
    return {version: build.version, buildId: build.id, installDir: directory, root: payloadRoot, payloadRoot,
      ...(declaration.layout.entry ? {executablePath: path.join(payloadRoot, declaration.layout.entry)} : {}),
      ready: true, source: declaration.id, sourceId: declaration.id, build,
      installationMetadata: record.installationMetadata, catalogEntry: record.catalogEntry, archiveSha256: record.archiveSha256};
  }

  function installations(userDataDir) {
    let names; try { names = fs.readdirSync(root(userDataDir), {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const item of names.filter(item => item.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name))) {
      const directory = path.join(root(userDataDir), item.name), record = readJsonObject(path.join(directory, 'runtime.json'));
      if (!record?.installationMetadata?.build || !byId.has(record.installationMetadata.build.source)) continue;
      try { result.push(readInstallation(directory)); }
      catch (error) {
        const build = record.installationMetadata.build;
        result.push({version: build.version, buildId: build.id, installDir: directory, ready: false, source: build.source,
          error: error.message, build: {id: build.id, source: build.source, kind, version: build.version,
            installed: true, measured: false, binaries: [], available: false, unavailableReason: error.message}});
      }
    }
    return result;
  }

  function listBuilds(context = {}) {
    const installed = installations(context.userDataDir), result = installed.map(item => item.build);
    for (const item of installed.filter(item => item.ready)) {
      const declaration = byId.get(item.source);
      for (const embed of declaration.embeds || []) {
        const matches = binary => embed.parts.some(part => binary.path === part.path || binary.path.startsWith(part.path.replace(/\/$/, '') + '/'));
        const binaries = item.build.binaries.filter(matches);
        if (!binaries.length) continue;
        result.push(validateBuild({id: item.build.id + ':' + embed.id, source: embed.id, kind: embed.kind, version: item.version,
          installed: true, measured: true, root: item.payloadRoot, parent: item.build.id, binaries: structuredClone(binaries),
          parts: structuredClone(embed.parts), label: embed.label || embed.id,
          ...(embed.engine ? {engine: embed.engine} : {}), ...(embed.layer ? {layer: structuredClone(embed.layer)} : {}),
          ...(embed.reach ? {reach: structuredClone(embed.reach)} : {}),
          interfaces: structuredClone(embed.interfaces || {provides: [], requires: []}), provenance: {parent: item.build.id}}));
      }
    }
    for (const offer of cached(context.userDataDir)?.entries || []) {
      if (installed.some(item => item.buildId === offer.id)) continue;
      try { result.push(available(offer)); } catch { /* A changed declaration requires explicit Refresh. */ }
    }
    return result;
  }

  function getState(options = {}) {
    const snapshot = cached(options.userDataDir), installed = installations(options.userDataDir);
    const offers = (snapshot?.entries || []).flatMap(offer => {try {return [available(offer)];} catch {return [];} });
    const settings = normalizeSettings(options.settings), states = snapshot?.sourceStates || {};
    const stateFor = declaration => {
      const rows = declaration ? offers.filter(offer => offer.source === declaration.id) : offers;
      const copies = declaration ? installed.filter(item => item.source === declaration.id) : installed;
      const versions = [...new Set(rows.map(item => item.version))], status = declaration ? states[declaration.id] : null;
      const requirements = Object.fromEntries(rows.map(item => [item.version, {requiresDownload: !copies.some(copy => copy.ready && copy.buildId === item.id),
        requiresBuild: false, available: copies.some(copy => copy.ready && copy.buildId === item.id), installLabel: 'Install',
        ...(item.prerelease ? {prerelease: true} : {})}]));
      return {supportsDefault: true, defaultVersion: settings.defaultVersion, defaultSource: settings.defaultVersion ? 'saved' : 'manager',
        installed: copies, installing: null, variants: [], versionLabels: Object.fromEntries([...versions, ...copies.map(copy => copy.version)].map(version => [version, version])),
        catalog: {status: status?.status || (snapshot ? 'success' : 'idle'), fetchedAt: snapshot?.fetchedAt || null, error: status?.error || null,
          versions, installableVersions: versions, installable: rows.length > 0, buildableVersions: [], versionRequirements: requirements,
          sourceUrl: declaration ? sourceUrl(declaration) : sourceUrl(sources[0]), sourceStates: structuredClone(states),
          ...(declaration && declaration.discover.type !== 'github-releases' ? {installable: false, installReason: 'Discovery transport ' + declaration.discover.type + ' requires its existing backend.'} : {})}};
    };
    return {...stateFor(), sections: sources.map(declaration => ({id: sectionId(declaration), label: declaration.manager?.sectionLabel || declaration.label, ...stateFor(declaration)}))};
  }

  async function refreshCatalog({userDataDir, signal, logger, sectionId: requested, sourceId} = {}) {
    throwIfAborted(signal);
    const previous = cached(userDataDir), entries = [...(previous?.entries || [])], states = {...previous?.sourceStates};
    const selected = sources.filter(item => sourceId ? item.id === sourceId : !requested || sectionId(item) === requested);
    if (!selected.length) throw new Error('The requested runtime publisher section is not declared.');
    for (const declaration of selected) {
      try {
        const discovered = await discoverSource(declaration, {signal, logger, ...(dependencies.github ? {github: dependencies.github} : {})});
        if (!discovered.available) throw new Error(discovered.reason || 'No matching runtime release is available.');
        for (let index = entries.length - 1; index >= 0; index--) if (entries[index].source === declaration.id) entries.splice(index, 1);
        entries.push(...discovered.candidates);
        states[declaration.id] = {status: 'success', error: null};
      } catch (error) {
        throwIfAborted(signal);
        states[declaration.id] = {status: 'error', error: error.message};
        Catalog.writeRuntimeCatalog({userDataDir, managerId: id, entries, sourceStates: states, maxEntries: 2000});
        throw error;
      }
    }
    Catalog.writeRuntimeCatalog({userDataDir, managerId: id, entries, sourceStates: states, maxEntries: 2000});
    return getState({userDataDir}).catalog;
  }

  const execute = (...args) => (dependencies.execute || require('node:util').promisify(require('node:child_process').execFile))(...args);
  async function signedBundle(archive, destination, signal) {
    if ((dependencies.platform || process.platform) !== 'darwin' || !/\.zip$/i.test(archive)) throw new Error('Signed application extraction requires macOS and a ZIP archive.');
    await execute('/usr/bin/ditto', ['-x', '-k', archive, destination], {signal, timeout: 600000, maxBuffer: 1024 * 1024});
    const apps = fs.readdirSync(destination, {withFileTypes: true}).filter(item => item.isDirectory() && item.name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('The signed archive must contain one top-level application bundle.');
    return {root: path.join(destination, apps[0].name)};
  }
  async function signature({root: payload, signal}) {
    if ((dependencies.platform || process.platform) !== 'darwin') throw new Error('Strict code-signature verification requires macOS.');
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', payload], {signal, timeout: 30000, maxBuffer: 1024 * 1024});
    const result = await execute('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', payload], {signal, timeout: 30000, maxBuffer: 1024 * 1024});
    const facts = require('../modules/shared/runtime/native-injection').parseSignature(String(result.stdout || '') + '\n' + String(result.stderr || ''));
    return {verified: true, entitlements: facts.entitlements, teamIdentifier: facts.teamIdentifier};
  }

  async function installRuntime(options = {}) {
    const {userDataDir, version, buildId, signal} = options;
    if (typeof version !== 'string' || !version || version === 'auto') throw new Error('An exact selected runtime version is required.');
    if (options.replace) throw new Error('Managed source installations are immutable.');
    throwIfAborted(signal);
    let offers = cached(userDataDir)?.entries || [];
    if (!offers.some(item => item.version === version && (!buildId || item.id === buildId))) {
      await refreshCatalog(options); offers = cached(userDataDir)?.entries || [];
    }
    const matches = offers.filter(item => item.version === version && (!buildId || item.id === buildId) &&
      (!options.sectionId || sectionId(byId.get(item.source)) === options.sectionId));
    if (matches.length !== 1) throw new Error('An exact unambiguous cached runtime build is required; no other version was selected.');
    const offer = matches[0], declaration = byId.get(offer.source), build = available(offer), directory = installDirectory(userDataDir, build);
    if (fs.lstatSync(directory, {throwIfNoEntry: false})) return readInstallation(directory);
    const key = directory;
    if (pending.has(key)) return pending.get(key);
    const operation = runDownloadTask(options.downloads, buildRuntimeDownloadMeta({managerId: id, sectionId: sectionId(declaration),
      label: declaration.label, version, dedupeKey: 'runtime:' + id + ':' + build.id}), async task => {
      const signals = [signal, task.signal].filter(Boolean), combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const context = {...options, signal: combined, onProgress: task.onProgress};
      const result = await installBuild({build, source: declaration, manager: backend, context, installOptions: {version, buildId, sectionId: sectionId(declaration)}}, {
        ...(dependencies.download ? {download: dependencies.download} : {}),
        ...(dependencies.extractArchive ? {extractArchive: (...args) => dependencies.extractArchive(...args)} : {}),
        extractSignedBundle: signedBundle, verifyCodeSignature: signature,
        resolveAsset: async () => ({asset: offer.asset, verificationFiles: offer.verificationFiles || []}),
        prepareInstallation: async () => {
          fs.mkdirSync(root(userDataDir), {recursive: true});
          const staging = fs.mkdtempSync(path.join(root(userDataDir), '.install-')), work = path.join(staging, 'work');
          fs.mkdirSync(work); let published = false;
          return {directory: work, destination: path.join(directory, 'payload'),
            async commit({root: payload, build: measured, verification, asset}) {
              throwIfAborted(combined);
              if (fs.lstatSync(directory, {throwIfNoEntry: false})) throw new Error('The immutable runtime destination already exists.');
              const publication = path.join(staging, 'publication'); fs.mkdirSync(publication);
              const files = payloadInventory(payload);
              fs.renameSync(payload, path.join(publication, 'payload'));
              writeJsonAtomic(path.join(publication, 'runtime.json'), {version: storageVersion(build), upstreamRevision: offer.provenance?.revision || version,
                catalogEntry: {...offer, version: storageVersion(build), upstreamRevision: offer.provenance?.revision || version},
                archiveSha256: verification.archiveSha256, assetUrl: asset.url, source: 'download', installedAt: new Date().toISOString(),
                installationMetadata: {build: measured, verification, files, embeds: declaration.embeds || []}});
              throwIfAborted(combined);
              fs.renameSync(publication, directory); published = true;
              try { const installed = readInstallation(directory); fs.rmSync(staging, {recursive: true, force: true}); return installed; }
              catch (error) { if (published) fs.rmSync(directory, {recursive: true, force: true}); published = false; throw error; }
            },
            async rollback() { if (published) fs.rmSync(directory, {recursive: true, force: true}); fs.rmSync(staging, {recursive: true, force: true}); }
          };
        }
      });
      require('../core/runtime-inventory-revision').advance();
      return result.installed;
    }, {onProgress: options.onProgress});
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }

  function resolveSelection(_entry, _settings, userDataDir, options = {}) {
    const matches = installations(userDataDir).filter(item => item.version === options.version && (!options.buildId || item.buildId === options.buildId));
    if (matches.length === 1 && matches[0].ready) return {version: options.version, ready: true, install: matches[0], requiresDownload: false};
    return {version: options.version || null, ready: false, install: null, requiresDownload: true,
      reason: matches.length > 1 ? 'An exact runtime build identity is required.' : matches[0]?.error || 'The selected runtime build is not installed.'};
  }

  const backend = {id, kind, label, sources, sourceIds: sources.map(item => item.id), ui: {groupId: kind, tabLabel: getKind(kind).label},
    delivery: {included: 'none', catalog: 'remote', sourceBuild: false}, supportsDefault: true,
    getState, refreshCatalog, installRuntime, listBuilds, resolveSelection, normalizeSettings,
    applySettingsUpdate: (action, payload, settings) => action === 'setDefault' ? {...normalizeSettings(settings), defaultVersion: payload?.version || null} : settings,
    updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion ? settings : {...settings, defaultVersion: installed.version},
    core: {listInstalled: userDataDir => installations(userDataDir), listDiscoveredCatalog: ({userDataDir} = {}) => cached(userDataDir)?.entries || [],
      resolveInstalled: ({userDataDir, version, buildId} = {}) => resolveSelection(null, null, userDataDir, {version, buildId}).install,
      getInstallDir: ({userDataDir, build} = {}) => installDirectory(userDataDir, build)}};
  return backend;
}

module.exports = {createSourceBackend};
