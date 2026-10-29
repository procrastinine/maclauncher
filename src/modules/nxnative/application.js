const fs = require("node:fs");
const path = require("node:path");
const Application = require("../shared/native-application");
const DockIcon = require("../shared/dock-icon");
const Writable = require("../shared/writable-input");
const GameData = require("../shared/game-data");
const GameIcons = require("../../core/game-icons");
const Icons = require("../../core/icon-utils");
const { inside } = require("./detect");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { pythonEnvironment } = require("./prepare");

function imagePath(file) {
  try {
    if (!path.isAbsolute(file || "")) return null;
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024 && Icons.isSupportedImageBuffer(fs.readFileSync(file)) ? file : null;
  } catch { return null; }
}
function readMetadata(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid Switch application metadata.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function controlIcon(entry, context, launch) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) return null;
    const root = fs.realpathSync(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "nxnative"));
    let prepared = launch?.prepared, environment = launch?.env;
    if (!prepared) {
      const workspace = readMetadata(path.join(root, "workspace.json"));
      if (workspace.schemaVersion !== 1 || typeof workspace.preparedRelative !== "string") return null;
      prepared = path.resolve(root, workspace.preparedRelative);
      if (!inside(path.join(root, "prepared"), prepared)) return null;
      environment = readMetadata(path.join(prepared, "launch.json")).env;
    }
    prepared = fs.realpathSync(prepared);
    if (!inside(path.join(root, "prepared"), prepared) || !path.isAbsolute(environment?.DM_ROMFS || "")) return null;
    const romfs = fs.realpathSync(environment.DM_ROMFS);
    if (!inside(prepared, romfs)) return null;
    // The selected extraction's Control data sits beside its RomFS directory.
    const icon = fs.realpathSync(path.join(path.dirname(romfs), "icon.jpg"));
    if (!inside(prepared, icon)) return null;
    const stat = fs.statSync(icon);
    if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 * 1024) return null;
    const header = Buffer.alloc(3), descriptor = fs.openSync(icon, "r");
    try { if (fs.readSync(descriptor, header, 0, 3, 0) !== 3 || header.toString("hex") !== "ffd8ff") return null; }
    finally { fs.closeSync(descriptor); }
    return icon;
  } catch { return null; }
}
async function resolveGameIcon(entry, context, launch) {
  const source = controlIcon(entry, context, launch);
  if (!source) return null;
  const directory = GameData.resolveGameIconsDir(context.userDataDir, entry.gameId);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  try { return await DockIcon.prepare(source, directory, { signal: context.signal }); }
  catch (error) { context.signal?.throwIfAborted();context.logger?.debug?.("[nxnative] game icon: " + error.message);return null; }
}
async function displayName(entry, context, launch, runtime, directory) {
  const input = entry.moduleData?.inputPath, automatic = typeof input === "string" ? path.basename(input, path.extname(input)) : null;
  if (!runtime || entry.name && entry.name !== automatic) return entry.name || "Switch game";
  try {
    const prepared = fs.realpathSync(launch.prepared), romfs = fs.realpathSync(launch.env.DM_ROMFS);
    const control = fs.realpathSync(path.join(path.dirname(romfs), "control.nacp")), stat = fs.statSync(control);
    if (!inside(prepared, romfs) || !inside(prepared, control) || !stat.isFile() || stat.size < 0x3000 || stat.size > 65536) return entry.name || "Switch game";
    const shared = await pythonEnvironment(runtime, context);
    const source = runtime.source?.root || path.join(runtime.root, "share/nxnative");
    const python = shared?.pythonPath || path.join(runtime.root, runtime.config.runtimeFiles.python), parser = path.join(source, "dm/tools/nacp.py");
    if ((!shared && !inside(fs.realpathSync(runtime.root), fs.realpathSync(python))) || !inside(fs.realpathSync(source), fs.realpathSync(parser))) return entry.name || "Switch game";
    const output = [];let size = 0;
    await runToolCommand(python, ["-I", "-B", parser, control], { cwd: directory, logPath: path.join(directory, "name.log"), signal: context.signal, timeout: 5000,
      ...(shared ? { env: shared.env } : {}),
      onSpawn: child => { child.stdout.on("data", bytes => { if (size < 4096) { const part = bytes.subarray(0, 4096 - size);output.push(part);size += part.length; } });return context.onToolProcessSpawn?.(child); } });
    const name = Buffer.concat(output).toString("utf8").trim();
    return name && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name) ? name : entry.name || "Switch game";
  } catch (error) { context.signal?.throwIfAborted();context.logger?.debug?.("[nxnative] game name: " + error.message);return entry.name || "Switch game"; }
}
async function prepareApplication(entry, context, launch, dependencies = {}) {
  const icon = await GameIcons.selectIconForEntry({ entry, moduleIconPath: await resolveGameIcon(entry, context, launch),
    moduleDefaultIconPath: path.join(__dirname, "resources/icon.png"), canRenderPath: imagePath,
    extractCandidate: async () => null, signal: context.signal });
  const directory = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "nxnative"), "application");
  Writable.assertOwnDirectory(context.userDataDir, directory);
  const application = await (dependencies.prepare || Application.prepare)({ executablePath: launch.command, directory,
    title: await displayName(entry, context, launch, dependencies.runtime, directory), iconFile: icon.path, showInDock: true, graphicsCompatible: true,
    nameFallback: "Switch game", applicationLabel: "Nintendo Switch", signal: context.signal });
  return { ...application, iconPath: icon.path, iconSource: icon.source };
}
module.exports = { prepareApplication, resolveGameIcon };
