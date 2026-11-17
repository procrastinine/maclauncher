// Valve's Windows Steam client files (steamclient.dll and steamclient64.dll),
// which the Steam client bridge passes to a Windows game. They are a managed
// runtime of their own: Refresh reads Valve's current client listing, and
// every installed version, the default and a folder the user selects are
// kept and chosen like any other runtime. Valve's files are never changed.
const fs = require('node:fs'), path = require('node:path');
const Components = require('./steam-client-components');
const Custom = require('../../shared/runtime/custom-runtime');
const { readPeExports } = require('../../shared/runtime/pe-exports');
const { readPeVersion } = require('../../shared/runtime/pe-version');
const { selectRuntimeVersion, managerDefaultVersion, savedDefaultVersion } = require('../../shared/runtime/version-choices');
const id = 'steam-client-components', label = 'Windows Steam client files';
// The client of each Windows CPU the bridge package's clientEnvironment names.
const CLIENTS = { x86_64: { name: 'steamclient64.dll', machine: 0x8664 }, i386: { name: 'steamclient.dll', machine: 0x14c } };
const SHA1 = /^[a-f0-9]{40}$/;
const versionLabel = row => row?.manifestVersion ? `Steam client ${row.manifestVersion}` : row?.build ? `Steam client ${row.build}`
  : `Steam client ${String(row?.archiveSha1 || row?.version || '').slice(0, 12)}`;
