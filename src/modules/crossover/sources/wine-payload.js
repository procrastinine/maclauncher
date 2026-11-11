// Installed Wine trees are checked the same way for every downloaded source:
// a complete file inventory with digests, a native closure whose libraries
// resolve inside the tree, and a macOS floor read from the native images.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");
const MachO = require("../../shared/runtime/macho-load-commands");
const Host = require("../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const INVENTORY = "payload.json", MAXIMUM_FILES = 20000, MAXIMUM_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const later = (a, b) => Host.versionAtLeast(a, b) ? a : b;
function safeRelative(value) {
  return typeof value === "string" && value.length <= 4096 && value && !path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f\\]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}
function regularFile(root, relative, label) {
  if (!safeRelative(relative) || !path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink())
    throw new Error(`${label} requires its managed installation folder.`);
  const file = path.join(root, relative), real = fs.realpathSync(file);
  if (!inside(fs.realpathSync(root), real) || !fs.statSync(real).isFile())
    throw new Error(`A ${label} runtime file escaped its installation.`);
  return file;
}
function walk(root, signal, label = "Wine") {
  const result = [], canonicalRoot = fs.realpathSync(root);
  function visit(directory) {
    throwIfAborted(signal);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join("/");
      if ([INVENTORY, "runtime.json"].includes(relative)) continue;
      if (!safeRelative(relative) || result.length >= MAXIMUM_FILES) throw new Error(`${label} runtime files exceed their supported limits.`);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file), real = fs.realpathSync(file);
        if (path.isAbsolute(target) || !inside(canonicalRoot, real)) throw new Error(`A ${label} runtime link escaped its installation.`);
        result.push({ relative, kind: "link", target, stamp: stamp(stat) });
      } else if (stat.isDirectory()) { result.push({ relative, kind: "directory" }); visit(file); }
      else if (stat.isFile()) result.push({ relative, kind: "file", bytes: stat.size, mode: stat.mode & 0o777, stamp: stamp(stat) });
      else throw new Error(`${label} runtime files must be regular files or internal links.`);
    }
  }
  visit(root); return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
