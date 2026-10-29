const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Inspect = require("./inspect");
const Archive = require("./archive");
const GameData = require("../shared/game-data");
const Native = require("./native/launch");
const Managers = require("./native/manager");
const Tools = require("./tools");

function futureRealPath(file) {
  let current = file;
  const parts = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Export storage is unavailable.");
    parts.unshift(path.basename(current)); current = parent;
  }
  return path.join(fs.realpathSync(current), ...parts);
}

function exportScripts(entry, _payload, context) {
  if (!/^[a-z0-9_-]+$/i.test(entry.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("Import this game before exporting its compiled scripts.");
  const report = Inspect.inspectScripts(entry.contentRootDir), parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "mages"), "exports");
  const original = fs.realpathSync(entry.contentRootDir), target = futureRealPath(parent);
  if (target === original || target.startsWith(original + path.sep)) throw new Error("Compiled-script exports must use storage outside the original game.");
  fs.mkdirSync(parent, { recursive: true });
  const nonce = crypto.randomUUID(), staging = path.join(parent, `.scripts-${nonce}`), destination = path.join(parent, `scripts-${nonce}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const archive = Archive.inspectArchive(report.archivePath);
    for (const script of report.scripts) {
      const member = archive.members.get(script.relativePath.toLowerCase()), data = Archive.readMember(archive, member);
      if (data.length !== script.decodedBytes || crypto.createHash("sha256").update(data).digest("hex") !== script.sha256) throw new Error("MAGES. script changed during export.");
      const file = path.join(staging, "compiled", ...script.relativePath.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(path.join(staging, "scripts.json"), JSON.stringify({ ...report, exportFormat: "Original compiled SC3 scripts; no decompilation or runtime patches" }, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(staging, destination);
    return { path: destination, programCount: report.programCount, scriptBytes: report.scriptBytes, complete: report.complete,
      skippedScripts: report.skippedScripts, format: "Compiled SC3" };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function requireNativeProfile(entry) {
  const data = Inspect.inspectGame(entry.contentRootDir || entry.gamePath);
  throw new Error(data?.compatibility || Inspect.compatibility(null));
}

function createModule({ manager = Managers.createManager(), launchEnabled = manifest.supports.launch } = {}) {
  const nativeEntry = entry => launchEnabled && entry?.moduleData?.editionId === "steins-gate-windows-hd" &&
    process.platform === "darwin" && process.arch === "arm64";
  function selectedRuntime(entry, context) {
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selected.ready) Native.verifyNativeProfile(selected.install);
    return selected;
  }
  return { id: manifest.id, manifest, detectGame, runtimeManagers: [...(launchEnabled ? [manager] : []), Tools.manager],
    normalizeRuntimeId: () => launchEnabled ? "impacto" : "mages-tools",
    filterRuntimeSupport: (entry, supported) => !launchEnabled ? supported : nativeEntry(entry) ? supported : [],
    canLaunchRuntime: (runtimeId, entry) => runtimeId === "impacto" && nativeEntry(entry),
    ensureRuntime: async (entry, context) => {
      if (!launchEnabled) return requireNativeProfile(entry);
      const info = Native.inspectEntry(entry);
      entry.moduleData = { ...entry.moduleData, ...info };
      context.onEntryChange?.({ moduleData: entry.moduleData });
      const selected = selectedRuntime(entry, context);
      return selected.ready ? null : { managerId: "impacto", version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: false, installOptions: {} };
    },
    launchRuntime: async (runtimeId, entry, context) => {
      if (!launchEnabled) return requireNativeProfile(entry);
      if (runtimeId !== "impacto") return null;
      const selected = selectedRuntime(entry, context);
      if (!selected.ready) throw new Error(selected.reason);
      const session = Native.prepareLaunch(entry, context, selected.install);
      context.onEntryChange?.({ moduleData: entry.moduleData });
      if (typeof context.spawnDetachedChecked !== "function") throw new Error("Native process launcher is unavailable.");
      return context.spawnDetachedChecked(session.executable, [...session.args, ...(context.gameArguments || [])],
        { cwd: session.cwd, env: { ...process.env, ...session.env } }, selected.install.needsRosetta);
    },
    actions: { inspectArchives: entry => Inspect.inspectArchives(entry.contentRootDir), inspectScripts: entry => Inspect.inspectScripts(entry.contentRootDir), exportScripts,
      exportText: (entry, payload, context) => Tools.exportText(entry, payload, context, exportScripts),
      runtimeStatus: (entry, _payload, context) => selectedRuntime(entry, context) }
  };
}

module.exports = { ...createModule(), __test: { createModule } };
