const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Prepare = require("./prepare");
const Host = require("./host");
const Tools = require("./tools");
const manager = require("./runtime/manager");
const MsgTool = require("../shared/runtime/msg-tool");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");

function appendLog(child, entry, context, directory) {
  const file = path.join(directory, "rfvp.log"), fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let written = 0, tail = "", closed = false;
  const append = bytes => {
    if (closed) return;
    tail = (tail + bytes.toString()).slice(-4096);
    const size = Math.min(bytes.length, 512 * 1024 - written);
    if (size > 0) { fs.writeSync(fd, bytes, 0, size); written += size; }
  };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  child.once("close", (code, signal) => {
    if (!closed) { closed = true; fs.closeSync(fd); }
    if (code != null && code !== 0 || ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"].includes(signal)) {
      entry.moduleData = { ...entry.moduleData, nativeRuntimeError: tail.trim() || `RFVP ended with ${signal || code}. This game may require a different runtime version or text encoding.` };
      context.onEntryChange?.(entry); context.logger?.error?.(entry.moduleData.nativeRuntimeError);
    }
  });
}
module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [manager, MsgTool], normalizeRuntimeId: () => "rfvp",
  canLaunchRuntime: runtimeId => runtimeId === "rfvp" && process.platform === "darwin",
  onImport: (entry, context) => { entry.defaultSaveDir = Prepare.saveDirectory(entry, context); },
  resolveSaveLocations: (entry, context) => {
    const directory = Prepare.saveDirectory(entry, context);
    return { primaryDirectory: directory, directories: [{ directory, role: "primary", source: "RFVP private saves", confidence: "exact" }] };
  },
  ensureRuntime: async (entry, context) => {
    Prepare.gameData(entry, context);
    const selection = await manager.resolveForPlay(entry, context);
    return selection.ready ? null : { managerId: manager.id, version: selection.version, ...(selection.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "rfvp") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = Prepare.prepareLaunch(entry, context), host = Host.hostCommand(launch, selected.install);
    entry.moduleData = { ...entry.moduleData, nativeRuntimeError: null };
    context.onEntryChange?.(entry);
    const child = await spawnForegroundNativeGame({ context, executablePath: host.executablePath, args: [...host.args, ...(context.gameArguments || [])],
      options: { cwd: launch.playRoot, env: launch.env, stdio: ["ignore", "pipe", "pipe"] } });
    appendLog(child, entry, context, launch.directory);
    return child;
  },
  cleanupGameData: (entry, context) => { const directory = Prepare.directoryFor(entry, context); fs.rmSync(directory, { recursive: true, force: true }); return true; },
  actions: {
    exportText: (entry, payload, context) => {
      const encoding = context.runtimeSettings?.textEncoding || entry.moduleData?.textEncoding || "sjis";
      const info = require("./inspect").inspectGame(entry.contentRootDir || entry.gamePath, { inputPath: entry.moduleData?.scriptPath, textEncoding: encoding });
      if (!info) throw new Error("FVP script data was not found.");
      return MsgTool.exportText(entry, payload, context, { moduleId: "fvp", inputs: [info.scriptPath], scriptType: "favorite",
        encoding: { sjis: "cp932", gbk: "gb2312", utf8: "utf8" }[encoding] });
    },
    inspectGame: (entry, _payload, context) => { const result = Prepare.gameData(entry, context, { refresh: true }); context.onEntryChange?.(entry); return result.data; },
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    "fvp-list-assets": (entry, payload, context) => Tools.listAssets(entry, payload, context),
    "fvp-extract-assets": (entry, payload, context) => Tools.extractAssets(entry, payload, context),
    "fvp-reveal-assets": (entry, payload, context) => Tools.revealAssets(entry, payload, context),
    "fvp-remove-assets": (entry, payload, context) => Tools.removeAssets(entry, payload, context)
  },
  __test: { appendLog, ...Prepare }
};
