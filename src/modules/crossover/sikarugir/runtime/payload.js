const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../../shared/runtime/local-native");
const MachO = require("../../../shared/runtime/macho-load-commands");
const Host = require("../../../shared/runtime/bundled-native");
const { downloadToFile, throwIfAborted } = require("../../../shared/runtime/download-utils");
const { extractArchive } = require("./archive");
const Catalog = require("./catalog");

const WINE_ROOT = "wswine.bundle", SUPPORT_ROOT = "support", INVENTORY = "payload.json";
const MAXIMUM_FILES = 20000, MAXIMUM_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const later = (a, b) => Host.versionAtLeast(a, b) ? a : b;
function safeRelative(value) {
  return typeof value === "string" && value.length <= 4096 && value && !path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f\\]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
}
function regularFile(root, relative) {
  if (!safeRelative(relative) || !path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink())
    throw new Error("Sikarugir requires its managed installation folder.");
  const file = path.join(root, relative), real = fs.realpathSync(file);
  if (!inside(fs.realpathSync(root), real) || !fs.statSync(real).isFile())
    throw new Error("A Sikarugir runtime file escaped its installation.");
  return file;
}
function walk(root, signal) {
  const result = [], canonicalRoot = fs.realpathSync(root);
  function visit(directory) {
    throwIfAborted(signal);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join("/");
      if ([INVENTORY, "runtime.json"].includes(relative)) continue;
      if (!safeRelative(relative) || result.length >= MAXIMUM_FILES) throw new Error("Sikarugir runtime files exceed their supported limits.");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file), real = fs.realpathSync(file);
        if (path.isAbsolute(target) || !inside(canonicalRoot, real)) throw new Error("A Sikarugir runtime link escaped its installation.");
        result.push({ relative, kind: "link", target, stamp: stamp(stat) });
      } else if (stat.isDirectory()) { result.push({ relative, kind: "directory" }); visit(file); }
      else if (stat.isFile()) result.push({ relative, kind: "file", bytes: stat.size, mode: stat.mode & 0o777, stamp: stamp(stat) });
      else throw new Error("Sikarugir runtime files must be regular files or internal links.");
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
function inspectClosure(root, records, signal) {
  const images = [], canonicalRoot = fs.realpathSync(root);
  for (const record of records) {
    throwIfAborted(signal);
    if (record.kind !== "file" || record.relative.startsWith(`${SUPPORT_ROOT}/Frameworks/renderer/`) ||
      record.relative === `${SUPPORT_ROOT}/Frameworks/libvulkan_kosmickrisp.dylib`) continue;
    const image = nativeInfo(path.join(root, record.relative), signal);
    if (!image) continue;
    if (image.platform !== 1 || !image.minimumMacOS || ![2, 6, 8].includes(image.fileType) || image.dyldEnvironment.length)
      throw new Error("A Sikarugir native library has unsupported platform or loader requirements.");
    images.push({ relative: record.relative, ...image });
  }
  for (const required of [`${WINE_ROOT}/bin/wine`, `${WINE_ROOT}/bin/wineserver`,
    `${WINE_ROOT}/lib/wine/x86_64-unix/ntdll.so`, `${WINE_ROOT}/lib/wine/x86_64-unix/winemac.so`]) {
    if (!images.some(image => image.relative === required)) throw new Error("The selected Sikarugir engine is missing its native Wine components.");
  }
  for (const image of images) {
    const file = path.join(root, image.relative);
    for (const dependency of image.dependencies) {
      if (dependency.path.startsWith("/usr/lib/") || dependency.path.startsWith("/System/Library/")) continue;
      const target = dependency.path.replace(/^@rpath\//, "");
      let candidates;
      if (dependency.path.startsWith("@loader_path/")) candidates = [path.resolve(path.dirname(file), dependency.path.slice(13))];
      else if (dependency.path.startsWith("@executable_path/")) candidates = [path.resolve(root, WINE_ROOT, "bin", dependency.path.slice(17))];
      else if (dependency.path.startsWith("@rpath/")) candidates = records.filter(row => row.relative === target || row.relative.endsWith(`/${target}`))
        .map(row => path.join(root, row.relative));
      else throw new Error(`Sikarugir requires an external native library: ${dependency.path}`);
      const available = candidates.filter(candidate => inside(root, candidate) && fs.existsSync(candidate) && inside(canonicalRoot, fs.realpathSync(candidate)));
      if (!available.length && dependency.kind !== "weak") throw new Error(`Sikarugir is missing a required runtime library: ${dependency.path}`);
    }
  }
  return { minimumMacOS: images.reduce((floor, image) => later(floor, image.minimumMacOS), "14.0.0"),
    nativeComponents: images.length, architectures: ["x86_64"] };
}
async function hashAsync(file, signal) {
  throwIfAborted(signal);
  const before = fs.statSync(file), hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(file, { ...(signal ? { signal } : {}), highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) { throwIfAborted(signal); hash.update(chunk); }
  if (stamp(before) !== stamp(fs.statSync(file))) throw new Error("Sikarugir runtime files changed during installation.");
  return hash.digest("hex");
}
async function preparePayload({ unpacked, pin, signal, logger, onProgress }, dependencies = {}) {
  throwIfAborted(signal);
  const template = pin.template;
  if (!Catalog.validateEntry(pin))
    throw new Error("Sikarugir requires an identified matching support archive.");
  const scratch = await fs.promises.mkdtemp(path.join(path.dirname(unpacked), ".support-"));
  const stageProgress = (detail, downloaded = pin.downloadBytes) => onProgress?.({
    downloaded, total: pin.downloadBytes, detail: `${pin.versionLabel} · ${detail}`
  });
  let graphics;
  try {
    const archive = path.join(scratch, template.asset.filename);
    logger?.info?.(`[sikarugir] acquiring support ${template.version}`);
    stageProgress("Downloading support libraries…", pin.asset.bytes);
    await (dependencies.downloadToFile || downloadToFile)(template.asset.url, archive, { signal,
      onProgress: progress => onProgress?.({ ...progress, downloaded: pin.asset.bytes + progress.downloaded,
        total: pin.asset.bytes + template.asset.bytes, detail: `${pin.versionLabel} · Downloading support libraries…` }) });
    throwIfAborted(signal);
    stageProgress("Verifying support archive…");
    if (fs.statSync(archive).size !== template.asset.bytes || await hashAsync(archive, signal) !== template.asset.sha256)
      throw new Error("Sikarugir support archive does not match the selected checksum. No runtime was installed.");
    const templateUnpacked = path.join(scratch, "unpacked"); await fs.promises.mkdir(templateUnpacked);
    stageProgress("Extracting support libraries…");
    await (dependencies.extractArchive || extractArchive)(archive, templateUnpacked, signal);
    const templateRoot = path.join(templateUnpacked, `Template-${template.version}.app`, "Contents");
    stageProgress("Preparing graphics libraries…");
    graphics = await (dependencies.stageTemplateClosure || require("../graphics").stageTemplateClosure)({
      templateRoot, destinationRoot: path.join(unpacked, SUPPORT_ROOT), signal });
  } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
  throwIfAborted(signal);
  stageProgress("Checking installed files…");
  const records = walk(unpacked, signal), native = inspectClosure(unpacked, records, signal);
  const minimumMacOS = later(native.minimumMacOS, graphics.minimumBaseMacOS || "14.0.0");
  const hostVersion = (dependencies.systemVersionSync || Host.systemVersionSync)();
  if (!Host.versionAtLeast(hostVersion, minimumMacOS)) throw new Error(`This Sikarugir engine requires macOS ${minimumMacOS}.`);
  for (const record of records) if (record.kind === "file") {
    record.sha256 = await hashAsync(path.join(unpacked, record.relative), signal);
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: records }));
  if (bytes.length > MAXIMUM_INVENTORY_BYTES) throw new Error("Sikarugir runtime metadata exceeds its supported size.");
  await fs.promises.writeFile(path.join(unpacked, INVENTORY), bytes);
  const server = regularFile(unpacked, `${WINE_ROOT}/bin/wineserver`);
  if (fs.statSync(server).size > 32 * 1024 * 1024) throw new Error("Sikarugir server metadata exceeds its supported size.");
  const serverBytes = fs.readFileSync(server);
  const capabilities = { msync: serverBytes.includes(Buffer.from("WINEMSYNC")), esync: serverBytes.includes(Buffer.from("WINEESYNC")) };
  return { schemaVersion: 1, engineVersion: pin.engineVersion, wineRoot: WINE_ROOT, supportRoot: SUPPORT_ROOT,
    inventory: { relativePath: INVENTORY, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), count: records.length },
    minimumMacOS, architectures: native.architectures, nativeComponents: native.nativeComponents, capabilities,
    template: { version: template.version, archiveSha256: template.asset.sha256, assetUrl: template.asset.url },
    graphics: { minimumBaseMacOS: graphics.minimumBaseMacOS, graphicsCapabilities: graphics.graphicsCapabilities,
      componentVersions: graphics.componentVersions, relativePaths: graphics.relativePaths } };
}

