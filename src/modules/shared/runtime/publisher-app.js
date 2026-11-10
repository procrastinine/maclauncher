const fs = require("node:fs");
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

// The module hooks for one publisher app: download after consent, then start
// the app's executable with the arguments `launchArguments` derives from the
// game record.
function publisherAppHooks({ manager, runtimeId, launchArguments, isGame = () => true, missing }) {
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
      return spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath,
        args: [...args, ...(context.gameArguments || [])], options: { cwd, env: { ...process.env } }, needsRosetta: selected.install.needsRosetta });
    },
    actions: {
      runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir)
    }
  };
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

module.exports = { recognizeMacRelease, githubMacReleases, createPublisherAppManager, publisherAppHooks, isFile };
