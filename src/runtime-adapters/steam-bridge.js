'use strict';
const path = require('node:path');
const { validate } = require('../modules/shared/runtime/launch-arguments');

// The bootstrap's embedded command line uses Windows quoting, not shell escapes.
function windowsArguments(text) {
  const args = []; let token = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quoted && /[ \t]/.test(c)) {
      if (started) args.push(token);
      token = ''; started = false; continue;
    }
    started = true;
    if (c === '\\') {
      let count = 1;
      while (text[i + 1] === '\\') { count++; i++; }
      if (text[i + 1] === '"') {
        token += '\\'.repeat(Math.floor(count / 2)); i++;
        if (count % 2) token += '"';
        else if (quoted && text[i + 1] === '"') { token += '"'; i++; }
        else quoted = !quoted;
      } else token += '\\'.repeat(count);
    } else if (c === '"') {
      if (quoted && text[i + 1] === '"') { token += '"'; i++; }
      else quoted = !quoted;
    }
    else token += c;
  }
  if (quoted) throw new Error('The Windows bootstrap has an unclosed argument quote.');
  if (started) args.push(token);
  return validate(args);
}

// Parts are admitted by the execution plan. Host and Windows libraries remain
// in the same build; this adapter does not choose a CPU or a Wine source.
function windowsPath(file) {
  return '\\\\?\\unix' + file.split(path.sep).join('\\');
}
function apply({ build, parts, environment = {}, parameters = {} }) {
  if (!parts?.native) throw new Error('The Steam bridge plan has no admitted native host library.');
  for (const name of ['builtin', 'bootstrap', 'helper'])
    if (!parts[name]) throw new Error(`The Steam bridge plan has no admitted ${name} library.`);
  const extra = {
    WINEDLLPATH: [...new Set([build.root, ...String(environment.WINEDLLPATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter),
    WINEDLLOVERRIDES: [environment.WINEDLLOVERRIDES, 'lsteamclient=b'].filter(Boolean).join(';'),
    SteamAppId: String(parameters.appId), SteamGameId: String(parameters.appId),
    STEAM_COMPAT_CLIENT_INSTALL_PATH: parameters.clientRoot,
    MACLAUNCHER_STEAM_BOOTSTRAP: windowsPath(parts.bootstrap),
    MACLAUNCHER_STEAM_BUILTIN: windowsPath(parts.builtin),
    ...Object.fromEntries(Object.entries(parts.clients || {}).map(([name, file]) => [name, windowsPath(file)])),
    HOME: parameters.home, CFFIXED_USER_HOME: parameters.home
  };
  const prepared = { ...environment, ...extra, WINEPREFIX: parameters.prefixPath };
  delete prepared.STEAM_DYLD_INSERT_LIBRARIES;
  delete prepared.NOTPROTON_OVERLAY_SHIM;
  return { environment: prepared, extra, helper: windowsPath(parts.helper), nativeLibrary: parts.native,
    appId: String(parameters.appId), packageVersion: build.version };
}
// Existing Builds packages retain their managed storage and sealed manifest.
function createBackend({ source, dependencies = {} }) {
  const { createProjectBuildManager } = require('../modules/shared/runtime/project-build-manager');
  const Bundled = require('../modules/shared/runtime/bundled-native');
  const catalog = new URL(source.discover.catalog);
  const repository = catalog.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  const manager = createProjectBuildManager({ projectId: source.manager.id, label: source.label, repository,
    upstreamUrl: source.credits.url, upstreamLabel: source.labels.source,
    manifestRelative: 'manifest.json', executableRelative: source.layout.entry, dataOnly: true,
    validateManifest(manifest) {
      if (manifest.managerId !== source.manager.id || !manifest.steamBridge?.native || !manifest.steamBridge?.windows || !manifest.steamBridge?.clientEnvironment)
        throw new Error('The Steam bridge package lacks the managed loader paths required by this launcher and needs replacement.');
    },
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); }, dependencies });
  // A folder the user selects is complete when every part its manifest names
  // is a file in its payload.
  const inspect = manager.customRuntime?.inspect, fs = require('node:fs');
  if (inspect) require('../modules/shared/runtime/custom-runtime').configure(manager, { inspect(runtimePath, options) {
    const selected = inspect(runtimePath, options), root = selected.payloadRoot || selected.root;
    for (const part of bridgeParts(selected.manifest)) {
      const file = path.join(root, Bundled.relativeFile(part.path));
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`The selected ${source.label} folder is missing ${part.path}.`);
    }
    return selected;
  } });
  return manager;
}
// The sealed package's own manifest is the semantic part inventory. CPU and
// logical-library alternatives are measured and admitted by the shared core.
function bridgeParts(manifest) {
  const descriptor = manifest.steamBridge;
  if (!descriptor?.native || !descriptor.windows || !descriptor.clientEnvironment)
    throw new Error('The Steam bridge package has no managed part inventory.');
  return [...Object.values(descriptor.native).map(file => ({ name: 'native', path: file })),
    ...Object.values(descriptor.windows).flatMap(parts => Object.entries(parts).map(([name, file]) => ({ name, path: file })))];
}
function buildRecord({ source, install, id = source.id + ':' + install.version, version = install.version,
  measure = require('../runtime-sources/installed-build').measureBuild }) {
  const parts = bridgeParts(install.manifest), files = [...new Set(parts.map(part => part.path))];
  const declaration = Object.entries(source.upstream.assets||{}).map(([intendedCPU,match])=>({intendedCPU,match})).find(rule =>
    new RegExp(rule.match).test(install.catalogEntry?.asset?.filename || ''));
  const build = measure({ source, root: install.root, files, declares: declaration?.declares,
    id, version, provenance: install.sourceIdentity || {} });
  const floor = install.manifest.minimumMacOS;
  return { ...build, root: install.root, measured: true, parts,
    ...(floor ? {minimumMacOS:floor}: {}) };
}
function listBuilds({ manager, sources, context = {} }) {
  const source = sources[0], result = [], installed = manager.core.listInstalled(context.userDataDir);
  for (const row of installed) {
    const selection = manager.resolveSelection(null, context.settings || {}, context.userDataDir,
      { version: row.version, verification: 'status' });
    if (!selection?.ready || !selection.install) continue;
    const install = selection.install, id = source.id + ':' + row.version;
    try {
      result.push(buildRecord({ source, install, id, version: row.version }));
    } catch (error) {
      result.push({ id, source: source.id, kind: source.kind, version: row.version, installed: true, measured: false,
        binaries: [], available: false, unavailableReason: error.message });
    }
  }
  for (const pin of manager.core.listDiscoveredCatalog({ userDataDir: context.userDataDir })) {
    if (installed.some(row => row.version === pin.version)) continue;
    const declaration = Object.entries(source.upstream.assets||{}).map(([intendedCPU,match])=>({intendedCPU,match})).find(rule => new RegExp(rule.match).test(pin.asset?.filename || pin.asset?.name || ''));
    if (declaration || source.upstream.builds) {
      const { projectAvailableBuild } = require('../runtime-sources/available-build');
      const offer = projectAvailableBuild({ source, asset: declaration, id: source.id + ':' + pin.version,
        version: pin.version, bytes: pin.asset?.bytes, provenance: { catalogEntry: pin } });
      if (pin.minimumMacOS) offer.minimumMacOS=pin.minimumMacOS;
      if (pin.installReason) Object.assign(offer, { available: false, unavailableReason: pin.installReason });
      result.push(offer);
    }
  }
  return result;
}
// Semantic names come from the package manifest. Only the core's admitted
// binaries can become launch parts; this projection makes no CPU decisions.
function projectParts({ build, binaries, clients = {} }) {
  const absolute = file => path.isAbsolute(file) ? file : path.resolve(build.root, file);
  const admitted = new Set(binaries.map(binary => absolute(binary.path)));
  const result = { clients };
  for (const name of ['native', 'builtin', 'bootstrap', 'helper']) {
    const matches = [...new Set((build.parts || []).filter(part => part.name === name)
      .map(part => absolute(part.path)).filter(file => admitted.has(file)))];
    if (matches.length !== 1) throw new Error('The Steam bridge plan has an unavailable or ambiguous ' + name + ' part.');
    result[name] = matches[0];
  }
  return result;
}

