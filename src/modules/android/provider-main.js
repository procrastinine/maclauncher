const fs = require("node:fs"), path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame, detectGameAsync } = require("./detect");
const Package = require("./provider-package-set");
const Storage = require("./provider-storage");
const Policy = require("./policy");
const Writable = require("../shared/writable-input");
const { bindProcessStop, afterProcessStop } = require("../../core/process-lifecycle");
const provider = id => require("./providers/" + normalizeRuntimeId(id));
function normalizeRuntimeId(id) { return id === "aim" ? "aim" : "macapk"; }
function paths(entry, context) { return Storage.storagePaths(context.userDataDir, entry.gameId, normalizeRuntimeId(context.runtimeId || entry.preferredRuntime)); }
function googleAccounts(id) { return id === "macapk" ? require("./providers/macapk/google-accounts") : require("./provider-google-accounts"); }

module.exports = {
  id: manifest.id, manifest, detectGame, detectGameAsync, normalizeRuntimeId,
  resolveGameIcon(entry, context) {
    if (!context?.userDataDir || !entry?.gameId) return null;
    return provider("aim").resolveIcon(Storage.storagePaths(context.userDataDir, entry.gameId, "aim")) ||
      provider("macapk").resolveIcon(Storage.storagePaths(context.userDataDir, entry.gameId, "macapk"));
  },
  get runtimeManagers() { return [provider("macapk").manager, provider("aim").manager]; },
  onImport(entry, context) { entry.defaultSaveDir = paths(entry, context).androidRoot; },
  resolveSaveLocations(entry, context) {
    const storage = paths(entry, context), directories = [{ directory: storage.androidRoot, role: "primary" }];
    if (fs.existsSync(storage.legacyDataRoot)) directories.push({ directory: storage.legacyDataRoot, role: "legacy" });
    return { primaryDirectory: storage.androidRoot, directories };
  },
  prepareSaveLocation(entry, context) { return Storage.prepareStorage(entry, context.userDataDir, { provider: normalizeRuntimeId(context.runtimeId), signal: context.signal }); },
  ensureRuntime(entry, context) { return provider(context.runtimeId).ensureRuntime(entry, context); },
  async launchRuntime(runtimeId, entry, context) {
    if (!["macapk", "aim"].includes(runtimeId)) return null;
    const storage = await Storage.prepareStorage(entry, context.userDataDir, { provider: runtimeId, signal: context.signal });
    const packageSet = await Storage.preparePackages(entry, context, storage), policy = Policy.resolvePolicy(context.runtimeSettings);
    const clipboard = await require("./provider-clipboard").create(context);
    policy.clipboardSocket = clipboard.socket;
    let child, descriptor, google;
    try {
      if (runtimeId === "macapk") google = await googleAccounts(runtimeId).prepareLaunch({ entry, context, packageSet, policy });
      if (google) { policy.google = google; policy.googleSocket = google.socket; policy.googleCapability = google.capability; }
      descriptor = await provider(runtimeId).prepareLaunch({ entry, context, storage, packageSet, policy });
      if (descriptor.expansionDirectory) await require("./expansions").installExpansions(entry.gamePath,
        packageSet.metadata.packageName, storage.root, { archive: Package.ARCHIVES.test(entry.gamePath),
          destination: descriptor.expansionDirectory, signal: context.signal });
      descriptor.env = { ...descriptor.env, MACLAUNCHER_CLIPBOARD_SOCKET: clipboard.socket };
      const graphics = await context.getGameEffectsEnvironment?.() || {};
      const isolation = await Policy.prepareIsolation(descriptor, storage, policy, { graphics, signal: context.signal });
      const original = context.getGameEffectsEnvironment;
      const output = require("./provider-output").captureRuntimeOutput(storage.root, context.logger);
      const originalSpawn = context.onProcessSpawn;
      let cleanupPromise;
      const cleanup = () => cleanupPromise ||= Promise.all([
        clipboard.close(), google?.close(), Promise.resolve().then(() => descriptor.cleanup?.())
      ]);
      const onSpawn = async process => {
        if (typeof descriptor.stop === "function") {
          bindProcessStop(process, async binding => {
            if (await descriptor.stop(binding) === false) return false;
            await cleanup();return true;
          });
          process.on("runtimeStopError", error => context.logger?.error?.("Android shutdown failed: " + error.message));
        }
        output.attach(process);await originalSpawn?.(process);
      };
      try {
        context.getGameEffectsEnvironment = async () => isolation.graphics;
        // Backend ownership descriptors must already carry pending diagnostics,
        // including a controller that exits before checked spawn resolves.
        context.onProcessSpawn = onSpawn;
        child = await context.spawnDetachedChecked(isolation.command, isolation.args,
          { cwd: descriptor.cwd || storage.root, env: isolation.environment, networkIsolationApplied: true,
            graphicsExecutable: descriptor.application?.executablePath || descriptor.application?.command || null,
            stdio: ["ignore", "pipe", "pipe"] }, false);
        output.attach(child);
        clipboard.enroll(child.pid);
        google?.enroll(child.pid);
      } catch (error) { output.close(error); throw error; }
      finally {
        context.getGameEffectsEnvironment = original;
        if (context.onProcessSpawn === onSpawn) {
          if (originalSpawn) context.onProcessSpawn = originalSpawn;
          else delete context.onProcessSpawn;
        }
      }
      entry.defaultSaveDir = storage.androidRoot; context.onEntryChange?.(entry);
      {
        let cleaned = false;
        const finished = () => {if (cleaned) return;cleaned = true;void afterProcessStop(child, () => {
          // Failed owned shutdown does not authorize detaching a live guest's
          // data image. Independent launcher IPC can still close normally.
          const operation = child.runtimeStopError ? Promise.all([clipboard.close(), google?.close()]) : cleanup();
          return operation.catch(error => context.logger?.warn?.(error.message));
        });};
        child.once("exit", finished); child.once("close", finished);
        if (child.exitCode != null || child.signalCode != null) finished();
      }
      return child;
    } catch (error) { await clipboard.close(); await google?.close(); if (!child) await descriptor?.cleanup?.(); else child.kill(); throw error; }
  },
  cleanupGameData(entry, context) {
    const storage = paths(entry, context);
    Writable.assertOwnDirectory(context.userDataDir, storage.gameRoot, { create: false });
    fs.rmSync(storage.gameRoot, { recursive: true, force: true }); return true;
  },
  actions: {
    listGoogleAccounts: (entry, payload, context) => googleAccounts(normalizeRuntimeId(context.runtimeId || entry.runtimeId)).choices(entry, payload, context),
    inspectGame: async entry => {
      const metadata = (await Package.inspectInput(entry.gamePath)).metadata;
      return { ...metadata, architectureLabel: metadata.architectures.join(", ") || "Java",
        activity: metadata.launchers[0]?.activity || "No enabled launcher activity" };
    },
    importFiles: (entry, payload, context) => require("./provider-file-import").importFiles(entry, payload, context)
  },
  settingsActions: {
    googleAccounts: (_payload, context) => require("./provider-google-accounts").state(context),
    signInGoogle: (_payload, context) => require("./provider-google-accounts").signIn(context),
    removeGoogleAccount: (payload, context) => require("./provider-google-accounts").remove(payload?.accountId, context)
  }
};
