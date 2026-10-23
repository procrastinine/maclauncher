const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, detectGameAsync } = require("./detect");
const { inspectApk } = require("./apk");
const Host = require("./host");
const Runtime = require("./runtime");
const Writable = require("../shared/writable-input");
const Storage = require("./storage");
const Metadata = require("./package-metadata");
const manager = require("./runtime-manager");
const LaunchPolicy = require("./launch-policy");
const ArtRuntime = require("./art/runtime-manager");

function gameDirectory(entry, context) {
  return Storage.storagePaths(context?.userDataDir, entry?.gameId).root;
}

function listAngleBackends(entry, context) {
  return { angleBackends: [{ value: "metal", label: "Metal" },
    ...(Runtime.resolveSelected(entry, context)?.profile?.angleVulkanVersion === 1 ? [{ value: "vulkan", label: "Vulkan" }] : [])] };
}
function listVulkanRuntimes(_payload, context) {
  return require("../shared/vulkan").choices(context);
}

module.exports = {
  id: manifest.id, manifest, detectGame, detectGameAsync,
  metadataCacheKey: Metadata.metadataCacheKey, mergeEntry: Metadata.mergeEntry,
  resolveGameMetadata: Metadata.resolveGameMetadata, resolveGameIcon: Metadata.resolveGameIcon,
  distributionSupplementals: require("./distribution-included.json"),
  normalizeRuntimeId: () => "klepton",
  get runtimeManagers() { return [manager, ArtRuntime.manager]; },
  onImport(entry, context) { entry.defaultSaveDir = path.join(gameDirectory(entry, context), "data", "files"); },
  resolveSaveLocations(entry, context) {
    const directory = Storage.storagePaths(context.userDataDir, entry.gameId).filesRoot;
    return { primaryDirectory: directory, directories: [{ directory, role: "primary" }] };
  },
  prepareSaveLocation(entry, context) { return Storage.prepareStorage(entry, context.userDataDir); },
  ensureRuntime(entry, context) {
    LaunchPolicy.execution(context);
    const selection = manager.resolveSelection(entry, context?.settings, context?.userDataDir);
    return selection.ready ? null : { managerId: manager.id, version: selection.version, installOptions: {} };
  },
  getRuntimeRequirements(entry, context) {
    if (context.runtimeId && context.runtimeId !== "klepton") return [];
    return [
      ...(LaunchPolicy.execution(context) === "art" ? ArtRuntime.requirements(entry, context) : []),
      ...require("../shared/vulkan").requirements(context)
    ];
  },
  async launchRuntime(runtimeId, entry, context) {
    if (runtimeId !== "klepton") return null;
    const execution = LaunchPolicy.execution(context);
    entry.defaultSaveDir = Storage.storagePaths(context.userDataDir, entry.gameId).filesRoot;
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason);
    if (context.useRuntime) await context.useRuntime({ managerId: manager.id, version: selection.version,
      sourcePath: selection.install.installDir });
    let payload = await Runtime.resolveForLaunch({ root: selection.install.root, signal: context.signal }, selection.install.declaration);
    if (execution === "art") {
      const common = payload;
      payload = require("./art/runtime").attachSupplier(common, await ArtRuntime.resolveForLaunch(entry, context));
      return Host.launch(entry, context, payload, { resolvePlatformRuntime: async () => common });
    }
    return Host.launch(entry, context, payload);
  },
  async cleanupGameData(entry, context) {
    const directory = gameDirectory(entry, context), legacy = path.join(context.userDataDir, "games", entry.gameId, "modules", "android");
    await require("./service-packages").removeApplication(context.userDataDir,entry.gameId,{retire:packages=>require("./account-owner").removePackages(context,packages)});
    // Removing a game explicitly removes both launcher-owned copies; an
    // imported external save folder is never part of this cleanup.
    for (const owned of [directory, legacy]) {
      if (!fs.existsSync(owned)) continue;
      Writable.assertOwnDirectory(context.userDataDir, owned, { create: false });
      fs.rmSync(owned, { recursive: true, force: true });
    }
    return true;
  },
  actions: {
    listAngleBackends: (entry, _payload, context) => listAngleBackends(entry, context),
    listVulkanRuntimes: (_entry, payload, context) => listVulkanRuntimes(payload, context),
    listGoogleAccounts: (entry, payload, context) => require("./google-accounts").choices(entry, payload, context),
    listMediaInputs: (entry, payload, context) => require("./media-inputs").listDevices(entry, payload, context),
    importFiles: (entry, payload, context) => require("./file-import").importFiles(entry, payload, context),
    addToGooglePlay: (entry, payload, context) => require("./play-library").acquire(entry, payload, context),
    inspectGame: async (entry, _payload, context) => {
      const abi = require("./native-abi"), profile = Runtime.resolveSelected(entry, context)?.profile || require("./provider-native-abi").installedProfile();
      const metadata = entry.moduleData?.packageSet ? (await require("./package-set").inspectInput(entry.gamePath, { profile })).metadata : inspectApk(entry.gamePath, { nativeArchitectures: abi.supported(profile) });
      return { ...metadata, architectureLabel: metadata.architectures.join(", ") || "Java",
        activity: metadata.launchers[0]?.activity || "No enabled launcher activity",
        compatibility: metadata.limitations.length ? metadata.limitations.join(" ") :
          "Compatibility depends on the Android APIs and native libraries used by the application." };
    },
    runtimeStatus: (entry, _payload, context = {}) => {
      const selected = manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" });
      return { ready: selected.ready, included: selected.install?.source === "bundled", version: selected.version,
        label: "MacLauncher Android", reason: selected.reason };
    }
  },
  settingsActions: {
    listAngleBackends: (_payload, context) => listAngleBackends(null, context),
    listVulkanRuntimes,
    googleAccounts: (payload, context) => require("./google-accounts").state(context, { refresh: payload?.refresh === true }),
    signInGoogle: (_payload, context) => require("./google-accounts").signIn(context),
    removeGoogleAccount: (payload, context) => require("./google-accounts").remove(payload?.accountId, context)
  }
};