// Valve client acquisition shares the Steam bridge kind's consented backend.
const clientComponents = (() => {
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hashFile } = require('../modules/shared/runtime/pinned-native-manager');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const Upstream = require('../modules/shared/runtime/upstream');
const Writable = require('../modules/shared/writable-input');
const { parseSteamVdf } = require('../core/steam-installed-games');
const { readJsonObject, writeJsonAtomic } = require('../core/json-files');
const ORIGIN = 'https://client-update.akamai.steamstatic.com';
const MANIFEST = ORIGIN + '/steam_client_ubuntu12';
const NAMES = ['steamclient64.dll', 'steamclient.dll'];
const MACHINES = { 'steamclient64.dll': 0x8664, 'steamclient.dll': 0x14c };
const { readPeExports } = require('../modules/shared/runtime/pe-exports');
const source = Upstream.service({ hosts: [new URL(ORIGIN).hostname] });
const verified = new Map();
const SHA1 = /^[a-f0-9]{40}$/;
const store = userDataDir => path.join(userDataDir, 'runtimes/steam-client-components');
// The total behind the last verified download. Play's consent shows its size
// offline; the record stays when the files are removed.
const downloadRecord = userDataDir => path.join(userDataDir, 'runtimes/steam-client-download.json');
function lastDownload(userDataDir) {
  const record = readJsonObject(downloadRecord(userDataDir));
  return typeof record?.filename === 'string' && Number.isSafeInteger(record.totalBytes) && record.totalBytes > 0 ? { filename: record.filename, bytes: record.totalBytes } : null;
}
// Every archive of Valve's current client listing, with its content address,
// SHA-256 and size, and the listing's client version.
function resolveManifest(text) {
  const value = parseSteamVdf(text), pending = [value], matches = [];
  const manifestVersion = Object.values(value || {}).map(row => row?.version).find(version => /^\d{1,20}$/.test(String(version || '')));
  while (pending.length) for (const [key, row] of Object.entries(pending.shift())) {
    if (!row || typeof row !== 'object') continue;
    const filename = row.file;
    if (typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip\.[a-f0-9]{40}$/.test(filename)) {
      const bytes = Number(row.size);
      matches.push({ filename, url: ORIGIN + '/' + filename, sha1: filename.slice(-40), ...(Number.isSafeInteger(bytes) && bytes > 0 ? { bytes } : {}),
        ...(/^[a-f0-9]{64}$/.test(row.sha2 || '') ? { sha256: row.sha2 } : {}), ...(manifestVersion ? { manifestVersion: String(manifestVersion) } : {}) });
    } else pending.push(row);
  }
  if (!matches.length) throw new Error('Valve did not list content-addressed client archives.');
  return matches;
}
// Installed versions: one record per content address beside its folder, and
// the record earlier launchers kept only as active.json.
function records(userDataDir) {
  const root = store(userDataDir), result = new Map();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  for (const name of names.sort()) {
    const sha = /^([a-f0-9]{40})\.json$/.exec(name)?.[1], record = sha && readJsonObject(path.join(root, name));
    if (sha && record?.archiveSha1 === sha) result.set(sha, record);
  }
  const active = readJsonObject(path.join(root, 'active.json'));
  if (SHA1.test(active?.archiveSha1 || '') && !result.has(active.archiveSha1)) result.set(active.archiveSha1, active);
  return [...result.values()];
}
function recordFor(userDataDir, version) {
  return version ? records(userDataDir).find(record => record.archiveSha1 === version) || null : readJsonObject(path.join(store(userDataDir), 'active.json'));
}
function completeRecord(record) {
  return SHA1.test(record?.archiveSha1 || '') && Array.isArray(record.files) && record.files.length === NAMES.length &&
    record.clients?.x86_64 === 'steamclient64.dll' && record.clients?.i386 === 'steamclient.dll' &&
    NAMES.every(name => record.files.filter(item => item?.path === name && /^[a-f0-9]{64}$/.test(item.sha256 || '') &&
      Number.isSafeInteger(item.size) && item.size > 0).length === 1);
}
// A verified installed version: the given content address, or the one
// installed last. Its files are hashed once per change.
function current(userDataDir, version) {
  const root = store(userDataDir), record = recordFor(userDataDir, version);
  if (!completeRecord(record)) return null;
  const directory = path.join(root, record.archiveSha1);
  try {
    for (const item of record.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(item.path)) return null;
      const file = path.join(directory, item.path), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const stamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, item.sha256]);
      if (verified.get(file) !== stamp) {
        if (hashFile(file) !== item.sha256 || MACHINES[item.path.toLowerCase()] && readPeExports(file, { headersOnly: true })?.machine !== MACHINES[item.path.toLowerCase()]) { verified.delete(file); return null; }
        verified.set(file, stamp);
      }
    }
    for (const name of Object.values(record.clients)) if (!record.files.some(item => item.path === name)) return null;
    return { ...record, root: directory };
  } catch { return null; }
}
// Runtimes status reads a version's record and file sizes without hashing.
function status(userDataDir, version) {
  try {
    const record = recordFor(userDataDir, version);
    if (!completeRecord(record)) return null;
    const directory = path.join(store(userDataDir), record.archiveSha1);
    for (const item of record.files) {
      const file = fs.lstatSync(path.join(directory, item.path), { throwIfNoEntry: false });
      if (!file?.isFile() || file.isSymbolicLink() || file.size !== item.size) return null;
    }
    return { archiveSha1: record.archiveSha1, source: record.source, bytes: record.files.reduce((sum, item) => sum + item.size, 0),
      ...(record.manifestVersion ? { manifestVersion: record.manifestVersion } : {}), ...(record.installedAt ? { installedAt: record.installedAt } : {}) };
  } catch { return null; }
}
// Without a version, removes every version and the store. With one, removes
// that version's folder and record.
async function remove(userDataDir, version) {
  const root = store(userDataDir);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) return false;
  Writable.assertOwnDirectory(userDataDir, root, { create: false });
  const Shared = require('../modules/shared/runtime/runtime-components');
  if (!version) return Shared.removeOwned(root, userDataDir);
  if (!SHA1.test(version)) throw new Error('Choose an installed Valve client version.');
  const active = readJsonObject(path.join(root, 'active.json'));
  for (const file of [path.join(root, version + '.json'), ...(active?.archiveSha1 === version ? [path.join(root, 'active.json')] : [])]) fs.rmSync(file, { force: true });
  const directory = path.join(root, version);
  const removed = fs.lstatSync(directory, { throwIfNoEntry: false }) ? await Shared.removeOwned(directory, userDataDir) : true;
  if (!fs.readdirSync(root).length) fs.rmdirSync(root);
  return removed;
}
// The listed archive that holds the client DLLs, found from each archive's zip
// directory read in parts, without downloading the archives. Archives of the
// family an earlier download used are read first.
async function zipNames(listed, { signal, range = Upstream.range } = {}) {
  const read = (start, length) => range(Upstream.listedFile({ filename: listed.filename, url: listed.url }), start, length, { signal });
  const total = listed.bytes || (await read(0, 1)).total, tail = Math.min(total, 65557), end = await read(total - tail, tail);
  let at = -1;
  for (let i = end.bytes.length - 22; i >= 0; i--) if (end.bytes.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error(listed.filename + ' has no zip directory.');
  const size = end.bytes.readUInt32LE(at + 12), offset = end.bytes.readUInt32LE(at + 16);
  if (size > 8 << 20 || offset + size > total) throw new Error(listed.filename + ' has an unsupported zip directory.');
  const directory = offset >= total - tail ? end.bytes.subarray(offset - (total - tail), offset - (total - tail) + size) : (await read(offset, size)).bytes;
  const names = [];
  for (let i = 0; i + 46 <= directory.length && directory.readUInt32LE(i) === 0x02014b50;) {
    const length = directory.readUInt16LE(i + 28), extra = directory.readUInt16LE(i + 30), comment = directory.readUInt16LE(i + 32);
    names.push(directory.toString('utf8', i + 46, i + 46 + length)); i += 46 + length + extra + comment;
  }
  return names;
}
const family = filename => String(filename || '').replace(/\.zip\.[a-f0-9]{40}$/, '');
async function discover({ userDataDir, signal, range, resolved } = {}) {
  if (!resolved) {
    const response = await source.request(MANIFEST, { signal, maxBytes: 2 * 1024 * 1024, maxRedirects: 0 });
    if (response.status !== 200) throw new Error('Valve client component metadata is unavailable.');
    resolved = resolveManifest(response.body.toString('utf8'));
  }
  const known = new Set(records(userDataDir).map(record => family(path.posix.basename(String(record.source || '')))));
  const ordered = [...resolved].sort((a, b) => Number(!known.has(family(a.filename))) - Number(!known.has(family(b.filename))));
  for (const candidate of ordered) {
    const names = (await zipNames(candidate, { signal, range })).map(name => path.posix.basename(name).toLowerCase());
    if (!NAMES.every(name => names.includes(name))) continue;
    const row = { version: candidate.sha1, ...candidate, fetchedAt: new Date().toISOString() };
    const root = store(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
    writeJsonAtomic(path.join(root, 'catalog.json'), { schemaVersion: 1, rows: [row] });
    return [row];
  }
  throw new Error('Valve archives did not contain the Windows Steam client DLLs.');
}
// The versions the last Refresh listed. Reading it is offline.
function catalog(userDataDir) {
  const rows = readJsonObject(path.join(store(userDataDir), 'catalog.json'))?.rows;
  return Array.isArray(rows) ? rows.filter(row => SHA1.test(row?.sha1 || '') && row.version === row.sha1 && row.url === ORIGIN + '/' + row.filename) : [];
}
// Called only from consented installs. Without a version it keeps the
// version installed last; with one it installs that listed version.
async function install({ userDataDir, signal, onProgress, resolved, version } = {}) {
  const existing = current(userDataDir, version); if (existing) return existing;
  if (version && !resolved) resolved = catalog(userDataDir).filter(row => row.sha1 === version);
  if (version && !resolved?.length) throw new Error('Refresh the Valve client versions before installing this one.');
  if (!resolved) {
    const response = await source.request(MANIFEST, { signal, maxBytes: 2 * 1024 * 1024, maxRedirects: 0 });
    if (response.status !== 200) throw new Error('Valve client component metadata is unavailable.');
    resolved = resolveManifest(response.body.toString('utf8'));
  }
  let totalBytes = 0;
  for (const candidate of Array.isArray(resolved) ? resolved : [resolved]) {
    const expected = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip\.([a-f0-9]{40})$/.exec(candidate.filename || '');
    resolved = candidate;
    if (!expected || resolved.url !== ORIGIN + '/' + resolved.filename) throw new Error('Valve components require an official content-addressed archive.');
    const root = store(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
    const stage = fs.mkdtempSync(path.join(root, '.install-'));
    try {
      const archive = path.join(stage, 'client.zip');
      await Upstream.download({ url: resolved.url, name: resolved.filename, ...(resolved.bytes ? { bytes: resolved.bytes } : {}), digest: { algorithm: 'sha1', value: expected[1] } }, archive, { signal, onProgress });
      if (hashFile(archive, 'sha1') !== expected[1]) throw new Error('Valve component archive differs from its content address.');
      if (resolved.sha256 && hashFile(archive) !== resolved.sha256) throw new Error('Valve component archive differs from its listed SHA-256.');
      totalBytes += fs.statSync(archive).size;
      const listing = await execute('/usr/bin/unzip', ['-Z1', archive], { signal, timeout: 120000 });
      const members = listing.stdout.trim().split('\n');
      const selected = NAMES.map(name => members.filter(member => path.posix.basename(member).toLowerCase() === name));
      if (selected.some(matches => !matches.length)) continue;
      const paths = selected.flat();
      if (paths.some(member => member.startsWith('/') || member.includes('\\') || member.split('/').some(part => part === '..' || part === '.')))
        throw new Error('Valve client archive contains an unsafe client path.');
      const extracted = path.join(stage, 'extracted'); fs.mkdirSync(extracted);
      await execute('/usr/bin/unzip', ['-q', archive, ...paths, '-d', extracted], { signal, timeout: 120000 });
      const clients = { x86_64: 'steamclient64.dll', i386: 'steamclient.dll' }, payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
      const files = Object.entries(clients).map(([arch, name]) => {
        const candidates = selected[arch === 'i386' ? 1 : 0].map(member => {
          const file = path.join(extracted, member), stat = fs.lstatSync(file);
          if (!stat.isFile()) throw new Error('Valve client archive contains a non-regular client file.');
          if (readPeExports(file, { headersOnly: true })?.machine !== MACHINES[name]) throw new Error(name + ' has the wrong Windows CPU.');
          return { file, sha256: hashFile(file), size: stat.size };
        });
        if (new Set(candidates.map(item => item.sha256)).size !== 1) throw new Error('Valve client archive has different files with the same client name.');
        fs.renameSync(candidates[0].file, path.join(payload, name));
        fs.chmodSync(path.join(payload, name), 0o644);
        return { path: name, sha256: candidates[0].sha256, size: candidates[0].size };
      });
      const directory = path.join(root, expected[1]);
      const valid = fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() && files.every(item => {
        try { const file = path.join(directory, item.path); return fs.lstatSync(file).isFile() && hashFile(file) === item.sha256; }
        catch { return false; }
      });
      const record = { archiveSha1: expected[1], source: resolved.url, clients, files,
        ...(resolved.manifestVersion ? { manifestVersion: resolved.manifestVersion } : {}), installedAt: new Date().toISOString() };
      let damaged, replaced = false;
      try {
        if (!valid) {
          if (fs.lstatSync(directory, { throwIfNoEntry: false })) {
            const backup = directory + '.damaged-' + randomUUID();
            fs.renameSync(directory, backup);
            damaged = backup;
          }
          fs.renameSync(payload, directory);
          replaced = true;
        }
        writeJsonAtomic(path.join(root, 'active.json'), record);
        writeJsonAtomic(path.join(root, expected[1] + '.json'), record);
      } catch (error) {
        if (replaced) fs.rmSync(directory, { recursive: true, force: true });
        if (damaged) fs.renameSync(damaged, directory);
        throw error;
      }
      if (damaged) fs.rmSync(damaged, { recursive: true, force: true });
      try { writeJsonAtomic(downloadRecord(userDataDir), { filename: resolved.filename, totalBytes }); } catch {}
      return current(userDataDir, expected[1]);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  throw new Error('Valve archives did not contain the Windows Steam client DLLs.');
}
return { current, status, records, catalog, discover, zipNames, lastDownload, install, remove, resolveManifest, MANIFEST, ORIGIN };
})();
module.exports = { apply, windowsPath, windowsArguments, createBackend, bridgeParts, buildRecord, listBuilds, projectParts, clientComponents };
