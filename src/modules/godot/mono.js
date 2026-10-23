const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const GameData = require("../shared/game-data"), Writable = require("../shared/writable-input"), Pack = require("./pack"), Project = require("./project");
const Metadata = require("./metadata");
const API = new Set(["GodotSharp.dll", "GodotSharpEditor.dll"]), MAX_ASSEMBLY = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
const PACK_NAME = ".maclauncher-mono-main.pck";
const apiPath = name => /(?:^|\/)(?:GodotSharp|GodotSharpEditor)\.(?:dll|pdb|xml)$/i.test(name);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
const contained = (root, file) => file === root || file.startsWith(root + path.sep);
function regular(file, maximum) {
  const stat = fs.statSync(file);if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw Error("Godot Mono assembly exceeds its supported size.");return stat;
}
function apiBytes(item) {
  if (JSON.stringify(identity(regular(item.file, MAX_ASSEMBLY))) !== JSON.stringify(item.key)) throw Error("Godot Mono runtime changed during preparation.");
  const bytes = fs.readFileSync(item.file);
  if (bytes.toString("ascii", 0, 2) !== "MZ") throw Error("Godot Mono API assemblies are invalid. Reinstall the selected runtime.");return bytes;
}
function readMarker(file) {
  try {const stat = fs.lstatSync(file);return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384 ? JSON.parse(fs.readFileSync(file, "utf8")) : null;} catch {return null;}
}
function outputFingerprint(root) {
  const digest = crypto.createHash("sha256");let count = 0;
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      if (++count > 250000) throw Error("Godot Mono cache contains too many entries.");
      const file = path.join(directory, name), key = relative ? relative + "/" + name : name, stat = fs.lstatSync(file);
      // Godot writes this derived API hash after loading an assembly.
      if (/^\.mono\/assemblies\/(?:Debug|Release)\/api_hash_cache\.cfg$/.test(key)) continue;
      digest.update(JSON.stringify([key, stat.isSymbolicLink() ? ["link", fs.readlinkSync(file)] : stat.isDirectory() ? "directory" : identity(stat)]));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file, key);
    }
  }
  visit(root);return digest.digest("hex");
}
async function prune(directory, current, withMutation) {
  if (typeof withMutation !== "function") return;
  try {
    const rows = fs.readdirSync(directory, {withFileTypes: true}).filter(item => item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name));
    if (rows.length <= 2 || rows.length > 128) return;
    const candidates = rows.filter(item => item.name !== current).map(item => ({file: path.join(directory, item.name),
      receipt: readMarker(path.join(directory, item.name, "prepared.json"))})).filter(item => item.receipt?.schema === 2 && item.receipt.leaseManaged === true && item.receipt.key === path.basename(item.file));
    candidates.sort((a, b) => b.receipt.createdAt - a.receipt.createdAt);
    // Retain one inactive fallback. Unproven older caches and user-modified
    // working data are kept rather than being treated as disposable assets.
    for (const item of candidates.slice(1)) {
      try {
        await withMutation({managerId: "godot", version: item.receipt.version, variant: "mono", sourcePath: item.file}, () => {
          if (!fs.lstatSync(item.file).isDirectory() || fs.lstatSync(item.file).isSymbolicLink() ||
              fs.readdirSync(item.file).some(name => !["project", "prepared.json"].includes(name)) ||
              JSON.stringify(readMarker(path.join(item.file, "prepared.json"))) !== JSON.stringify(item.receipt) ||
              outputFingerprint(path.join(item.file, "project")) !== item.receipt.outputFingerprint) return;
          fs.rmSync(item.file, {recursive: true, force: true});
        });
      } catch { /* Active or uninspectable generations remain available. */ }
    }
  } catch { /* Cache retirement is optional and never prevents Play. */ }
}
function assemblyFiles(root, output, signal) {
  if (!fs.existsSync(root)) return;
  const canonical = fs.realpathSync(root);let count = 0;
  function visit(directory, relative = "", depth = 0) {
    signal?.throwIfAborted();if (depth > 8) throw Error("Godot Mono assembly folders are nested too deeply.");
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      if (++count > 4096) throw Error("Godot Mono assembly folder contains too many entries.");
      const source = path.join(directory, item.name), name = path.join(relative, item.name), actual = fs.realpathSync(source);
      if (!contained(canonical, actual) || item.isSymbolicLink()) throw Error("Godot Mono assembly links must remain regular files inside their assembly folder.");
      if (item.isDirectory()) visit(source, name, depth + 1);
      else if (/\.(?:dll|pdb|mdb|config)$/i.test(item.name) && !apiPath(item.name)) {
        const stat = regular(source, MAX_ASSEMBLY);if (!output.has(name)) output.set(name, {source, stat, key: identity(stat)});
      }
    }
  }
  visit(canonical);
}
async function prepare(entry, {target, install, variant, userDataDir, signal, withRuntimeMutation} = {}) {
  if (variant !== "mono" || !/^3\./.test(install?.version || "") || !["pack", "project"].includes(target?.kind)) return null;
  signal?.throwIfAborted();
  if (!path.isAbsolute(userDataDir || "") || !/^[\w-]+$/.test(entry?.gameId || "")) throw Error("Godot Mono preparation requires per-game storage.");
  const source = fs.realpathSync(target.path), sourceRoot = target.kind === "project" ? source : path.dirname(source);
  const apiRoot = path.join(install.appPath, "Contents/Resources/GodotSharp/Api/Debug"), api = [];
  for (const name of API) {
    const file = path.join(apiRoot, name), stat = regular(file, MAX_ASSEMBLY);api.push({name, file, key: identity(stat)});
  }
  const managed = new Map(), data = entry.moduleData || {}, packOptions = source === path.resolve(data.packPath || "") ?
    {offset: data.packOffset ?? 0, ...(data.packSize ? {size: data.packSize} : {})} : {};
  let packed = [], shadow = false, sourceIdentity;
  if (target.kind === "pack") {
    sourceIdentity = identity(fs.statSync(source));
    Pack.open(source, packOptions, (_fd, pack) => {
      if (pack.engineMajor !== 3) throw Error("Godot Mono runtime and resource pack versions do not match.");
      packed = [...pack.entries.values()].filter(item => /^\.mono\/(?:assemblies|temp\/bin)\//.test(item.name) && /\.(?:dll|pdb|mdb|config)$/i.test(item.name) && !apiPath(item.name));
      packed.sort((a, b) => Number(!/\/Debug\//.test(a.name)) - Number(!/\/Debug\//.test(b.name)));
      shadow = [...pack.entries.keys()].some(name => /^\.mono\/assemblies\/Debug\//.test(name) && apiPath(name));
    });
  }
  // Godot's editor searches Debug even when an exported game's assemblies were
  // published in Release or beside the PCK. Preserve the IL and dependencies.
  for (const folder of [".mono/temp/bin/Debug", ".mono/assemblies/Debug", ".mono/temp/bin/Release", ".mono/assemblies/Release", "GodotSharp/Assemblies"])
    assemblyFiles(path.join(sourceRoot, folder), managed, signal);
  const siblings = fs.readdirSync(sourceRoot, {withFileTypes: true});
  if (siblings.length > 4096) throw Error("Godot game folder contains too many entries to prepare Mono.");
  const title = (target.kind === "project" ? Metadata.read(source)?.name : Metadata.exported(entry)?.name) || "UnnamedProject";
  const dataName = "data_" + title.trim().replace(/[\\/:*?"<>|]/g, "-");
  const gameData = siblings.find(item => item.isDirectory() && item.name === dataName) || siblings.find(item => item.isDirectory() && item.name === "data_Godot");
  if (gameData) assemblyFiles(path.join(sourceRoot, gameData.name, "Assemblies"), managed, signal);
  const snapshot = target.kind === "project" ? await Project.inspect(source, signal, {omitDirectory: name => name === ".git" || name === ".mono"}) : null;
  const siblingInputs = target.kind === "pack" ? siblings.map(item => {const stat = fs.statSync(path.join(sourceRoot, item.name));return [item.name, stat.isFile() ? identity(stat) : [stat.dev, stat.ino]];}) : null;
  const key = hash(JSON.stringify(["godot-mono3-v2", source, sourceIdentity || snapshot.fingerprint, install.version, api.map(item => [item.name, item.key]), siblingInputs,
    [...managed].map(([name, item]) => [name, item.key])])).slice(0, 24);
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "godot"), "mono-projects", key);
  if (contained(sourceRoot, directory)) throw Error("Godot Mono storage must be outside the original game.");
  Writable.assertOwnDirectory(userDataDir, directory);
  const project = path.join(directory, "project"), marker = path.join(directory, "prepared.json"), packFile = path.join(project, PACK_NAME);
  const result = () => Object.defineProperty({target: {...target, path: target.kind === "project" ? project : shadow ? packFile : source}, cwd: project},
    "retire", {value: () => prune(path.dirname(directory), key, withRuntimeMutation)});
  function retained(receipt) {
    // The normal launcher already leases this exact Godot version through
    // process retirement. Its coordinator also guards derived-path mutations.
    // Register no synthetic runtime/section and perform no extra lease wait.
    if (typeof withRuntimeMutation === "function" && !receipt.leaseManaged) {
      try {receipt.leaseManaged = true;Writable.atomicWrite(marker, JSON.stringify(receipt), {root: userDataDir});} catch {}
    }
    signal?.throwIfAborted();return result();
  }
  try {
    const saved = readMarker(marker);
    Writable.assertOwnDirectory(userDataDir, path.join(project, ".mono/assemblies/Debug"), {create: false});
    if (saved?.schema === 2 && saved.key === key && fs.lstatSync(project).isDirectory() && !fs.lstatSync(project).isSymbolicLink() && (!shadow || fs.lstatSync(packFile).isFile())) {
      if (!saved.apiOutputs || typeof saved.apiOutputs !== "object" || Array.isArray(saved.apiOutputs)) saved.apiOutputs = {};
      let repaired = false;
      for (const item of api) {
        const file = path.join(project, ".mono/assemblies/Debug", item.name), stat = fs.lstatSync(file, {throwIfNoEntry: false});
        if (!stat?.isFile() || JSON.stringify(identity(stat)) !== JSON.stringify(saved.apiOutputs?.[item.name])) {
          signal?.throwIfAborted();Writable.atomicWrite(file, apiBytes(item), {root: userDataDir});saved.apiOutputs[item.name] = identity(fs.statSync(file));repaired = true;
        }
      }
      // Repair only runtime-owned DLLs. Keep any game-written files, and leave
      // the old tree fingerprint so repaired/modified working data is retained.
      if (repaired) {try {Writable.atomicWrite(marker, JSON.stringify(saved), {root: userDataDir});} catch {}}
      return retained(saved);
    }
  } catch {signal?.throwIfAborted();}
  const temporary = fs.mkdtempSync(path.join(directory, ".preparing-"));
  try {
    const root = path.join(temporary, "project");
    if (snapshot) await Project.copyResources(snapshot, root, signal);
    else {
      fs.mkdirSync(root);
      for (const item of siblings) {
        signal?.throwIfAborted();if ([".mono", ".git", PACK_NAME].includes(item.name.toLowerCase())) continue;
        const from = fs.realpathSync(path.join(sourceRoot, item.name)), to = path.join(root, item.name);
        if (!contained(sourceRoot, from)) throw Error("Godot Mono game links must remain inside the selected game folder.");
        const stat = fs.statSync(from);
        if (stat.isFile()) Writable.atomicCopy(from, to, {root: temporary});
        else if (stat.isDirectory()) fs.symlinkSync(from, to);
        else throw Error("Godot Mono game resources must be regular files or directories.");
      }
    }
    let total = 0;
    for (const [name, item] of managed) {
      signal?.throwIfAborted();if ((total += item.stat.size) > MAX_TOTAL) throw Error("Godot Mono assemblies exceed the preparation size limit.");
      if (JSON.stringify(identity(regular(item.source, MAX_ASSEMBLY))) !== JSON.stringify(item.key)) throw Error("Godot Mono assemblies changed during preparation.");
      const destination = path.join(root, ".mono/temp/bin/Debug", name);Writable.atomicCopy(item.source, destination, {root: temporary});
    }
    if (packed.length) Pack.open(source, packOptions, (fd, pack) => {
      for (const item of packed) {
        signal?.throwIfAborted();const name = item.name.replace(/^\.mono\/(?:assemblies|temp\/bin)\/(?:Debug|Release|ExportDebug|ExportRelease)\//, "");
        if (name === item.name || managed.has(name)) continue;
        const file = path.join(root, ".mono/temp/bin/Debug", name);if (fs.existsSync(file)) continue;
        const bytes = Pack.readEntry(fd, pack.entries.get(item.name), MAX_ASSEMBLY);
        if (!bytes || (total += bytes.length) > MAX_TOTAL) throw Error("Godot Mono packed assemblies could not be prepared.");
        Writable.atomicWrite(file, bytes, {root: temporary});
      }
    });
    for (const item of api) {
      Writable.atomicWrite(path.join(root, ".mono/assemblies/Debug", item.name), apiBytes(item), {root: temporary});
    }
    if (shadow) Pack.withoutEntries(source, path.join(root, PACK_NAME), packOptions, name => /^\.mono\/assemblies\/Debug\//.test(name) && apiPath(name), temporary);
    signal?.throwIfAborted();
    if (target.kind === "pack" && JSON.stringify(identity(fs.statSync(source))) !== JSON.stringify(sourceIdentity)) throw Error("Godot game changed during Mono preparation.");
    const existing = fs.lstatSync(project, {throwIfNoEntry: false}), preserved = path.join(directory, "preserved-" + crypto.randomBytes(8).toString("hex"));
    if (existing) fs.renameSync(project, preserved);
    try {fs.renameSync(root, project);} catch (error) {if (existing) fs.renameSync(preserved, project);throw error;}
    const receipt = {schema: 2, key, version: install.version, createdAt: Date.now(), leaseManaged: false,
      apiOutputs: Object.fromEntries(api.map(item => [item.name, identity(fs.statSync(path.join(project, ".mono/assemblies/Debug", item.name)))])), outputFingerprint: outputFingerprint(project)};
    Writable.atomicWrite(marker, JSON.stringify(receipt), {root: userDataDir});return retained(receipt);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
}
module.exports = {prepare};
