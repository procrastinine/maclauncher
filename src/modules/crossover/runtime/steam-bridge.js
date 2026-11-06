const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const Writable = require('../../shared/writable-input');
const Bundled = require('../../shared/runtime/bundled-native');
const { wineLayout } = require('../../shared/runtime/wine-layout');
const { createProjectBuildManager } = require('../../shared/runtime/project-build-manager');
const { compareRuntimeVersions } = require('../../shared/runtime/pinned-native-manager');
const { readJsonObject, writeJsonAtomic } = require('../../../core/json-files');
const Clients = require('../../shared/reshade/steam-client-models');
const Steam = require('../../shared/runtime/steamworks/installed-client');
const ClientStart = require('../../shared/runtime/steamworks/client-start');
const Components = require('./steam-client-components');
const id = 'maclauncher-steam-bridge';
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function identify(entry) {
  for (const candidate of [entry?.gamePath, entry?.importPath, entry?.contentRootDir]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    let directory; try { directory = fs.realpathSync(candidate); if (!fs.statSync(directory).isDirectory()) directory = path.dirname(directory); } catch { continue; }
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
  const base = createProjectBuildManager({ projectId: id, label: 'Steam client bridge', repository: 'procrastinine/maclauncher-builds',
    manifestRelative: 'manifest.json', executableRelative: 'steam.exe', dataOnly: true, supportsDefault: false,
    validateManifest(manifest) {
      if (manifest.managerId !== id || manifest.steamBridge?.abi !== 1 || manifest.steamBridge.role !== 'native-steam-client-bridge')
        throw new Error('The Steam bridge package has no compatible loader declaration.');
    }, async verifyPayload(selected) { Bundled.verifyPayload(selected.root, selected.declaration, selected.resolveDependency); }, dependencies });
  const manager = { ...base, ui: { hidden: true }, distributionRequired: false };
  const skippedPath = directory => path.join(directory, 'runtimes/steam-bridge-skipped.json');
  const skipped = directory => readJsonObject(skippedPath(directory))?.apps || [];
  function skipOptional(plan, { userDataDir } = {}) {
    if (userDataDir && plan?.appId) writeJsonAtomic(skippedPath(userDataDir), { apps: [...new Set([...skipped(userDataDir), String(plan.appId)])] });
  }
  function clearSkipped(userDataDir) {
    if (userDataDir) writeJsonAtomic(skippedPath(userDataDir), { apps: [] });
  }
  const refresh = manager.refreshCatalog;
  manager.refreshCatalog = async function (options = {}) {
    clearSkipped(options.userDataDir);
    return refresh.call(this, options);
  };
  const installRuntime = manager.installRuntime;
  manager.installRuntime = async function(options = {}) {
    const result = await installRuntime.call(this, options);
    await Components.install(options);
    return result;
  };
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
    const pin = base.core.listDiscoveredCatalog({ userDataDir: context.userDataDir })
      .sort((a, b) => compareRuntimeVersions(a.version, b.version))[0];
    if (!pin && !local && base.getState({ userDataDir: context.userDataDir }).catalog?.status === 'success') return [];
    return [{ managerId: id, version: local?.version || pin?.version || null, requiresDownload: true, ...(!pin && !local ? { discoveryRequired: true } : {}), appId: String(game.appId),
      optional: true, silentFallback: true, companion: true, label: manager.label,
      ...(pin?.asset?.bytes ? { bytes: pin.asset.bytes } : {}), summary: 'Connects Windows Steam games to the real Mac Steam client.',
      cancelLabel: 'Play Without It', detail: 'Downloads the Steam bridge and current genuine Windows client components from Valve for this private Windows environment. The game keeps its original Steam API. Steam startup has separate Internet consent.' }];
  }
  async function prepare(entry, context, { installation, prefixPath, directory, architecture, environment, externalEnvironment } = {}) {
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
      let target = prefixPath;
      if (externalEnvironment) {
        if (externalEnvironment.running) return null;
        target = path.join(directory, 'steam-environments', hash(fs.realpathSync(prefixPath)).slice(0, 20));
        Writable.assertOwnDirectory(context.userDataDir, directory);
        Writable.assertOwnDirectory(directory, path.dirname(target));
        if (!fs.existsSync(target)) {
          const staging = target + '.stage-' + crypto.randomUUID();
          try {
            try { await execute('/bin/cp', ['-cR', prefixPath, staging], { signal: context.signal }); }
            catch (error) { if (context.signal?.aborted) throw error; if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); await fs.promises.cp(prefixPath, staging, { recursive: true, dereference: false, verbatimSymlinks: true }); }
            fs.renameSync(staging, target);
          } finally { fs.rmSync(staging, { recursive: true, force: true }); }
          require('./launch').detachProfileAliases(target);
        }
      }
      const Environments = require('../../shared/runtime/wine-environment');
      Environments.assertPrivateEnvironment(Environments.privateEnvironment(context.userDataDir, directory, path.relative(directory, target)), directory);
      const source = relative => {
        Bundled.relativeFile(relative);
        const file = path.resolve(current.root, relative);
        if (!inside(fs.realpathSync(current.root), fs.realpathSync(file))) throw new Error('Steam bridge file escaped its managed package.');
        return file;
      };
      const operations = [];
      const copy = (relative, destination, component = false) => {
        Writable.assertOwnDirectory(target, path.dirname(destination));
        operations.push({ source: component ? path.join(components.root, relative) : source(relative), destination });
      };
      const steam = path.join(target, 'drive_c/Program Files (x86)/Steam');
      for (const [abi, files] of Object.entries(descriptor.windows)) {
        copy(files.builtin, path.join(target, 'drive_c/windows', abi === 'i386' ? 'syswow64' : 'system32', 'lsteamclient.dll'));
        copy(components.clients[abi], path.join(steam, abi === 'i386' ? 'steamclient.dll' : 'steamclient64.dll'), true);
      }
      copy(descriptor.windows[pe].helper, path.join(steam, 'steam.exe'));
      copy(descriptor.windows[pe].bootstrap, path.join(steam, 'mlsteam-bootstrap.dll'));
      const transaction = crypto.randomUUID();
      const staged = [], committed = [];
      try {
        for (const operation of operations) {
          const stage = operation.destination + '.mlsteam-' + transaction;
          require('../../shared/copy-file').cloneOrCopySync(operation.source, stage);
          staged.push({ ...operation, stage, backup: operation.destination + '.backup-' + transaction, hadOriginal: false });
        }
        for (const operation of staged) {
          if (fs.lstatSync(operation.destination, { throwIfNoEntry: false })) { fs.renameSync(operation.destination, operation.backup); operation.hadOriginal = true; }
          committed.push(operation);
          fs.renameSync(operation.stage, operation.destination);
        }
      } catch (error) {
        for (const operation of committed.reverse()) {
          fs.rmSync(operation.destination, { force: true });
          if (operation.hadOriginal) fs.renameSync(operation.backup, operation.destination);
        }
        throw error;
      } finally {
        for (const operation of staged) fs.rmSync(operation.stage, { force: true });
      }
      for (const operation of committed) fs.rmSync(operation.backup, { force: true });
      const extra = { WINEDLLPATH: [...new Set([current.root, ...String(environment.WINEDLLPATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter),
        WINEDLLOVERRIDES: [environment.WINEDLLOVERRIDES, 'lsteamclient=b'].filter(Boolean).join(';'),
        SteamAppId: String(game.appId), SteamGameId: String(game.appId), STEAM_COMPAT_CLIENT_INSTALL_PATH: native,
        MACLAUNCHER_STEAM_BOOTSTRAP: 'C:\\Program Files (x86)\\Steam\\mlsteam-bootstrap.dll', HOME: os.homedir(), CFFIXED_USER_HOME: os.homedir() };
      const prepared = { ...environment, ...extra, WINEPREFIX: target };
      delete prepared.STEAM_DYLD_INSERT_LIBRARIES; delete prepared.NOTPROTON_OVERLAY_SHIM;
      return { environment: prepared, extra, prefixPath: target, privateClone: target !== prefixPath,
        helper: 'C:\\Program Files (x86)\\Steam\\steam.exe', appId: String(game.appId), packageVersion: current.version };
    } catch (error) { if (context.signal?.aborted) throw error; return null; }
  }
  return Object.assign(manager, { requirements, prepare, skipOptional, clearSkipped });
}
module.exports = Object.assign(create(), { create, identify, clientRoot });