// Records written by earlier launchers, and folders a user registers, name no
// Valve manifest version. Valve's client DLL carries its build as the highest
// file version among its version resources, beside a fixed 3.0.0.1 one. It is
// read once per file size and modification time.
const builds = new Map();
function clientBuild(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (!builds.has(key)) {
    if (builds.size >= 32) builds.clear();
    const parts = value => value.split('.').map(Number);
    const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };
    const versions = (readPeVersion(file, { all: true }) || []).map(row => row.fileVersion).filter(value => /^\d{1,5}(?:\.\d{1,5}){3}$/.test(value || ''));
    builds.set(key, versions.length ? versions.reduce(newer) : null);
  }
  return builds.get(key);
}
function normalizeSettings(value) { return { defaultVersion: SHA1.test(value?.defaultVersion || '') || Custom.isPath(value?.defaultVersion) ? value.defaultVersion : null }; }
const configured = settings => normalizeSettings(settings?.runtimes ? settings.runtimes[id] : settings);
// Installed versions, newest installation first. Status reads sizes only.
function installed(userDataDir) {
  if (!userDataDir) return [];
  return Components.records(userDataDir).map(record => {
    const files = Components.status(userDataDir, record.archiveSha1), installDir = path.join(userDataDir, 'runtimes/steam-client-components', record.archiveSha1);
    const build = files && !record.manifestVersion ? clientBuild(path.join(installDir, record.clients?.x86_64 || CLIENTS.x86_64.name)) : null;
    return { version: record.archiveSha1, versionLabel: versionLabel({ ...record, build }), installDir,
      ready: Boolean(files), status: files ? 'ready' : 'damaged', ...(files ? { bytes: files.bytes } : { error: 'The Valve client files changed. Install this version again.' }),
      installedAt: record.installedAt || null, removalLabel: 'Remove' };
  }).sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')));
}
function choose(entry, settings, userDataDir, version) {
  const ready = installed(userDataDir).filter(row => row.ready).map(row => row.version), listed = Components.catalog(userDataDir).map(row => row.version);
  const manual = selectRuntimeVersion({ manual: version ?? entry?.runtimeData?.[id]?.version }).version;
  const saved = savedDefaultVersion(configured(settings).defaultVersion, { listed, installed: ready });
  return { ...selectRuntimeVersion({ manual, defaultVersion: saved, fallback: managerDefaultVersion({ installed: ready, listed }) }), automatic: !manual && !saved };
}
// The client files a game uses: its own choice, the saved default, then an
// installed version, then the version Valve lists.
function verifiedFiles(userDataDir, version, verification) {
  if (!SHA1.test(version || '')) return null;
  if (verification !== 'status') return Components.current(userDataDir, version);
  const record = Components.status(userDataDir, version) && Components.records(userDataDir).find(row => row.archiveSha1 === version);
  return record ? { ...record, root: path.join(userDataDir, 'runtimes/steam-client-components', version) } : null;
}
function resolveSelection(entry, settings, userDataDir, { version, verification = 'full' } = {}) {
  const chosen = choose(entry, settings, userDataDir, version), files = verifiedFiles(userDataDir, chosen.version, verification);
  return { version: chosen.version, ready: Boolean(files), automatic: chosen.automatic, sectionId: 'default',
    install: files ? { ...files, version: chosen.version, executablePath: path.join(files.root, files.clients.x86_64) } : null,
    ...(chosen.version ? {} : { discoveryRequired: true }), reason: files ? null : 'The Windows Steam client files are not installed.' };
}
function getState({ userDataDir, settings } = {}) {
  const rows = installed(userDataDir), listed = userDataDir ? Components.catalog(userDataDir) : [];
  const versions = [...new Set([...listed.map(row => row.version), ...rows.map(row => row.version)])];
  const saved = configured(settings).defaultVersion, chosen = choose(null, settings, userDataDir);
  const labels = Object.fromEntries([...listed, ...rows].map(row => [row.version, row.versionLabel || versionLabel(row)]));
  const catalog = { status: listed.length ? 'success' : 'idle', delivery: 'download', label: 'Versions', sourceLabel: 'Valve CDN', description: 'Current Windows Steam client files; installed copies remain available locally.', preferInstalled: true, versions, versionLabels: labels,
    installable: listed.length > 0, installableVersions: listed.map(row => row.version), includedVersions: [], buildableVersions: [],
    versionRequirements: Object.fromEntries(versions.map(version => {
      const row = rows.find(item => item.version === version), offer = listed.find(item => item.version === version);
      return [version, { requiresDownload: !row?.ready, requiresBuild: false, available: Boolean(row?.ready), included: false,
        ...(offer?.bytes ? { downloadBytes: offer.bytes } : {}), architecture: 'universal' }];
    })),
    importable: false, sourceUrl: Components.MANIFEST, source: Components.MANIFEST, refreshLabel: 'Refresh Valve versions', supportsLatestOnly: false,
    fetchedAt: listed[0]?.fetchedAt || null, error: null, latestInstalledVersion: rows.find(row => row.ready)?.version || null,
    latestAvailableVersion: listed[0]?.version || null, updateAvailable: false };
  const section = { id: 'default', label, managementTitle: label, supportsDefault: true, defaultVersion: saved || chosen.version || null,
    defaultSource: saved ? 'saved' : 'manager', installed: rows, variants: [], installing: null, catalog,
    sourceLinks: [{ label: 'Valve Steam client', url: 'https://store.steampowered.com/about/' }],
    description: "steamclient.dll and steamclient64.dll from Valve's Steam client download, checked against its content address. The Steam client bridge passes them to Windows Steam games. Valve lists only its current client; earlier versions stay listed while they are installed." };
  return { ...section, id, sections: [section] };
}
async function installRuntime(context = {}) {
  const { userDataDir, signal, onProgress } = context;
  const installedBefore = installed(userDataDir).map(row => row.version);
  let version = context.version && context.version !== 'auto' ? context.version : choose(null, context.settings, userDataDir).version;
  if (version && !Components.current(userDataDir, version) && !Components.catalog(userDataDir).some(row => row.version === version)) {
    await Components.discover({ userDataDir, signal });
    if (!Components.catalog(userDataDir).some(row => row.version === version)) throw new Error('Valve no longer lists this client version.');
  }
  const files = await Components.install({ userDataDir, signal, onProgress, ...(version ? { version } : {}) });
  if (!files) throw new Error('The Windows Steam client files could not be verified.');
  const result = { ...files, version: files.archiveSha1, versionLabel: versionLabel(files) };
  // A copy Play acquires without a saved or chosen version is automatic, so a
  // later automatic copy supersedes it.
  if (context.automatic === true) require('../../../core/runtime-install-origins').recordPlayInstall({ userDataDir, manager: module.exports,
    plan: { automatic: true, version, installOptions: { sectionId: 'default' } }, result, entry: context.entry, settings: context.settings, installedBefore, logger: context.logger });
  return result;
}
// The client files Play installs with the bridge when none are usable, checked
// in full. A game's use of the selected version is recorded.
async function ensure(context = {}) {
  const { userDataDir, settings } = context;
  const selected = module.exports.resolveSelection(context.entry || null, settings, userDataDir, { verification: 'full' });
  const files = selected.ready ? selected.install : await module.exports.installRuntime({ ...context,
    version: selected.version || undefined, automatic: selected.automatic === true });
  context.recordRuntimeUse?.({ managerId: id, version: files.version || files.archiveSha1 || selected.version,
    sectionId: 'default', sourcePath: files.installDir || files.root });
  return files;
}
// Removes the client files the bridge brought in: Play's automatic copies and
// copies earlier launchers installed with the bridge (their records have no
// installation time). Versions the user installed, chose or set as the
// default stay. Without any left, the whole store goes.
async function removeAutomatic({ userDataDir, settings } = {}) {
  const Origins = require('../../../core/runtime-install-origins'), saved = configured(settings).defaultVersion;
  const automatic = new Set(Origins.read(userDataDir).filter(row => row.managerId === id).map(row => String(row.version)));
  const records = Components.records(userDataDir), removed = records.filter(row => row.archiveSha1 !== saved && (automatic.has(row.archiveSha1) || !row.installedAt));
  if (!removed.length) return false;
  try {
    if (removed.length === records.length) return await Components.remove(userDataDir);
    for (const row of removed) await Components.remove(userDataDir, row.archiveSha1);
    return true;
  } finally { for (const row of removed) Origins.clearRecord(userDataDir, { managerId: id, version: row.archiveSha1 }); }
}
// A folder the user selects holds both clients, each a PE image of its CPU.
function inspectCustom(runtimePath) {
  const root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  const names = fs.readdirSync(root), clients = {}, files = [];
  for (const [abi, { name, machine }] of Object.entries(CLIENTS)) {
    const found = names.find(item => item.toLowerCase() === name);
    if (!found) throw new Error(`Select a folder with both Windows Steam clients; ${name} is missing.`);
    const file = path.join(root, found), stat = fs.lstatSync(file);
    if (!stat.isFile() || readPeExports(file, { headersOnly: true })?.machine !== machine)
      throw new Error(`${found} is not the ${abi === 'i386' ? '32-bit' : '64-bit'} Windows Steam client.`);
    clients[abi] = found; files.push({ path: found, size: stat.size });
  }
  const build = clientBuild(path.join(root, clients.x86_64));
  return { root, installDir: root, clients, files, executablePath: path.join(root, clients.x86_64), architectures: ['x86_64', 'i386'], ready: true,
    ...(build ? { versionLabel: versionLabel({ build }) } : {}) };
}
module.exports = { id, label, distributionRequired: false, delivery: { included: 'none', catalog: 'remote', sourceBuild: false },
  ui: { cpuBuildLabels: false, groupId: 'steam-bridge', tabLabel: 'Steam client bridge', sectionLabel: label, management: 'managed', order: 204, memberOrder: 1, category: 'compatibility' },
  normalizeSettings, getState, resolveSelection, installRuntime, ensure, removeAutomatic,
  uninstallRuntime: ({ userDataDir, version } = {}) => Components.remove(userDataDir, version).then(() => true),
  refreshCatalog: async context => { await Components.discover({ userDataDir: context.userDataDir, signal: context.signal }); return getState(context).catalog; },
  applySettingsUpdate: (action, payload, settings) => action === 'setDefault' ? normalizeSettings({ ...settings, defaultVersion: payload.version }) : normalizeSettings(settings),
  updateSettingsAfterUninstall: (settings, payload) => normalizeSettings(settings).defaultVersion === payload.version ? { ...settings, defaultVersion: null } : settings,
  components: Components };
Custom.configure(module.exports, { defaultsPath: () => ['defaultVersion'], inspect: inspectCustom });
