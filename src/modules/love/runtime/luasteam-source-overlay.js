const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const INPUTS = require("./luasteam-source-inputs.json");

const VERSION = "luasteam-4.0.2-ml1-lua51-universal-content1";
const SOURCE_REVISION = "fbb72bd22c0c526f4276800024967323acd9d10d";
const LUA_HEADERS_REVISION = "45b771bb2c693a4cc7e34e79b7d30ab10bb7776a";
const SDK_HEADERS_REVISION = "494c2d680b9e47bbc369496b57568f44ef2f6796";
const SDK_VERSION = "1.63";
const HOST_LUA_ABI = "Lua 5.1 C API";

const within = (root, file) => file === root || file.startsWith(root + path.sep);
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function canonicalDestination(directory) {
  let parent = path.resolve(directory), tail = [];
  while (!fs.existsSync(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error("The LuaSteam build directory has no existing parent.");
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...tail);
}

/** Stage reviewed sources and headers only. A second Lua VM is never linked. */
function stageSource({ roots, destination, inputs = INPUTS } = {}) {
  if (!path.isAbsolute(destination || "") || !roots || !Array.isArray(inputs) || !inputs.length || inputs.length > 512)
    throw new Error("Explicit source roots and a fresh absolute LuaSteam build directory are required.");
  destination = canonicalDestination(destination);
  const sourceRoots = {};
  for (const [id, directory] of Object.entries(roots)) {
    if (!path.isAbsolute(directory || "")) throw new Error("LuaSteam source roots must be absolute.");
    sourceRoots[id] = fs.realpathSync(directory);
    if (!fs.statSync(sourceRoots[id]).isDirectory() || within(sourceRoots[id], destination) || within(destination, sourceRoots[id]))
      throw new Error("LuaSteam build output must be separate from its read-only source.");
  }
  fs.mkdirSync(destination, { recursive: true });
  if (!fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)
    throw new Error("LuaSteam source staging requires a new empty directory.");
  const outputPaths = new Set(), records = [];
  for (const input of inputs) {
    const root = sourceRoots[input.origin];
    const safe = value => typeof value === "string" && value && !path.isAbsolute(value) &&
      !value.split(/[\\/]/).some(part => part === ".." || part === ".git" || !part);
    if (!root || !safe(input.path) || !safe(input.destination) || outputPaths.has(input.destination) ||
        !/^[a-f0-9]{64}$/.test(input.sha256 || "") || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > 1024 * 1024)
      throw new Error("Invalid pinned LuaSteam source input.");
    outputPaths.add(input.destination);
    const file = path.join(root, input.path), stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !within(root, fs.realpathSync(file)) || stat.size !== BigInt(input.size))
      throw new Error(`LuaSteam source input changed: ${input.path}`);
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => stat[key] !== after[key]) || sha256(bytes) !== input.sha256)
      throw new Error(`LuaSteam source input changed: ${input.path}`);
    const target = path.join(destination, input.destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    records.push({ ...input });
  }
  return { version: VERSION, sourceRevision: SOURCE_REVISION, luaHeadersRevision: LUA_HEADERS_REVISION,
    sdkHeadersRevision: SDK_HEADERS_REVISION, sdkVersion: SDK_VERSION, hostLuaAbi: HOST_LUA_ABI,
    sourceTreeSha256: sha256(JSON.stringify(records)), files: records };
}

function compilerArguments({ sourceRoot, architecture, steamLibraryPath, outputPath } = {}) {
  if (!["arm64", "x86_64"].includes(architecture) ||
      [sourceRoot, steamLibraryPath, outputPath].some(value => !path.isAbsolute(value || "")))
    throw new Error("LuaSteam compilation requires explicit architecture and absolute input/output paths.");
  const sources = INPUTS.filter(input => input.origin === "luasteam" && input.destination.endsWith(".cpp"))
    .map(input => path.join(sourceRoot, input.destination));
  // Undefined Lua C functions bind to the selected LÖVE host. Linking a static
  // LuaJIT library here creates an incompatible second VM sharing its state.
  return ["-std=c++17", "-O2", "-fPIC", "-shared", "-arch", architecture,
    "-mmacosx-version-min=13.0", "-I", path.join(sourceRoot, "lua-headers"), ...sources,
    steamLibraryPath, "-Wl,-undefined,dynamic_lookup", "-Wl,-exported_symbol,_luaopen_luasteam",
    "-Wl,-headerpad_max_install_names", "-Wl,-install_name,@loader_path/luasteam.so", "-o", outputPath];
}

module.exports = { VERSION, SOURCE_REVISION, LUA_HEADERS_REVISION, SDK_HEADERS_REVISION, SDK_VERSION, HOST_LUA_ABI,
  stageSource, compilerArguments, sha256, INPUTS };
