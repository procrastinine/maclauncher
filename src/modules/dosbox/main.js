const path = require("node:path");
const fs = require("node:fs");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const manager = require("./runtime/manager");
const { gameDirectory, driveDirectory, prepareGame } = require("./prepare");
const Writable = require("../shared/writable-input");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const Tools = require("./tools");
const { prepareApplication } = require("./runtime/application");

function dosArgument(value) {
  if (typeof value !== "string" || /[\0\r\n"&|<>%]/.test(value)) throw new Error("DOS game arguments cannot contain quotes or command redirection characters.");
  return /\s/.test(value) || !value ? `"${value}"` : value;
}
function launchArguments(entry, context, launch, version) {
  const settings = context.runtimeSettings || {};
  const machine = settings.machine || "svga_s3";
  if (!["svga_s3", "ega", "cga", "tandy", "pcjr", "hercules"].includes(machine)) throw new Error("Invalid DOS machine type.");
  const cycles = String(settings.cycles || "auto").trim();
  if (!/^(?:auto|max|[1-9]\d{0,8})$/.test(cycles)) throw new Error("CPU cycles must be auto, max or a positive number.");
  const conf = path.join(launch.directory, "dosbox.conf");
  const config = `[sdl]\nfullscreen=${settings.fullscreen === true}\nmapperfile=${path.join(launch.directory, "mapper.map")}\n[dosbox]\nmachine=${machine}\n[cpu]\ncycles=${cycles}\n[ipx]\nipx=false\n`;
  Writable.atomicWrite(conf, config, { root: launch.directory });
  const args = ["-noprimaryconf", "-nolocalconf", "-conf", conf];
  const gameArgs = context.gameArguments || [];
  if (!gameArgs.length) args.push(launch.executable);
  else {
    const filename = path.basename(launch.executable);
    if (!/^[A-Za-z0-9_!#$'()+,;=@^`{}~-]{1,8}\.(?:exe|com|bat)$/i.test(filename)) throw new Error("DOS program names with game arguments must use the DOS 8.3 format.");
    const command = `${dosArgument(filename)} ${gameArgs.map(dosArgument).join(" ")}`;
    if (/[\0\r\n"]/.test(path.dirname(launch.executable))) throw new Error("The DOS game folder cannot contain quotes or line breaks.");
    args.push("-c", `mount c "${path.dirname(launch.executable)}"`, "-c", "c:", "-c", command, "-exit");
  }
  return { args, configPath: conf };
}
module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  normalizeRuntimeId: () => "dosbox-staging",
  onImport: (entry, context) => { entry.defaultSaveDir = driveDirectory(entry, context); },
  onRuntimeChange: (entry, context) => { entry.defaultSaveDir = driveDirectory(entry, context); },
  ensureRuntime: (entry, context) => {
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "dosbox-staging") return null;
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const launch = await prepareGame(entry, context), command = launchArguments(entry, context, launch, selected.version);
    const application = await prepareApplication(entry, context, selected.install, launch.directory);
    context.onEntryChange?.(entry);
    return spawnForegroundNativeGame({ context, executablePath: application.executablePath, args: command.args,
      options: { cwd: path.dirname(launch.executable), gameArguments: false, env: { ...process.env, XDG_CONFIG_HOME: launch.directory,
        XDG_CACHE_HOME: path.join(launch.directory, "cache") } }, needsRosetta: selected.install.needsRosetta });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(gameDirectory(entry, context), { recursive: true, force: true }); return true; },
  actions: {
    runtimeStatus: (entry, _payload, context) => manager.resolveSelection(entry, context.settings, context.userDataDir),
    inspectProgram: Tools.inspectExecutable, decompile: Tools.decompile, revealExport: Tools.revealExport
  },
  __test: { launchArguments, dosArgument }
};
