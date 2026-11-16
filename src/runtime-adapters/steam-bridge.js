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
  return createProjectBuildManager({ projectId: source.manager.id, label: source.label, repository,
    upstreamUrl: source.credits.url, upstreamLabel: source.labels.source,
    manifestRelative: 'manifest.json', executableRelative: source.layout.entry, dataOnly: true, supportsDefault: false,
    validateManifest(manifest) {
      if (manifest.managerId !== source.manager.id || !manifest.steamBridge?.native || !manifest.steamBridge?.windows || !manifest.steamBridge?.clientEnvironment)
        throw new Error('The Steam bridge package lacks the managed loader paths required by this launcher and needs replacement.');
    },
    async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); }, dependencies });
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
const source = Upstream.service({ hosts: [new URL(ORIGIN).hostname] });
const verified = new Map();
const store = userDataDir => path.join(userDataDir, 'runtimes/steam-client-components');
// The total behind the last verified download. Play's consent shows its size
// offline; the record stays when the files are removed.
const downloadRecord = userDataDir => path.join(userDataDir, 'runtimes/steam-client-download.json');
function lastDownload(userDataDir) {
  const record = readJsonObject(downloadRecord(userDataDir));
  return typeof record?.filename === 'string' && Number.isSafeInteger(record.totalBytes) && record.totalBytes > 0 ? { filename: record.filename, bytes: record.totalBytes } : null;
}
function resolveManifest(text) {
  const value = parseSteamVdf(text), pending = [value], matches = [];
  while (pending.length) for (const [key, row] of Object.entries(pending.shift())) {
    if (!row || typeof row !== 'object') continue;
    const filename = row.file;
    if (typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip\.[a-f0-9]{40}$/.test(filename)) {
      const bytes = Number(row.size); matches.push({ filename, url: ORIGIN + '/' + filename, sha1: filename.slice(-40), ...(Number.isSafeInteger(bytes) && bytes > 0 ? { bytes } : {}) });
    } else pending.push(row);
  }
  if (!matches.length) throw new Error('Valve did not list content-addressed client archives.');
  return matches;
}
function current(userDataDir) {
  const root = store(userDataDir), record = readJsonObject(path.join(root, 'active.json'));
  if (!record || !/^[a-f0-9]{40}$/.test(record.archiveSha1 || '') || !record.files || !record.clients) return null;
  const directory = path.join(root, record.archiveSha1);
  try {
    for (const item of record.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(item.path)) return null;
      const file = path.join(directory, item.path), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const stamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, item.sha256]);
      if (verified.get(file) !== stamp) {
        if (hashFile(file) !== item.sha256) { verified.delete(file); return null; }
        verified.set(file, stamp);
      }
    }
    for (const name of Object.values(record.clients)) if (!record.files.some(item => item.path === name)) return null;
    return { ...record, root: directory };
  } catch { return null; }
}
// Runtimes status reads the active record and file sizes without hashing.
function status(userDataDir) {
  try {
    const record = readJsonObject(path.join(store(userDataDir), 'active.json'));
    if (!record || !/^[a-f0-9]{40}$/.test(record.archiveSha1 || '') || !Array.isArray(record.files) || !record.files.length) return null;
    const directory = path.join(store(userDataDir), record.archiveSha1);
    for (const item of record.files) {
      if (!/^[A-Za-z0-9._-]+$/.test(item?.path || '') || fs.lstatSync(path.join(directory, item.path), { throwIfNoEntry: false })?.size !== item.size) return null;
    }
    return { archiveSha1: record.archiveSha1, source: record.source, bytes: record.files.reduce((sum, item) => sum + item.size, 0) };
  } catch { return null; }
}
// Removing the bridge's last version also removes these files; Play can
// download them again after consent.
async function remove(userDataDir) {
  const root = store(userDataDir);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) return false;
  Writable.assertOwnDirectory(userDataDir, root, { create: false });
  return require('../modules/shared/runtime/runtime-components').removeOwned(root, userDataDir);
}
// Called only from the consented managed-install action. Discovery/status use current().
async function install({ userDataDir, signal, onProgress, resolved } = {}) {
  const existing = current(userDataDir); if (existing) return existing;
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
      totalBytes += fs.statSync(archive).size;
      const listing = await execute('/usr/bin/unzip', ['-Z1', archive], { signal, timeout: 120000 });
      const members = listing.stdout.trim().split('\n');
      const selected = ['steamclient64.dll', 'steamclient.dll'].map(name => members.filter(member => path.posix.basename(member).toLowerCase() === name));
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
        writeJsonAtomic(path.join(root, 'active.json'), { archiveSha1: expected[1], source: resolved.url, clients, files });
      } catch (error) {
        if (replaced) fs.rmSync(directory, { recursive: true, force: true });
        if (damaged) fs.renameSync(damaged, directory);
        throw error;
      }
      if (damaged) fs.rmSync(damaged, { recursive: true, force: true });
      try { writeJsonAtomic(downloadRecord(userDataDir), { filename: resolved.filename, totalBytes }); } catch {}
      return current(userDataDir);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  throw new Error('Valve archives did not contain the Windows Steam client DLLs.');
}
return { current, status, lastDownload, install, remove, resolveManifest, MANIFEST };

})();
module.exports = { apply, windowsPath, windowsArguments, createBackend, bridgeParts, buildRecord, listBuilds, projectParts, clientComponents };