function nativeInfo(file, signal) {
  const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(4);
  try { if (fs.readSync(fd, bytes, 0, 4, 0) !== 4 || !MAGIC.has(bytes.readUInt32BE(0))) return null; }
  finally { fs.closeSync(fd); }
  return MachO.readMachOLoadCommands(file, { architecture: "x86_64", signal }).slices[0];
}
// `required` lists the native images the source needs. `skip(relative)` leaves
// out optional libraries whose closure is checked by their own consumer.
// `executableRoot` resolves @executable_path for the source's Wine loader.
function inspectClosure(root, records, signal, { label = "Wine", required = [], skip = () => false, executableRoot } = {}) {
  const images = [], canonicalRoot = fs.realpathSync(root);
  for (const record of records) {
    throwIfAborted(signal);
    if (record.kind !== "file" || skip(record.relative)) continue;
    const image = nativeInfo(path.join(root, record.relative), signal);
    if (!image) continue;
    if (image.platform !== 1 || !image.minimumMacOS || ![2, 6, 8].includes(image.fileType) || image.dyldEnvironment.length)
      throw new Error(`A ${label} native library has unsupported platform or loader requirements.`);
    images.push({ relative: record.relative, ...image });
  }
  for (const name of required) if (!images.some(image => image.relative === name))
    throw new Error(`The selected ${label} engine is missing its native Wine components.`);
  for (const image of images) {
    const file = path.join(root, image.relative);
    for (const dependency of image.dependencies) {
      if (dependency.path.startsWith("/usr/lib/") || dependency.path.startsWith("/System/Library/")) continue;
      const target = dependency.path.replace(/^@rpath\//, "");
      let candidates;
      if (dependency.path.startsWith("@loader_path/")) candidates = [path.resolve(path.dirname(file), dependency.path.slice(13))];
      else if (dependency.path.startsWith("@executable_path/")) candidates = [path.resolve(executableRoot || root, dependency.path.slice(17))];
      else if (dependency.path.startsWith("@rpath/")) candidates = records.filter(row => row.relative === target || row.relative.endsWith(`/${target}`))
        .map(row => path.join(root, row.relative));
      else throw new Error(`${label} requires an external native library: ${dependency.path}`);
      const available = candidates.filter(candidate => inside(root, candidate) && fs.existsSync(candidate) && inside(canonicalRoot, fs.realpathSync(candidate)));
      if (!available.length && dependency.kind !== "weak") throw new Error(`${label} is missing a required runtime library: ${dependency.path}`);
    }
  }
  if (!images.length) throw new Error(`The selected ${label} engine is missing its native Wine components.`);
  // The engine's macOS floor is the highest its native images declare.
  return { minimumMacOS: images.reduce((floor, image) => later(floor, image.minimumMacOS), images[0].minimumMacOS),
    nativeComponents: images.length, architectures: ["x86_64"] };
}
async function hashAsync(file, signal, label = "Wine") {
  throwIfAborted(signal);
  const before = fs.statSync(file), hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file, { ...(signal ? { signal } : {}), highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) { throwIfAborted(signal); hash.update(chunk); }
  if (stamp(before) !== stamp(fs.statSync(file))) throw new Error(`${label} runtime files changed during installation.`);
  return hash.digest("hex");
}
// Digests every file and writes the inventory that later status checks use.
async function writeInventory(root, records, signal, label = "Wine") {
  for (const record of records) if (record.kind === "file") record.sha256 = await hashAsync(path.join(root, record.relative), signal, label);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: records }));
  if (bytes.length > MAXIMUM_INVENTORY_BYTES) throw new Error(`${label} runtime metadata exceeds its supported size.`);
  await fs.promises.writeFile(path.join(root, INVENTORY), bytes);
  return { relativePath: INVENTORY, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), count: records.length };
}
// Strings a Wine binary names, read without running it: synchronization
// support from wineserver and CrossOver graphics selectors from the loader.
function mentions(file, names) {
  try {
    if (fs.statSync(file).size > 64 * 1024 * 1024) return {};
    const bytes = fs.readFileSync(file);
    return Object.fromEntries(names.map(name => [name, bytes.includes(Buffer.from(name))]));
  } catch { return {}; }
}
function wineCapabilities(wineRoot) {
  const server = mentions(path.join(wineRoot, "bin", "wineserver"), ["WINEMSYNC", "WINEESYNC"]);
  const unix = path.join(wineRoot, "lib", "wine", "x86_64-unix");
  const loader = mentions(path.join(unix, "ntdll.so"), ["CX_GRAPHICS_BACKEND", "CX_APPLEGPTK_LIBD3DSHARED_PATH"]);
  const graphics = { ...mentions(path.join(unix, "winevulkan.so"), ["CX_LIBVULKAN"]),
    ...Object.fromEntries(Object.entries(mentions(path.join(unix, "win32u.so"), ["CX_LIBVULKAN", "D3DM_VENDOR_ID"])).filter(([, value]) => value)) };
  return { msync: server.WINEMSYNC === true, esync: server.WINEESYNC === true,
    graphicsSelector: loader.CX_GRAPHICS_BACKEND === true, vulkanLibrarySelector: graphics.CX_LIBVULKAN === true,
    d3dMetalBridge: loader.CX_APPLEGPTK_LIBD3DSHARED_PATH === true, adapterIdentity: graphics.D3DM_VENDOR_ID === true };
}
// The Wine version a tree reports, from the version text its ntdll carries.
function wineVersion(wineRoot) {
  try {
    const file = path.join(wineRoot, "lib", "wine", "x86_64-unix", "ntdll.so");
    if (fs.statSync(file).size > 64 * 1024 * 1024) return "";
    return /wine-(\d+\.\d+(?:\.\d+)?(?:-rc\d+)?)\0/.exec(fs.readFileSync(file).toString("latin1"))?.[1] || "";
  } catch { return ""; }
}
// Checks an installed tree against its inventory. `verification: "status"`
// reads only the files named in `important`.
function createInventoryCheck({ label = "Wine", systemVersionSync = Host.systemVersionSync } = {}) {
  const inventories = new Map(), checked = new Map();
  return function check(installDir, seal, { verification = "full", signal, important = new Set(), minimumMacOS } = {}) {
    if (seal?.relativePath !== INVENTORY || !/^[a-f0-9]{64}$/.test(seal.sha256 || "") ||
      !Number.isSafeInteger(seal.bytes) || seal.bytes < 1 || seal.bytes > MAXIMUM_INVENTORY_BYTES ||
      !Number.isSafeInteger(seal.count) || seal.count < 1 || seal.count > MAXIMUM_FILES)
      throw new Error(`${label} registration is incomplete. Remove and install this version again.`);
    const file = regularFile(installDir, INVENTORY, label), stat = fs.statSync(file), key = `${file}:${stamp(stat)}:${seal.sha256}`;
    if (stat.size !== seal.bytes) throw new Error(`${label} runtime metadata changed. Remove and install this version again.`);
    let inventory = inventories.get(key);
    if (!inventory) {
      const bytes = fs.readFileSync(file);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== seal.sha256)
        throw new Error(`${label} runtime metadata changed. Remove and install this version again.`);
      inventory = JSON.parse(bytes);
      if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || inventory.files.length !== seal.count ||
        inventory.files.some(row => !safeRelative(row.relative) || !["directory", "file", "link"].includes(row.kind) ||
          row.kind === "file" && (!/^[a-f0-9]{64}$/.test(row.sha256 || "") || !Number.isSafeInteger(row.bytes) || row.bytes < 0)))
        throw new Error(`${label} runtime metadata is invalid. Remove and install this version again.`);
      if (inventories.size >= 64) inventories.delete(inventories.keys().next().value);
      inventories.set(key, inventory);
    }
    const observed = verification === "status" ? null : walk(installDir, signal, label);
    if (observed && JSON.stringify(observed.map(row => [row.relative, row.kind])) !== JSON.stringify(inventory.files.map(row => [row.relative, row.kind])))
      throw new Error(`${label} runtime files changed. Remove and install this version again.`);
    for (const row of inventory.files) {
      if (verification === "status" && !important.has(row.relative)) continue;
      throwIfAborted(signal);
      const target = path.join(installDir, row.relative), current = fs.lstatSync(target);
      if (row.kind === "directory") { if (!current.isDirectory() || current.isSymbolicLink()) throw new Error(`${label} runtime directories changed.`); continue; }
      if (row.kind === "link") {
        if (!current.isSymbolicLink() || fs.readlinkSync(target) !== row.target || !inside(fs.realpathSync(installDir), fs.realpathSync(target)))
          throw new Error(`${label} runtime links changed.`);
        continue;
      }
      if (!current.isFile() || current.isSymbolicLink() || current.size !== row.bytes || (current.mode & 0o777) !== row.mode)
        throw new Error(`${label} runtime files changed. Remove and install this version again.`);
      const currentStamp = stamp(current), checkKey = `${target}:${currentStamp}:${row.sha256}`;
      if (currentStamp !== row.stamp && !checked.has(checkKey)) {
        if (Native.hashFile(target) !== row.sha256) throw new Error(`${label} runtime files changed. Remove and install this version again.`);
        if (checked.size >= MAXIMUM_FILES) checked.clear(); checked.set(checkKey, true);
      }
    }
    if (minimumMacOS && !Host.versionAtLeast(systemVersionSync(), minimumMacOS))
      return { supported: false, reason: requiresMacOS(minimumMacOS) };
    return { supported: true };
  };
}

// The one wording for a floor the running macOS does not meet, the same as
// the stable platform requirements use.
const requiresMacOS = version => `Requires macOS ${String(version).replace(/(?:\.0)+$/, "")} or later.`;
module.exports = { INVENTORY, MAXIMUM_FILES, MAXIMUM_INVENTORY_BYTES, safeRelative, regularFile, walk, nativeInfo, inspectClosure,
  hashAsync, writeInventory, mentions, wineCapabilities, wineVersion, createInventoryCheck, requiresMacOS, later, inside, stamp };
