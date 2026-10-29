const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const manager = require("./runtime/manager");
const Worker = require("./worker");
const { detectGame } = require("./inspect");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { getUiServices } = require("../shared/ui-services");
const { focusOwnedNativeGame } = require("../shared/runtime/native-focus");
const { prepareSandbox } = require("./sandbox");
function directory(entry, context) {
  if (!context.userDataDir || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "")) throw new Error("A saved library entry is required for IPA preparation.");
  const root = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
  Writable.assertOwnDirectory(context.userDataDir, root);
  return root;
}
function source(entry) {
  if (typeof entry.gamePath !== "string" || !path.isAbsolute(entry.gamePath) || !/\.ipa$/i.test(entry.gamePath)) throw new Error("IPA file is missing.");
  return entry.gamePath;
}
module.exports = { metadataSources: ["icon.js", "archive.js", "inspect.js", "macho.js", "../shared/runtime/zip.js"], resolveGameIcon: require("./icon").resolveGameIcon, id: manifest.id, manifest, distributionSupplementals: require("./distribution-supplementals.json"), detectGame, runtimeManagers: [manager], normalizeRuntimeId: () => "playcover",
  ensureRuntime: (entry, context) => {
    if (entry.moduleData?.encrypted) throw new Error("Encrypted IPAs cannot run through PlayCover. Import an unencrypted application.");
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selection.ready ? null : { managerId: "playcover", version: selection.version, installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "playcover") return null;
    const runtimeSettings = require("./settings").normalize(context.runtimeSettings);
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selection.ready) throw new Error(selection.reason);
    const launch = await Worker.run("prepare", { source: source(entry), root: directory(entry, context),
      framework: manager.framework(selection.install), frameworkHash: selection.install.installationMetadata?.playToolsSha256,
      frameworkDependencies: selection.install.installationMetadata?.playToolsDependencies || [] }, context.signal);
    const applicationArguments = runtimeSettings.appArgs || [];
    if (!Array.isArray(applicationArguments) || applicationArguments.length > 256 || applicationArguments.some(arg => typeof arg !== "string" || arg.length > 16384 || arg.includes("\0"))) throw new Error("Invalid iOS application arguments.");
    const args = [...applicationArguments, ...(context.gameArguments || [])];
    const graphics = await context.getGameEffectsEnvironment?.() || {};
    require("./settings").writeSettings({ root: directory(entry, context), bundleId: launch.bundleId, settings: runtimeSettings });
    const sandbox = await prepareSandbox({ launch, root: directory(entry, context), graphics, blockNetwork: context.networkAllowed !== true, signal: context.signal });
    const launchedAt = Date.now();
    const originalEffects = context.getGameEffectsEnvironment; let child;
    try {
      context.getGameEffectsEnvironment = async () => sandbox.graphics;
      child = await context.spawnDetachedChecked(sandbox.command, [...sandbox.args, ...args], { cwd: launch.appRoot, env: sandbox.environment, networkIsolationApplied: true, graphicsExecutable: launch.executablePath }, false);
    } finally { context.getGameEffectsEnvironment = originalEffects; }
    void Promise.resolve().then(() => focusOwnedNativeGame(child, { executablePath: launch.executablePath, launchedAt, logger: context.logger })).catch(error => context.logger?.warn?.(error.message));
    return child;
  },
  cleanupGameData: (entry, context) => { fs.rmSync(directory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    inspectGame: (entry, _payload, context) => Worker.run("inspect", { source: source(entry) }, context.signal),
    extractGame: async (entry, _payload, context) => {
      const result = await Worker.run("extract", { source: source(entry), root: path.join(directory(entry, context), "extracted") }, context.signal);
      entry.moduleData = { ...entry.moduleData, extractedRoot: result.extractedRoot }; context.onEntryChange?.(entry); return result;
    },
    revealExtraction: (entry, _payload, context) => {
      const parent = path.join(directory(entry, context), "extracted"), target = entry.moduleData?.extractedRoot;
      if (typeof target !== "string" || !target.startsWith(parent + path.sep) || !fs.existsSync(target) || !fs.realpathSync(target).startsWith(fs.realpathSync(parent) + path.sep)) throw new Error("No extracted IPA contents are available.");
      getUiServices(context).shell.showItemInFolder(target); return { revealed: true };
    }
  }
};

module.exports = require("../shared/decompilation/native").withTools(module.exports, {
  hiddenWhen: [{ key: "moduleData.encrypted", equals: true }],
  resolveInput: async (entry, context) => {
    const original = source(entry), info = await Worker.run("inspect", { source: original }, context.signal);
    if (info.encrypted) throw new Error("Native decompilation requires an unencrypted IPA executable.");
    const root = path.join(directory(entry, context), "native-input"); fs.mkdirSync(root, { recursive: true });
    const binary = path.join(root, info.executable), archive = require("./archive").open(original);
    try { fs.writeFileSync(binary, archive.read(info.appPrefix + info.executable, 512 * 1024 * 1024)); }
    finally { archive.close(); }
    return binary;
  }
});
