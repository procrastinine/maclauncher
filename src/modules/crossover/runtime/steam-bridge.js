const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Bundled = require('../../shared/runtime/bundled-native');
const { wineLayout } = require('../../shared/runtime/wine-layout');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const { compareRuntimeVersions } = require('../../shared/runtime/pinned-native-manager');
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');
const Clients = require('../../shared/reshade/steam-client-models');
const Steam = require('../../shared/runtime/steamworks/installed-client');
const ClientStart = require('../../shared/runtime/steamworks/client-start');
const { readGameAppId } = require('../../shared/runtime/steamworks/app-id');
const Components = require('./steam-client-components');
const id = 'maclauncher-steam-bridge';
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
  const base = createProjectBuildManager({ projectId: id, label: 'Steam client bridge', repository: 'procrastinine/maclauncher-builds', upstreamUrl: 'https://github.com/ValveSoftware/Proton', upstreamLabel: 'Proton lsteamclient',
    manifestRelative: 'manifest.json', executableRelative: 'steam.exe', dataOnly: true, supportsDefault: false,
    validateManifest(manifest) {
      if (manifest.managerId !== id || !manifest.steamBridge?.native || !manifest.steamBridge?.windows || !manifest.steamBridge?.clientEnvironment)
        throw new Error('The Steam bridge package lacks the managed loader paths required by this launcher and needs replacement.');
    }, async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); }, dependencies });
  // The Wine runtimes share one managed row under Compatibility, after their
  // own tabs. Play uses only managed versions, so the row offers no custom
  // registration.
  const manager = { ...base, ui: { groupId: 'steam-bridge', tabLabel: 'Steam client bridge', sectionLabel: 'Steam client bridge',
    management: 'managed', order: 203, category: 'compatibility' }, distributionRequired: false, customRuntime: false };
  delete manager.registerCustomRuntime;
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
    // The Valve files take only the install context. A local archive in
    // `options` is the bridge package's own archive.
    await Components.install({ userDataDir: options.userDataDir, signal: options.signal, onProgress: options.onProgress });
    clearSkipped(options.userDataDir);
    return result;
  };
  const uninstallRuntime = manager.uninstallRuntime;
  manager.uninstallRuntime = async function(options = {}) {
    const result = await uninstallRuntime.call(this, options);
    if (options.userDataDir && !base.core.listInstalled(options.userDataDir).length) await Components.remove(options.userDataDir);
    return result;
  };
  // The Valve files are listed in the bridge's Runtimes section with the
  // generic section components; status reads no file contents.
  const getState = manager.getState;
  manager.getState = function(options = {}) {
    const state = getState.call(this, options), files = Components.status(options.userDataDir);
    const extra = { description: 'Connects Windows Steam games in CrossOver, Sikarugir and WineCX to the Steam client for Mac. Play offers it for a Windows Steam game while the Steam client for Mac is installed.',
      components: [{ id: 'steam-client-components', label: 'Windows Steam client files', ...(files ? { version: files.archiveSha1.slice(0, 12) } : {}),
        status: files ? 'Installed' : 'Not installed', available: Boolean(files),
        description: "steamclient.dll and steamclient64.dll from Valve's current Steam client download, checked against its content address. They are installed with the bridge and removed with its last version." }] };
    return { ...state, ...extra, sections: (state.sections || []).map(section => ({ ...section, ...extra, customRuntime: false })) };
  };
  // One inspector line for a game whose last Play used the bridge, while that
  // version remains installed.
  function inspectorDetail(record, userDataDir) {
    const version = record?.steamBridge?.version;
    if (typeof version !== 'string' || !version || !userDataDir || !base.core.listInstalled(userDataDir).some(row => row.version === version)) return null;
    return { label: 'Steam', value: `Steam client bridge ${version}` };
  }
  function installed(userDataDir) {
    for (const row of [...base.core.listInstalled(userDataDir)].sort((a, b) => compareRuntimeVersions(a.version, b.version))) {
      const selected = base.resolveSelection(null, {}, userDataDir, { version: row.version, verification: 'status' });
      if (selected.ready) return selected.install;
    }
    return null;
  }
  async function requirements(entry, context) {
    const game = identifyGame(entry);
    if (!game || !discoverClient() || skipped(context.userDataDir).includes(String(game.appId)) || installed(context.userDataDir) && Components.current(context.userDataDir)) return [];
    const local = installed(context.userDataDir);
    const unusable = base.getState({ userDataDir: context.userDataDir }).installed.filter(row => row.ready === false);
    const pin = base.core.listDiscoveredCatalog({ userDataDir: context.userDataDir }).filter(pin => !pin.installReason && !unusable.some(row => row.version === pin.version))
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0];
    // One question per game: Play with Steam downloads what is missing and
    // starts Steam for that Play. Sizes appear when the catalog or an earlier
    // Valve download recorded them.
    const name = entry?.name || 'this game', size = bytes => bytes > 0 ? ` (${Math.max(0.1, bytes / 1048576).toFixed(1)} MB)` : '';
    const bytes = !local && pin?.asset?.bytes > 0 ? pin.asset.bytes : 0;
    const previous = Components.lastDownload(context.userDataDir);
    const valve = `the Windows Steam client files from Valve${previous ? ` (about ${Math.max(0.1, previous.bytes / 1048576).toFixed(1)} MB)` : ''}`;
    const version = local?.version || pin?.version || null;
    const downloads = label => local ? valve : `${label}${size(bytes)} and ${valve}`;
    const starts = isRunning() === false && ClientStart.clientStartEnabled(entry, context.settings) ? ', then starts Steam' : '';
    const until = 'until the bridge is installed in Runtimes.';
    const replacement = !local && unusable.length ? ` Installed bridge ${unusable[0].version} cannot be used: ${unusable[0].error}` : '';
    return [{ managerId: id, version, requiresDownload: true, ...(!pin && !local ? { discoveryRequired: true } : {}), appId: String(game.appId),
      optional: true, companion: true, label: manager.label, ...(bytes ? { bytes } : {}), grants: ['steam-client-start'],
      message: 'Play with Steam?', confirmLabel: 'Play with Steam', cancelLabel: 'Play Without Steam', companionCheckbox: 'Also connect to Steam',
      detail: `Connects ${name} to the Steam client for Mac. Downloads ${downloads('the Steam client bridge')}${starts}.${replacement}\n\nWithout Steam, ${name} runs without the Steam client ${until}`,
      companionDetail: `Connecting to Steam also downloads ${downloads(`the Steam client bridge${version ? ` ${version}` : ''}`)}${starts}.${replacement} Without it, ${name} runs without Steam ${until}` }];
  }
  async function prepare(entry, context, { installation, prefixPath, architecture, environment } = {}) {
    const game = identifyGame(entry), native = discoverClient();
    if (!game || !native || skipped(context.userDataDir).includes(String(game.appId))) return null;
    const current = installed(context.userDataDir), components = Components.current(context.userDataDir);
    if (!current || !components) return null;
    try {
      await context.useSteamClient?.(true); // Canonical startup consent and local IPC policy.
      if (isRunning() !== true) return null;
      const layout = wineLayout(installation), nativeArch = layout.architecture === 'arm64' ? 'aarch64' : layout.architecture;
      const descriptor = current.manifest.steamBridge, pe = architecture === 'x86' || architecture === 'i386' ? 'i386' : 'x86_64';
      if (!descriptor.native[nativeArch] || !descriptor.windows[pe]) return null;
      await context.useRuntime?.({ managerId: id, version: current.version, sourcePath: current.installDir });
      Bundled.verifyPayload(current.root, current.declaration, current.resolveDependency);
      const source = relative => {
        Bundled.relativeFile(relative);
        const file = path.resolve(current.root, relative);
        if (!inside(fs.realpathSync(current.root), fs.realpathSync(file))) throw new Error('Steam bridge file escaped its managed package.');
        return file;
      };
      // Wine's extended Unix device paths work without a Z: mapping and leave
      // managed files outside the selected bottle, including shared bottles.
      const windowsPath = file => '\\\\?\\unix' + file.split(path.sep).join('\\');
      const helper = windowsPath(source(descriptor.windows[pe].helper));
      const extra = { WINEDLLPATH: [...new Set([current.root, ...String(environment.WINEDLLPATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter),
        WINEDLLOVERRIDES: [environment.WINEDLLOVERRIDES, 'lsteamclient=b'].filter(Boolean).join(';'),
        SteamAppId: String(game.appId), SteamGameId: String(game.appId), STEAM_COMPAT_CLIENT_INSTALL_PATH: native,
        MACLAUNCHER_STEAM_BOOTSTRAP: windowsPath(source(descriptor.windows[pe].bootstrap)),
        MACLAUNCHER_STEAM_BUILTIN: windowsPath(source(descriptor.windows[pe].builtin)),
        ...Object.fromEntries(Object.entries(descriptor.clientEnvironment).filter(([abi]) => components.clients[abi]).map(([abi, name]) =>
          [name, windowsPath(path.join(components.root, components.clients[abi]))])), HOME: os.homedir(), CFFIXED_USER_HOME: os.homedir() };
      const prepared = { ...environment, ...extra, WINEPREFIX: prefixPath };
      delete prepared.STEAM_DYLD_INSERT_LIBRARIES; delete prepared.NOTPROTON_OVERLAY_SHIM;
      return { environment: prepared, extra, helper, appId: String(game.appId), packageVersion: current.version };
    } catch (error) { if (context.signal?.aborted) throw error; return null; }
  }
  return Object.assign(manager, { requirements, prepare, skipOptional, clearSkipped, inspectorDetail });
}
module.exports = Object.assign(create(), { create, identify, clientRoot });
