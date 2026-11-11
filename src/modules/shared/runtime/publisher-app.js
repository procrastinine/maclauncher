const fs = require("node:fs");
const path = require("node:path");
const GameData = require("../game-data");
const { bindNativeAppStop } = require("./native-app-stop");
const { createPinnedNativeManager } = require("./pinned-native-manager");
const { resolveAppBundleExecutablePath } = require("./app-bundle");
const { locatePackaged, macDownloads } = require("./release-files");
const Upstream = require("./upstream");
const Native = require("./local-native");
const { spawnForegroundNativeGame } = require("./native-focus");

// A publisher's stable GitHub releases with a version tag. The Mac download is
// found by its platform and CPU words, whatever its current name.
function recognizeMacRelease(release) {
  const version = /^v?(\d+(?:\.\d+)+)$/.exec(release?.tag_name || "")?.[1];
  if (!version) return null;
  const downloads = macDownloads(release.assets);
  return downloads.length ? downloads.map(({ asset, architecture }) => ({ version, ...(architecture ? { architecture } : {}), assets: [asset] }))
    : { version, installReason: "This release has no macOS download." };
}
const githubMacReleases = repository => Upstream.github({ repository, allArchitectures: true, recognize: recognizeMacRelease });

// A publisher's macOS app, installed unchanged from its release download. The
// app's current name is found first; a renamed app or one moved into a
// folder is found too. The installed executable states its CPUs, and Intel-only
// builds run through Rosetta on Apple Silicon.
function createPublisherAppManager({ id, label, sourceUrl, upstream, appName, dependencies = {} }) {
  const resolveExecutable = root => resolveAppBundleExecutablePath(locatePackaged(root, [appName, /\.app$/i]));
  function prepareInstall({ unpacked }) {
    const executable = resolveExecutable(unpacked);
    if (!executable) throw new Error(`The ${label} download contains no app.`);
    return { architectures: Native.readMachOArchitectures(executable) };
  }
  const manager = createPinnedNativeManager({ id, label, sourceUrl, upstream, resolveExecutable, prepareInstall, dependencies,
    // The game data is identified by the engine; no data file names an engine release.
    versionCompatibility: () => true });
  return Object.assign(manager, { resolveExecutable, prepareInstall });
}

// Each game's engine home is a folder in the game's launcher data. The engine's
// user folders (Library/Preferences, Library/Application Support, Documents)
// resolve inside it, so configuration, saves, caches and logs stay with the
// game and are removed when the game is removed from the library.
function engineHome(entry, context, moduleId) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || ""))
    throw new Error("The engine requires a saved game entry and launcher data directory.");
  const home = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "home");
  for (const folder of [["Library", "Preferences"], ["Library", "Application Support"], ["Documents"]])
    fs.mkdirSync(path.join(home, ...folder), { recursive: true });
  return home;
}

// The module hooks for one publisher app: download after consent, then start
// the app's executable with the arguments `launchArguments` derives from the
// game record. Stop sends the app a normal Quit and ends it after a grace
// period when it does not quit.
function publisherAppHooks({ manager, moduleId, runtimeId = moduleId, launchArguments, isGame = () => true, missing }) {
  return {
    runtimeManagers: [manager],
    normalizeRuntimeId: () => runtimeId,
    ensureRuntime: (entry, context) => {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
      return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
    },
    launchRuntime: async (id, entry, context) => {
      if (id !== runtimeId) return null;
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
      if (!selected.ready) throw new Error(selected.reason);
      if (!isGame(entry)) throw new Error(missing);
      const { args, cwd } = launchArguments(entry);
      const home = engineHome(entry, context, moduleId), executablePath = selected.install.executablePath;
      const originalSpawn = context.onProcessSpawn;
      context.onProcessSpawn = async child => {
        bindNativeAppStop(child, { executablePath, platform: context.platform || process.platform, graceMs: STOP_GRACE_MS, logger: context.logger });
        await originalSpawn?.(child);
      };
      try {
        return await spawnForegroundNativeGame({ context, executablePath, args: [...args, ...(context.gameArguments || [])],
          options: { cwd, env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home } }, needsRosetta: selected.install.needsRosetta });
      } finally { context.onProcessSpawn = originalSpawn; }
    },
    actions: {
      runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir)
    }
  };
}

// A publisher app is also a runtime choice for games of `gameTypes` that
// another module detects, such as a DOS game whose folder holds this engine's
// game data. Detection records the folder's main game file for this engine
// when the folder holds exactly one; runtime choices read only that record and
// never the game's files. `entryFor` hands the recorded file to the engine's
// own launch hooks.
function publisherAppProvider({ hooks, moduleId, runtime, gameTypes, candidates, entryFor }) {
  const runtimeId = hooks.normalizeRuntimeId();
  const root = entry => entry?.contentRootDir || entry?.gamePath;
  const applies = entry => entry?.moduleId !== moduleId && gameTypes.includes(entry?.gameType) &&
    typeof root(entry) === "string" && path.isAbsolute(root(entry));
  const recorded = entry => {
    const name = entry?.runtimeData?.[runtimeId]?.gameFile;
    return applies(entry) && typeof name === "string" && name && path.basename(name) === name && !/[\0\r\n]/.test(name) ? name : null;
  };
  return { runtimeId, managerId: hooks.runtimeManagers[0].id, runtime: { ...runtime, input: { gameTypes } },
    supports: { saveLocation: false, saveEditing: false, cheats: false, cheatsPatcher: false },
    // Detection runs at import and at each library refresh, so a game imported
    // earlier gains the record, and a folder that no longer holds exactly one
    // game file loses it (a null record replaces a stored one when merged).
    decorateEntry: entry => {
      if (!applies(entry)) return entry;
      let files = [];
      try { files = candidates(root(entry)); } catch {}
      const gameFile = files.length === 1 && path.dirname(files[0]) === root(entry) ? path.basename(files[0]) : null;
      return { ...entry, runtimeData: { ...entry.runtimeData, [runtimeId]: gameFile ? { ...entry.runtimeData?.[runtimeId], gameFile } : null } };
    },
    supportsEntry: entry => Boolean(recorded(entry)),
    ensureRuntime: (entry, context) => hooks.ensureRuntime(entry, context),
    launchRuntime: (id, entry, context) => {
      const name = recorded(entry);
      if (!name) throw new Error("The game's folder holds no game this engine runs.");
      return hooks.launchRuntime(id, entryFor(entry, path.join(root(entry), name)), context);
    } };
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// DREAMM, an SDL app, ignores SIGTERM; a Cocoa Quit gives each engine time to
// write its configuration before it is ended.
const STOP_GRACE_MS = 5000;

module.exports = { recognizeMacRelease, githubMacReleases, createPublisherAppManager, publisherAppHooks, publisherAppProvider, engineHome, isFile, STOP_GRACE_MS };
