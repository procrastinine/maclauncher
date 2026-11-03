const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const GameData = require("../shared/game-data"), Writable = require("../shared/writable-input"), Pack = require("./pack"), Metadata = require("./metadata");
const {hasFineChangeTime} = require("../shared/file-time");
const MAX_ASSEMBLY = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
const apiPath = name => /(?:^|\/)(?:GodotSharp|GodotSharpEditor)\.(?:dll|pdb|xml)$/i.test(name);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
const unchanged = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));
function changed() { return Error("Godot Mono source changed during preparation."); }
function fileDigest(file, stat, signal) {
  const pass = () => {
    signal?.throwIfAborted();const fd = fs.openSync(file, "r"), digest = crypto.createHash("sha256"), buffer = Buffer.alloc(65536);
    try {
      const before = fs.fstatSync(fd);let offset = 0;
      if (!unchanged(before, stat)) throw changed();
      while (offset < before.size) {
        signal?.throwIfAborted();const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!count) throw changed();digest.update(buffer.subarray(0, count));offset += count;
      }
      if (!unchanged(fs.fstatSync(fd), stat) || !unchanged(fs.statSync(file), stat)) throw changed();
      return digest.digest("hex");
    } finally {fs.closeSync(fd);}
  };
  const digest = pass();if (!hasFineChangeTime(stat) && pass() !== digest) throw changed();return digest;
}
function fileFact(file, signal) {
  const stat = fs.statSync(file);return [...identity(stat), ...(!hasFineChangeTime(stat) ? [fileDigest(file, stat, signal)] : [])];
}
// Only missing build outputs are added. Existing files (including user changes)
// win, and link publication cannot overwrite a destination created concurrently.
function addAssembly(root, name, read, signal, packedDebug) {
  const destination = path.join(root, ".mono/temp/bin/Debug", name);
  if (packedDebug?.has(name) || fs.lstatSync(destination, {throwIfNoEntry: false}) ||
      fs.lstatSync(path.join(root, ".mono/assemblies/Debug", name), {throwIfNoEntry: false})) return;
  signal?.throwIfAborted();const bytes = read();signal?.throwIfAborted();
  Writable.assertOwnDirectory(root, path.dirname(destination));
  const temporary = path.join(path.dirname(destination), ".maclauncher-mono-" + crypto.randomUUID());
  try {
    fs.writeFileSync(temporary, bytes, {flag: "wx", mode: 0o600});signal?.throwIfAborted();
    try {fs.linkSync(temporary, destination);} catch (error) {if (error.code !== "EEXIST") throw error;}
  } finally {fs.rmSync(temporary, {force: true});}
}
function assemblyFiles(directory, output, signal) {
  if (!fs.existsSync(directory)) return;
  const canonical = fs.realpathSync(directory);let count = 0;
  function visit(folder, relative = "", depth = 0) {
    signal?.throwIfAborted();if (depth > 8) throw Error("Godot Mono assembly folders are nested too deeply.");
    for (const item of fs.readdirSync(folder, {withFileTypes: true})) {
      if (++count > 4096) throw Error("Godot Mono assembly folder contains too many entries.");
      const file = path.join(folder, item.name), name = path.join(relative, item.name);
      if (item.isSymbolicLink()) throw Error("Godot Mono assembly links must remain regular files inside their assembly folder.");
      if (item.isDirectory()) visit(file, name, depth + 1);
      else if (/\.(?:dll|pdb|mdb|config)$/i.test(item.name) && !apiPath(item.name) && !output.has(name)) output.set(name, file);
    }
  }
  visit(canonical);
}
function readAssembly(file, signal) {
  signal?.throwIfAborted();const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSEMBLY) throw Error("Godot Mono assembly exceeds its supported size.");
  const bytes = fs.readFileSync(file);signal?.throwIfAborted();
  if (!unchanged(stat, fs.statSync(file)) || !hasFineChangeTime(stat) && !bytes.equals(fs.readFileSync(file))) throw changed();
  return bytes;
}
// Packed API rows override loose files, including Godot's own API refresh.
// Only this necessary pack transformation uses per-game storage; cwd stays put.
function filteredPack(entry, source, options, signal, userDataDir) {
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "")) throw Error("Godot Mono pack adaptation requires per-game storage.");
  const sourceFact = fileFact(source, signal), override = path.join(path.dirname(source), "override.cfg");
  const overrideFact = fs.existsSync(override) ? fileFact(override, signal) : null;
  const key = hash(JSON.stringify([source, sourceFact, overrideFact, "mono-api-filter-v1"])).slice(0, 24);
  const root = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"), "mono-packs");
  Writable.assertOwnDirectory(userDataDir, root);
  const marker = path.join(root, key + ".json");
  try {
    const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (/^[a-f0-9-]{36}$/.test(saved.directory)) {
      const file = path.join(root, saved.directory, "main.pck");
      if (JSON.stringify(fileFact(file, signal)) === JSON.stringify(saved.output) &&
          (!overrideFact || JSON.stringify(fileFact(path.join(path.dirname(file), "override.cfg"), signal)) === JSON.stringify(saved.override))) return file;
    }
  } catch {signal?.throwIfAborted();}
  const directory = path.join(root, crypto.randomUUID());Writable.assertOwnDirectory(userDataDir, directory);
  const output = path.join(directory, "main.pck");let complete = false;
  try {
    Pack.withoutEntries(source, output, options, name => /^\.mono\/assemblies\/Debug\//.test(name) && apiPath(name), userDataDir);
    // Godot reads override.cfg beside --main-pack, rather than from cwd.
    if (overrideFact) fs.writeFileSync(path.join(directory, "override.cfg"), readAssembly(override, signal), {flag: "wx"});
    if (JSON.stringify(fileFact(source, signal)) !== JSON.stringify(sourceFact) ||
        overrideFact && JSON.stringify(fileFact(override, signal)) !== JSON.stringify(overrideFact)) throw changed();
    const receipt = {directory: path.basename(directory), output: fileFact(output, signal),
      override: overrideFact ? fileFact(path.join(directory, "override.cfg"), signal) : null};
    Writable.atomicWrite(marker, JSON.stringify(receipt), {root: userDataDir});complete = true;return output;
  } finally {if (!complete) fs.rmSync(directory, {recursive: true, force: true});}
}
async function prepare(entry, {target, install, variant, userDataDir, signal} = {}) {
  if (variant !== "mono" || !/^3\./.test(install?.version || "") || !["pack", "project"].includes(target?.kind)) return null;
  signal?.throwIfAborted();const source = path.resolve(target.path), root = target.kind === "project" ? source : path.dirname(source);
  const data = entry.moduleData || {}, options = source === path.resolve(data.packPath || "") ?
    {offset: data.packOffset ?? 0, ...(data.packSize ? {size: data.packSize} : {})} : {};
  const managed = new Map(), packedDebug = new Set();let packed = [], shadow = false;
  if (target.kind === "pack") Pack.open(source, options, (_fd, pack) => {
    if (pack.engineMajor !== 3) throw Error("Godot Mono runtime and resource pack versions do not match.");
    packed = [...pack.entries.values()].filter(item => /^\.mono\/(?:assemblies|temp\/bin)\/(?:Release|ExportDebug|ExportRelease)\//.test(item.name) && /\.(?:dll|pdb|mdb|config)$/i.test(item.name) && !apiPath(item.name));
    for (const name of pack.entries.keys()) if (/^\.mono\/(?:assemblies|temp\/bin)\/Debug\//.test(name)) packedDebug.add(name.replace(/^\.mono\/(?:assemblies|temp\/bin)\/Debug\//, ""));
    shadow = [...pack.entries.keys()].some(name => /^\.mono\/assemblies\/Debug\//.test(name) && apiPath(name));
  });
  // The editor player searches Debug directly. Its own API refresh and resource
  // lookup remain upstream-owned in the original project, not a private mirror.
  for (const folder of [".mono/temp/bin/Release", ".mono/assemblies/Release", "GodotSharp/Assemblies"]) assemblyFiles(path.join(root, folder), managed, signal);
  if (target.kind === "pack") {
    const title = Metadata.exported(entry)?.name || "UnnamedProject", dataName = "data_" + title.trim().replace(/[\\/:*?"<>|]/g, "-");
    const gameData = [dataName, "data_Godot"].find(name => fs.existsSync(path.join(root, name, "Assemblies")));
    if (gameData) assemblyFiles(path.join(root, gameData, "Assemblies"), managed, signal);
  }
  let total = 0;
  const bounded = bytes => {if ((total += bytes.length) > MAX_TOTAL) throw Error("Godot Mono assemblies exceed the preparation size limit.");return bytes;};
  for (const [name, file] of managed) addAssembly(root, name, () => bounded(readAssembly(file, signal)), signal, packedDebug);
  if (packed.length) Pack.open(source, options, (fd, pack) => {
    for (const item of packed) {
      const name = item.name.replace(/^\.mono\/(?:assemblies|temp\/bin)\/(?:Release|ExportDebug|ExportRelease)\//, "");
      addAssembly(root, name, () => {const bytes = Pack.readEntry(fd, pack.entries.get(item.name), MAX_ASSEMBLY);if (!bytes) throw Error("Godot Mono packed assemblies could not be prepared.");return bounded(bytes);}, signal, packedDebug);
    }
  });
  const adapted = shadow ? filteredPack(entry, source, options, signal, userDataDir) : source;
  signal?.throwIfAborted();return {target: {...target, path: adapted}, cwd: root};
}
module.exports = {prepare};