function createPayloadResolver({ systemVersionSync = Host.systemVersionSync } = {}) {
  const inventories = new Map(), checked = new Map();
  return function resolvePayload(install, { verification = "full", signal } = {}) {
    if (!install) return { install: null, reason: "Sikarugir Wine is not installed." };
    try {
      throwIfAborted(signal);
      const evidence = install.installationMetadata, seal = evidence?.inventory;
      if (evidence?.schemaVersion !== 1 || evidence.wineRoot !== WINE_ROOT || evidence.supportRoot !== SUPPORT_ROOT ||
        seal?.relativePath !== INVENTORY || !/^[a-f0-9]{64}$/.test(seal.sha256 || "") ||
        !Number.isSafeInteger(seal.bytes) || seal.bytes < 1 || seal.bytes > MAXIMUM_INVENTORY_BYTES ||
        !Number.isSafeInteger(seal.count) || seal.count < 1 || seal.count > MAXIMUM_FILES)
        throw new Error("Sikarugir registration is incomplete. Remove and install this version again.");
      const file = regularFile(install.installDir, INVENTORY), stat = fs.statSync(file), key = `${file}:${stamp(stat)}:${seal.sha256}`;
      if (stat.size !== seal.bytes) throw new Error("Sikarugir runtime metadata changed. Remove and install this version again.");
      let inventory = inventories.get(key);
      if (!inventory) {
        const bytes = fs.readFileSync(file);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== seal.sha256)
          throw new Error("Sikarugir runtime metadata changed. Remove and install this version again.");
        inventory = JSON.parse(bytes);
        if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || inventory.files.length !== seal.count ||
          inventory.files.some(row => !safeRelative(row.relative) || !["directory", "file", "link"].includes(row.kind) ||
            row.kind === "file" && (!/^[a-f0-9]{64}$/.test(row.sha256 || "") || !Number.isSafeInteger(row.bytes) || row.bytes < 0)))
          throw new Error("Sikarugir runtime metadata is invalid. Remove and install this version again.");
        if (inventories.size >= 64) inventories.delete(inventories.keys().next().value);
        inventories.set(key, inventory);
      }
      const important = new Set([`${WINE_ROOT}/bin/wine`, `${WINE_ROOT}/bin/wineserver`, `${WINE_ROOT}/lib/wine/x86_64-unix/ntdll.so`, `${SUPPORT_ROOT}/graphics.json`]);
      const observed = verification === "status" ? null : walk(install.installDir, signal);
      if (observed && JSON.stringify(observed.map(row => [row.relative, row.kind])) !== JSON.stringify(inventory.files.map(row => [row.relative, row.kind])))
        throw new Error("Sikarugir runtime files changed. Remove and install this version again.");
      for (const row of inventory.files) {
        if (verification === "status" && !important.has(row.relative)) continue;
        throwIfAborted(signal);
        const target = path.join(install.installDir, row.relative), current = fs.lstatSync(target);
        if (row.kind === "directory") { if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("Sikarugir runtime directories changed."); continue; }
        if (row.kind === "link") {
          if (!current.isSymbolicLink() || fs.readlinkSync(target) !== row.target || !inside(fs.realpathSync(install.installDir), fs.realpathSync(target)))
            throw new Error("Sikarugir runtime links changed.");
          continue;
        }
        if (!current.isFile() || current.isSymbolicLink() || current.size !== row.bytes || (current.mode & 0o777) !== row.mode)
          throw new Error("Sikarugir runtime files changed. Remove and install this version again.");
        const currentStamp = stamp(current), checkKey = `${target}:${currentStamp}:${row.sha256}`;
        if (currentStamp !== row.stamp && !checked.has(checkKey)) {
          if (Native.hashFile(target) !== row.sha256) throw new Error("Sikarugir runtime files changed. Remove and install this version again.");
          if (checked.size >= MAXIMUM_FILES) checked.clear(); checked.set(checkKey, true);
        }
      }
      if (!Host.versionAtLeast(systemVersionSync(), evidence.minimumMacOS))
        return { install: null, reason: `This Sikarugir engine requires macOS ${evidence.minimumMacOS}.`, minimumMacOS: evidence.minimumMacOS };
      const wineRoot = path.join(install.installDir, WINE_ROOT), templateRoot = path.join(install.installDir, SUPPORT_ROOT);
      return { install: { ...install, wineRoot, engineRoot: wineRoot, executablePath: path.join(wineRoot, "bin", "wine"),
        serverPath: path.join(wineRoot, "bin", "wineserver"), templateRoot, supportRoot: templateRoot,
        frameworksRoot: path.join(templateRoot, "Frameworks"), runtimeLibraries: templateRoot,
        capabilities: evidence.capabilities, graphicsCapabilities: evidence.graphics?.graphicsCapabilities,
        graphicsMetadata: evidence.graphics, minimumMacOS: evidence.minimumMacOS, engineVersion: evidence.engineVersion },
        reason: null, minimumMacOS: evidence.minimumMacOS };
    } catch (error) { if (error.name === "AbortError") throw error; return { install: null, reason: error.message }; }
  };
}

module.exports = { WINE_ROOT, SUPPORT_ROOT, INVENTORY, walk, inspectClosure, hashAsync, preparePayload, createPayloadResolver };
