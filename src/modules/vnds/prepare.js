const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const GameData = require("../shared/game-data");
const Zip = require("../shared/runtime/zip");
const Save = require("./save");
const run = promisify(execFile);
const PROFILE = "0.0.13-838e47b-mac-v1";
const REVISION = "838e47b7b47ed8d019cdaaa191f4953324e75540";
const PROFILE_SHA256 = "2802d135ac46e59a3e54e582bebeddf96c2f5e8c8c311bd7766783c0f2c1ef83";
const ENGINE_RELATIVE = path.join("src", "modules", "vnds", "resources", PROFILE);
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function moduleRoot(entry, context) {
  if (!path.isAbsolute(context?.userDataDir || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(entry?.gameId || "")) throw new Error("VNDS requires a persisted game and a local data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "vnds");
}
function saveLocations(entry, context) {
  const root = moduleRoot(entry, context), directory = path.join(root, "saves");
  return { primaryDirectory: directory, directories: [{ directory: entry.saveDirOverride || directory, label: "Saves", source: "VNDS-LOVE" }] };
}
function safeName(name) { return typeof name === "string" && name && !path.posix.isAbsolute(name) && !/[\\\x00-\x1f]/.test(name) && !name.split("/").some(part => !part || part === "." || part === ".."); }
function archiveMounts(root) {
  const mounts = [];
  for (const group of ["script", "background", "foreground", "sound"]) {
    const archive = path.join(root, group + ".zip");
    if (!fs.existsSync(archive) || fs.existsSync(path.join(root, group))) continue;
    const listing = Zip.readZipEntries(archive);
    if (!listing || listing.entries.length > 10000 || listing.entries.some(entry => !safeName(entry.name.replace(/\/$/, "")))) throw new Error("VNDS archive contains unsupported paths.");
    const names = listing.entries.filter(entry => !entry.name.endsWith("/")).map(entry => entry.name);
    const rooted = names.every(name => name.startsWith(group + "/"));
    if (!rooted && names.some(name => name.includes("/"))) throw new Error("VNDS archive has an unsupported folder layout.");
    mounts.push({ path: archive, point: "novels/game" + (rooted ? "" : "/" + group), prepend: false });
  }
  return mounts;
}
function resolveEngineRoot({ resourcesRoot, moduleDir = __dirname } = {}) {
  if (resourcesRoot != null && !path.isAbsolute(resourcesRoot)) throw new Error("VNDS app resources must be an absolute directory.");
  if (!path.isAbsolute(moduleDir)) throw new Error("VNDS module resources must be an absolute directory.");
  // Native LÖVE cannot read Electron's virtual archive. Deriving its sibling
  // also works in plain Node workers without process.resourcesPath.
  const archive = path.resolve(moduleDir).match(/^(.*?)[/\\]app\.asar(?:[/\\]|$)/);
  let resourceRoot = resourcesRoot || archive?.[1];
  if (!resourceRoot && typeof process.resourcesPath === "string" && path.isAbsolute(process.resourcesPath) &&
      fs.existsSync(path.join(process.resourcesPath, "app.asar.unpacked", ENGINE_RELATIVE))) resourceRoot = process.resourcesPath;
  const candidate = resourceRoot ? path.join(resourceRoot, "app.asar.unpacked", ENGINE_RELATIVE) : path.join(moduleDir, "resources", PROFILE);
  const virtual = file => /[/\\]app\.asar(?:[/\\]|$)/.test(file);
  try {
    if (virtual(candidate)) throw new Error("Virtual archive");
    const root = fs.realpathSync(candidate);
    if (virtual(root) || !fs.statSync(root).isDirectory()) throw new Error("Invalid directory");
    return root;
  } catch {
    throw new Error("Included VNDS adapter is missing. Reinstall MacLauncher.");
  }
}
function verifyEngine(options) {
  const root = resolveEngineRoot(options), file = path.join(root, "bundle-profile.json");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536 || hash(bytes) !== PROFILE_SHA256) throw new Error("The bundled VNDS adapter provenance changed. Reinstall the launcher.");
  const profile = JSON.parse(bytes.toString("utf8"));
  if (profile.profile !== PROFILE || profile.sourceRevision !== REVISION || !profile.files || Object.keys(profile.files).length > 80) throw new Error("The bundled VNDS adapter version is invalid.");
  for (const [name, expected] of Object.entries(profile.files)) {
    if (!safeName(name) || hash(fs.readFileSync(path.join(root, name))) !== expected) throw new Error("The bundled VNDS adapter changed. Reinstall the launcher.");
  }
  return { root, profile };
}
function importSaves(root, directory) {
  for (const name of fs.readdirSync(root)) {
    if (!/^(?:save(?:[1-9]|10)|global)\.json$/i.test(name) || fs.existsSync(path.join(directory, name))) continue;
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Original VNDS save exceeds the import limit.");
    const bytes = fs.readFileSync(file); Save.validate(bytes.toString("utf8"));
    fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx" });
  }
}
async function prepareAudio(entry, context, root, directory, dependencies = {}) {
  const source = path.join(root, "sound");
  if (!fs.existsSync(source)) return [];
  const selected = fs.readdirSync(source, { withFileTypes: true }).filter(item => item.isFile() && /\.(?:aac|m4a)$/i.test(item.name));
  if (!selected.length) return [];
  if (selected.length > 256) throw new Error("VNDS has too many audio files for automatic conversion.");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < selected.length; index++) {
    const name = selected[index].name, input = path.join(source, name), stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.size > MAX_AUDIO_BYTES) throw new Error("VNDS audio exceeds the 32 MB limit.");
    const originalSha256 = hash(fs.readFileSync(input)), output = path.join(directory, name), sidecar = output + ".maclauncher.json";
    let saved; try { saved = JSON.parse(fs.readFileSync(sidecar, "utf8")); } catch {}
    if (saved?.originalSha256 === originalSha256 && fs.existsSync(output) && hash(fs.readFileSync(output)) === saved.outputSha256) continue;
    context.onPreparationChange?.({ phase: "preparing", message: "Preparing audio", completed: index, total: selected.length });
    const temporary = output + "." + crypto.randomUUID() + ".flac";
    try {
      await (dependencies.run || run)("/usr/bin/afconvert", ["-f", "flac", "-d", "flac", input, temporary], { timeout: 60000, maxBuffer: 1024 * 1024 });
      const result = fs.statSync(temporary);
      if (!result.isFile() || result.size > 128 * 1024 * 1024 || fs.readFileSync(temporary).subarray(0, 4).toString("ascii") !== "fLaC") throw new Error("Audio conversion did not produce a supported FLAC file.");
      const outputSha256 = hash(fs.readFileSync(temporary)); fs.renameSync(temporary, output);
      fs.writeFileSync(sidecar, JSON.stringify({ schemaVersion: 1, originalSha256, outputSha256, decoder: "macOS AudioToolbox", format: "FLAC" }));
    } catch (error) { throw new Error(`Cannot prepare VNDS audio ${name}: ${error.message}`); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  return [{ path: directory, point: "novels/game/sound", prepend: true }];
}
async function prepare(entry, context, dependencies = {}) {
  const owned = moduleRoot(entry, context), root = fs.realpathSync(entry.contentRootDir || entry.gamePath);
  const engine = verifyEngine(context), saveRoot = entry.saveDirOverride || path.join(owned, "saves"), saveDirectory = saveRoot;
  if (!path.isAbsolute(saveRoot)) throw new Error("VNDS save location must be an absolute directory.");
  fs.mkdirSync(saveDirectory, { recursive: true });
  importSaves(root, saveDirectory);
  const working = path.join(owned, "session"); fs.mkdirSync(working, { recursive: true });
  const mounts = [...archiveMounts(root), ...await prepareAudio(entry, context, root, path.join(owned, "audio"), dependencies)];
  const mountFile = path.join(working, "mounts.json"); fs.writeFileSync(mountFile, JSON.stringify(mounts));
  const locations = saveLocations(entry, context); entry.defaultSaveDir = locations.primaryDirectory; entry.saveLocations = locations.directories;
  return { engine: engine.root, root, saveRoot, saveDirectory, working, mountFile, profile: engine.profile };
}
module.exports = { PROFILE, REVISION, moduleRoot, saveLocations, safeName, archiveMounts, resolveEngineRoot, verifyEngine, importSaves, prepareAudio, prepare };
