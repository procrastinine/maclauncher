const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Bundled = require('../../shared/runtime/bundled-native');
const { wineLayout } = require('../../shared/runtime/wine-layout');
const { createSourceBackedManager } = require('../../../runtime-sources/manager');
const source = Object.assign({},require('../../../runtime-sources/steam-bridge/maclauncher-steam-bridge.json'),{"manager":{"id":"maclauncher-steam-bridge","sectionLabel":"Steam client bridge","tabLabel":"Steam client bridge","category":"compatibility"},"layout":{"type":"archive","entry":"steam.exe"},"labels":{"source":"Proton lsteamclient"},"credits":{"url":"https://github.com/ValveSoftware/Proton"},"discover":{"type":"builds-catalog","catalog":"https://raw.githubusercontent.com/procrastinine/maclauncher-builds/main/catalogs/maclauncher-steam-bridge.json"}});
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');
const Clients = require('../../shared/reshade/steam-client-models');
const Steam = require('../../shared/runtime/steamworks/installed-client');
const ClientStart = require('../../shared/runtime/steamworks/client-start');
const { readGameAppId } = require('../../shared/runtime/steamworks/app-id');
const ClientFiles = require('./steam-client-files');
const Adapter = require('../../../runtime-adapters/steam-bridge');
const { selectLogicalLibraries } = require('../../../core/logical-libraries');
const { peArchitecture } = require('../../../core/binary-arch');
const { requiredMachine } = require('../../shared/runtime/binary-compatibility');
const id = source.manager.id;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function identify(entry) {
  for (const candidate of [entry?.gamePath, entry?.importPath, entry?.contentRootDir]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    let directory; try { directory = fs.realpathSync(candidate); if (!fs.statSync(directory).isDirectory()) directory = path.dirname(directory); } catch { continue; }
    const gameRoot = directory;
    const installed = Steam.findInstalledApp(directory);
    if (installed && ClientStart.findSteamApiPlatforms(installed.installRoot).has('windows')) return installed;
    for (let depth = 0; depth < 16; ++depth) {
      const metadata = readJsonObject(path.join(directory, '.maclauncher-steam.json'));
      if (metadata?.complete === true && metadata.platform === 'windows' && /^[1-9]\d{0,9}$/.test(String(metadata.appId)) &&
          typeof metadata.path === 'string' && path.isAbsolute(metadata.path)) {
        try {
          if (fs.realpathSync(metadata.path) === directory && ClientStart.findSteamApiPlatforms(directory).has('windows'))
            return { appId: String(metadata.appId), installRoot: directory, manifestPath: path.join(directory, '.maclauncher-steam.json') };
        } catch { /* A removed download is not a ready Steam installation. */ }
      }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    if (ClientStart.findSteamApiPlatforms(gameRoot).has('windows')) {
      try {
        const identity = readGameAppId({ gameRoot });
        const source = identity.evidence.find(row => row.kind === 'steam-appid-file');
        if (identity.status === 'found' && !identity.errors.length && source)
          return { appId: String(identity.value), installRoot: gameRoot, appIdPath: source.filePath };
      } catch { /* Invalid or changing portable metadata supplies no identity. */ }
    }
  }
  return null;
}
function clientRoot(home = os.homedir()) {
  const client = Clients.findClient({ home });
  if (!client) return null;
  for (const root of [path.dirname(client), ...Clients.clientRoots(home)]) {
    try { const file = fs.realpathSync(path.join(root, 'steamclient.dylib')); if (fs.statSync(file).isFile()) return path.dirname(file); } catch {}
  }
  return null;
}
function create({ dependencies = {}, identifyGame = identify, discoverClient = clientRoot, isRunning = ClientStart.clientRunning } = {}) {
  const base = createSourceBackedManager({ id, source, adapter: Adapter, dependencies });
  // One backend retains every installed version and its existing state.
  const manager = Object.assign(Object.create(base), { ui: { ...base.ui, groupId: source.kind, tabLabel: source.manager.tabLabel,
    sectionLabel: source.manager.sectionLabel, management: 'managed', order: source.order, category: source.manager.category },
    distributionRequired: false });
  const skippedPath = directory => path.join(directory, 'runtimes/steam-bridge-skipped.json');
  const skipped = directory => readJsonObject(skippedPath(directory))?.apps || [];
  function skipOptional(plan, { userDataDir } = {}) {
    if (userDataDir && plan?.appId) writeJsonAtomic(skippedPath(userDataDir), { apps: [...new Set([...skipped(userDataDir), String(plan.appId)])] });
  }
  function clearSkipped(userDataDir) {
    if (userDataDir) writeJsonAtomic(skippedPath(userDataDir), { apps: [] });
  }
  // Only an installation, from Runtimes or Play, makes every Windows Steam game
  // eligible again, including games for which Play Without Steam was chosen.
  // A Refresh keeps those choices.
  const installRuntime = manager.installRuntime;
  manager.installRuntime = async function(options = {}) {
    const result = await installRuntime.call(this, options);
    const selected = base.resolveSelection(null, {}, options.userDataDir, { version: result.version, verification: 'status' });
    if (!selected.ready) throw new Error(selected.reason);
    // Valve's client files come with the bridge when none are usable. They
    // take only the install context; a local archive in `options` is the
    // bridge package's own archive.
    await ClientFiles.ensure({ userDataDir: options.userDataDir, settings: options.settings, signal: options.signal, onProgress: options.onProgress,
      entry: options.entry, logger: options.logger, recordRuntimeUse: options.recordRuntimeUse });
    clearSkipped(options.userDataDir);
    return result;
  };
  // Removing the bridge's last version also removes the client files it
  // brought in; versions the user installed or chose stay.
  const uninstallRuntime = manager.uninstallRuntime;
  manager.uninstallRuntime = async function(options = {}) {
    const result = await uninstallRuntime.call(this, options);
    if (options.userDataDir && !base.core.listInstalled(options.userDataDir).length) await ClientFiles.removeAutomatic(options);
    return result;
  };
  const getState = manager.getState;
  manager.getState = function(options = {}) {
    const state = getState.call(this, options);
    const extra = { description: "Connects Windows Steam games in CrossOver, Sikarugir and WineCX to the Steam client for Mac with Valve's Windows Steam client files, listed beside it. Play offers it for a Windows Steam game while the Steam client for Mac is installed." };
    return { ...state, ...extra, sections: (state.sections || []).map(section => ({ ...section, ...extra })) };
  };
  // One inspector line for a game whose last Play used the bridge, while that
  // version remains installed.
  function inspectorDetail(record, userDataDir) {
    const version = record?.steamBridge?.version;
    if (typeof version !== 'string' || !version || !userDataDir || !base.core.listInstalled(userDataDir).some(row => row.version === version)) return null;
    return { label: 'Steam', value: `Steam client bridge ${version}` };
  }
  // The bridge and client files a Play uses: each one's game choice, saved
  // default or registered folder, then its installed version.
  function installed(context) {
    const selected = manager.resolveSelection(null, context.settings || {}, context.userDataDir, { verification: 'status' });
    return selected.ready ? selected.install : null;
  }
  function clientFiles(context, verification = 'status') {
    const selected = ClientFiles.resolveSelection(null, context.settings || {}, context.userDataDir, { verification });
    return selected.ready ? selected.install : null;
  }

  async function requirements(entry, context) {
    const game = identifyGame(entry);
    if (!game || !discoverClient() || skipped(context.userDataDir).includes(String(game.appId))) return [];
    const local = installed(context), files = clientFiles(context, 'full');
    if (local && files) return [];
    const unusable = base.getState({ userDataDir: context.userDataDir }).installed.filter(row => row.ready === false);
    const selected = base.resolveSelection(null, {}, context.userDataDir, { verification: 'status',
      compatible: pin => !unusable.some(row => row.version === pin.version) });
    const pin = base.core.listDiscoveredCatalog({ userDataDir: context.userDataDir }).find(pin => pin.version === selected.version);
    // One question per game: Play with Steam downloads what is missing and
    // starts Steam for that Play. Sizes appear when the catalog or an earlier
    // Valve download recorded them.
    const name = entry?.name || 'this game', size = bytes => bytes > 0 ? ` (${Math.max(0.1, bytes / 1048576).toFixed(1)} MB)` : '';
    const bytes = !local && pin?.asset?.bytes > 0 ? pin.asset.bytes : 0;
    const previous = ClientFiles.components.lastDownload(context.userDataDir);
    const valve = `the Windows Steam client files from Valve${previous ? ` (about ${Math.max(0.1, previous.bytes / 1048576).toFixed(1)} MB)` : ''}`;
    const version = local?.version || pin?.version || null;
    const downloads = label => [local ? null : `${label}${size(bytes)}`, files ? null : valve].filter(Boolean).join(' and ');
    const starts = isRunning() === false && ClientStart.clientStartEnabled(entry, context.settings) ? ', then starts Steam' : '';
    const until = 'until the bridge is installed in Runtimes.';
    const replacement = !local && unusable.length ? ` Installed bridge ${unusable[0].version} cannot be used: ${unusable[0].error}` : '';
    return [{ managerId: id, version, requiresDownload: true, ...(!pin && !local ? { discoveryRequired: true } : {}), appId: String(game.appId),
      optional: true, companion: true, label: manager.label, ...(bytes ? { bytes } : {}), grants: ['steam-client-start'],
      message: 'Play with Steam?', confirmLabel: 'Play with Steam', cancelLabel: 'Play Without Steam', companionCheckbox: 'Also connect to Steam',
      detail: `Connects ${name} to the Steam client for Mac. Downloads ${downloads('the Steam client bridge')}${starts}.${replacement}\n\nWithout Steam, ${name} runs without the Steam client ${until}` }];
  }
  async function prepare(entry, context, { installation, prefixPath, architecture, environment, integration = 'native' } = {}) {
    const game = identifyGame(entry), native = discoverClient();
    if (!game || !native || skipped(context.userDataDir).includes(String(game.appId))) return null;
    const current = installed(context), components = clientFiles(context, 'full');
    if (!current || !components) return null;
    try {
      await context.useSteamClient?.(true); // Canonical startup consent and local IPC policy.
      if (isRunning() !== true) return null;
      const layout = wineLayout(installation);
      const build = Adapter.buildRecord({ source, install: current, measure: dependencies.measureBuild });
      const admitted = selectLogicalLibraries({ build, hostArch: layout.architecture,
        guestArch: peArchitecture(requiredMachine(architecture)), integration,
        libraries: ['lsteamclient.dll', 'mlsteam-bootstrap.dll', 'steam.exe'] });
      if (!admitted.accepted) return null;
      await context.useRuntime?.({ managerId: id, version: current.version, sourcePath: current.installDir });
      await context.useRuntime?.({ managerId: ClientFiles.id, version: components.version || components.archiveSha1, sourcePath: components.installDir || components.root });
      Bundled.verifyPayload(current.root, current.declaration, current.resolveDependency);
      const packageFile = relative => {
        Bundled.relativeFile(relative);
        const file = path.resolve(current.root, relative);
        if (!inside(fs.realpathSync(current.root), fs.realpathSync(file))) throw new Error('Steam bridge file escaped its managed package.');
        return file;
      };
      const descriptor = current.manifest.steamBridge;
      const clients = Object.fromEntries(Object.entries(descriptor.clientEnvironment).filter(([abi]) => components.clients[abi]).map(([abi, name]) =>
        [name, path.join(components.root, components.clients[abi])]));
      const parts = Adapter.projectParts({ build, binaries: admitted.binaries, clients });
      for (const name of ['native', 'builtin', 'bootstrap', 'helper']) parts[name] = packageFile(path.relative(current.root, parts[name]));
      return Adapter.apply({ build: { root: current.root, version: current.version }, parts, environment,
        parameters: { appId: game.appId, clientRoot: native, home: os.homedir(), prefixPath } });
    } catch (error) { if (context.signal?.aborted) throw error; return null; }
  }
  return Object.assign(manager, { requirements, prepare, skipOptional, clearSkipped, inspectorDetail });
}
module.exports = Object.assign(create(), { create, identify, clientRoot });
