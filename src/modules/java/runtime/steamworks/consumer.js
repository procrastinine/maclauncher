const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const Zip = require("../../../shared/runtime/zip");
const AppId = require("../../../shared/runtime/steamworks/app-id");
const Observations = require("../../../../core/file-observations");
const { PREFIX, inspectClass } = require("./class-file");
const Catalog = require("./versions.json");

const LIMITS = Object.freeze({ archives: 24, entries: 20000, classes: 8192,
  classBytes: 1024 * 1024, manifestBytes: 64 * 1024, directoryBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024 });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const catalogIdentity = hash(JSON.stringify(Catalog));
const qualifiedClasses = new Set(["SteamAPI", "SteamApps", "SteamFriends", "SteamUtils", "SteamUser", "SteamUserStats",
  "SteamAPICall", "SteamID", "SteamInterface", "SteamNativeHandle", "SteamResult", "SteamException", "Version",
  "SteamLibraryLoader", "SteamSharedLibraryLoader"]);
const failure = (code, message) => Object.assign(new Error(message), { code });
const within = (root, file) => { const relative = path.relative(root, file); return !relative ||
  relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const identity = file => {
  // Reused facts still participate in the host's metadata observations.
  // Observations.identity deliberately uses unwrapped fs methods itself.
  try { fs.lstatSync(file); } catch { }
  return Observations.identity(file);
};

function readEntry(fd, entry, maximum, budget) {
  const size = entry.uncompressedSize, compressedSize = entry.compressedSize;
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum || compressedSize > maximum * 2 ||
      budget.bytes + size > LIMITS.totalBytes) throw failure("JAVA_STEAM_PROBE_LIMIT", "Java Steam inspection exceeded its supported bounds.");
  const header = Buffer.alloc(30), offset = entry.absoluteLocalHeaderOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || fs.readSync(fd, header, 0, 30, offset) !== 30 ||
      header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) & 1)
    throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Invalid Java archive entry.");
  const method = header.readUInt16LE(8), dataOffset = offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataOffset + compressedSize > fs.fstatSync(fd).size) throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Truncated Java archive entry.");
  const compressed = Buffer.alloc(compressedSize);
  if (fs.readSync(fd, compressed, 0, compressedSize, dataOffset) !== compressedSize)
    throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Truncated Java archive entry.");
  let bytes;
  try { bytes = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: maximum }) : null; }
  catch { throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Invalid compressed Java archive entry."); }
  if (!bytes || bytes.length !== size) throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Invalid Java archive entry size or compression.");
  budget.bytes += bytes.length;
  return bytes;
}
function manifestValues(bytes) {
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\n /g, "");
  const result = {};
  for (const line of text.split("\n")) {
    if (!line) break; // Named entry sections do not change launch Class-Path.
    const colon = line.indexOf(":");
    if (colon > 0) result[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return result;
}
function readArchive(file) {
  const fd = fs.openSync(file, "r");
  try {
    const info = Zip.findZipEocd(fd);
    if (!info) return null;
    const start = info.zipBase + info.cdOffset;
    if (info.cdSize > LIMITS.directoryBytes || info.entries > LIMITS.entries)
      throw failure("JAVA_STEAM_PROBE_LIMIT", "Java archive directory exceeds supported bounds.");
    if (info.zipBase < 0 || info.cdOffset < 0 || info.cdSize < 0 || start < 0 || start + info.cdSize > info.eocdOffset)
      throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Invalid Java archive directory.");
    return { info, entries: Zip.readCentralDirectory(fd, info) };
  } finally { fs.closeSync(fd); }
}

/** Inspect executable calls and exact wrapper classes without loading Java. */
function inspectArchives(jarPath, gameRoot, { catalog = Catalog } = {}) {
  gameRoot = fs.realpathSync(gameRoot);
  const archives = [], calls = [], literalAppIds = [], wrapperClasses = new Map(), errors = [];
  const queue = [jarPath], budget = { bytes: 0, classes: 0 };
  try { while (queue.length) {
    const requested = queue.shift();
    let real;
    try { real = fs.realpathSync(requested); } catch (error) { archives.push({ path: requested, identity: identity(requested) }); throw error; }
    if (!within(gameRoot, real)) throw failure("JAVA_STEAM_CLASSPATH_INVALID", "Java Steam dependencies must stay inside the original game directory.");
    if (archives.some(item => item.path === real)) continue;
    if (archives.length >= LIMITS.archives) throw failure("JAVA_STEAM_PROBE_LIMIT", "Java Steam inspection has too many classpath archives.");
    const before = identity(real), stat = fs.statSync(real);
    if (!stat.isFile()) throw failure("JAVA_STEAM_CLASSPATH_INVALID", "The Java classpath contains an invalid archive.");
    const archive = readArchive(real);
    archives.push({ path: real, identity: before });
    if (!archive) continue;
    if (archive.info.cdSize > LIMITS.directoryBytes || archive.entries.length > LIMITS.entries ||
        archive.entries.length !== archive.info.entries) throw failure("JAVA_STEAM_PROBE_LIMIT", "Java archive directory exceeds supported bounds.");
    const names = new Set();
    for (const entry of archive.entries) {
      if (names.has(entry.name)) throw failure("JAVA_STEAM_ARCHIVE_INVALID", "Java archive contains a duplicate entry.");
      names.add(entry.name);
    }
    const fd = fs.openSync(real, "r");
    try {
      let classpath = null;
      const manifestEntry = archive.entries.find(item => item.name === "META-INF/MANIFEST.MF");
      if (manifestEntry) {
        const manifest = manifestValues(readEntry(fd, manifestEntry, LIMITS.manifestBytes, budget));
        classpath = manifest["class-path"];
      }
      for (const entry of archive.entries) {
        if (!entry.name.endsWith(".class") || entry.name.startsWith("META-INF/versions/")) continue;
        if (++budget.classes > LIMITS.classes) throw failure("JAVA_STEAM_PROBE_LIMIT", "Java Steam inspection has too many classes.");
        const bytes = readEntry(fd, entry, LIMITS.classBytes, budget);
        if (entry.name.startsWith(PREFIX)) {
          if (wrapperClasses.has(entry.name)) throw failure("JAVA_STEAM_VERSION_CONFLICT", "Several Java dependencies supply the Steam wrapper.");
          wrapperClasses.set(entry.name, hash(bytes));
        } else {
          try {
            const inspected = inspectClass(bytes);
            if (inspected.name + ".class" !== entry.name) throw failure("JAVA_STEAM_CLASS_INVALID", "Java class name differs from its archive path.");
            calls.push(...inspected.calls.map(call => ({ ...call, className: inspected.name, archivePath: real })));
            literalAppIds.push(...inspected.appIds.map(item => ({ ...item, archivePath: real })));
          } catch (error) { errors.push({ entry: entry.name, archivePath: real, code: error.code, message: error.message }); }
        }
      }
      if (classpath) for (const item of classpath.split(/\s+/)) {
          if (!item || /^[a-z][a-z0-9+.-]*:/i.test(item) || item.includes("\\") || item.startsWith("/"))
            throw failure("JAVA_STEAM_CLASSPATH_INVALID", "Java Steam inspection supports local game classpaths only.");
          let decoded;
          try { decoded = decodeURIComponent(item); } catch { throw failure("JAVA_STEAM_CLASSPATH_INVALID", "Invalid Java classpath URL."); }
          const target = path.resolve(path.dirname(real), decoded);
          if (!within(gameRoot, target) || !target.endsWith(".jar"))
            throw failure("JAVA_STEAM_CLASSPATH_INVALID", "Java Steam dependencies must be game-local JARs.");
          queue.push(target);
        }
    } finally { fs.closeSync(fd); }
    if (JSON.stringify(before) !== JSON.stringify(identity(real))) throw failure("JAVA_STEAM_SOURCE_CHANGED", "The original Java archive changed during inspection.");
  } } catch (error) {
    error.required = calls.some(call => call.owner !== PREFIX + "Version");
    error.archives = archives;
    throw error;
  }
  const matching = catalog.filter(pin => Object.keys(pin.classes).length === wrapperClasses.size &&
    Object.entries(pin.classes).every(([name, sha256]) => wrapperClasses.get(name) === sha256));
  const required = calls.some(call => call.owner !== PREFIX + "Version");
  const pin = matching.length === 1 ? matching[0] : null;
  const unsupportedCalls = calls.filter(call => !qualifiedClasses.has(call.owner.slice(PREFIX.length).split("$")[0]));
  return { required, pin, archives, calls, literalAppIds, unsupportedCalls, errors, bytesRead: budget.bytes,
    classesRead: budget.classes, wrapperClassCount: wrapperClasses.size };
}

function source(entry) {
  const jarPath = entry?.moduleData?.jarPath || entry?.gamePath;
  if (!path.isAbsolute(jarPath || "") || !fs.existsSync(jarPath)) return null;
  const gameRoot = fs.realpathSync(entry?.contentRootDir || path.dirname(jarPath));
  return { jarPath: fs.realpathSync(jarPath), gameRoot };
}
function current(evidence, location, selectedCatalogIdentity) {
  return evidence?.schemaVersion === 1 && evidence.catalogIdentity === selectedCatalogIdentity && evidence.jarPath === location.jarPath &&
    evidence.gameRoot === location.gameRoot && Array.isArray(evidence.observed) && evidence.observed.length > 0 &&
    evidence.observed.every(item => JSON.stringify(identity(item.path)) === JSON.stringify(item.identity));
}
function inspect(entry, { catalog = Catalog } = {}) {
  const location = source(entry);
  if (!location) return null;
  const previous = entry?.moduleData?.javaSteamEvidence;
  const selectedCatalogIdentity = catalog === Catalog ? catalogIdentity : hash(JSON.stringify(catalog));
  if (current(previous, location, selectedCatalogIdentity)) return previous;
  const metadata = ["steam_appid.txt", "steam_settings/steam_appid.txt", "SmartSteamEmu.ini", "steam_api.ini", "steam_settings/configs.app.ini"]
    .map(name => path.join(location.gameRoot, name));
  let inspected;
  try { inspected = inspectArchives(location.jarPath, location.gameRoot, { catalog }); }
  catch (error) { inspected = { required: Boolean(error.required), pin: null, archives: error.archives?.length ? error.archives : [{ path: location.jarPath, identity: identity(location.jarPath) }],
    calls: [], literalAppIds: [], unsupportedCalls: [], errors: [{ code: error.code, message: error.message }], incomplete: true }; }
  const appId = inspected.required ? AppId.readGameAppId({ gameRoot: location.gameRoot }) : { value: null, status: "missing", evidence: [], errors: [] };
  const ids = [...new Set([...appId.evidence.map(item => item.value), ...inspected.literalAppIds.map(item => item.value)])];
  const identityStatus = ids.length > 1 ? "conflict" : ids.length === 1 ? "found" : appId.status;
  const result = { schemaVersion: 1, catalogIdentity: selectedCatalogIdentity, ...location, required: inspected.required,
    version: inspected.pin?.version || null, bridgeVersion: inspected.pin?.bridgeVersion || null,
    abiProfile: inspected.pin?.abiProfile || null, architectures: inspected.pin?.architectures || [],
    appId: { value: ids.length === 1 ? ids[0] : null, status: identityStatus,
      evidence: [...appId.evidence, ...inspected.literalAppIds.map(item => ({ ...item, kind: "java-restart-app-literal" }))], errors: appId.errors },
    calls: inspected.calls, unsupportedCalls: inspected.unsupportedCalls, errors: inspected.errors,
    incomplete: Boolean(inspected.incomplete), bytesRead: inspected.bytesRead || 0, classesRead: inspected.classesRead || 0,
    observed: [...inspected.archives, ...metadata.map(file => ({ path: file, identity: identity(file) }))] };
  entry.moduleData = { ...entry.moduleData, javaSteamEvidence: result };
  return result;
}

function requirement(entry, { catalog = Catalog } = {}) {
  const evidence = inspect(entry, { catalog });
  if (!evidence?.required) return null;
  if (evidence.incomplete || evidence.errors.length) throw failure("JAVA_STEAM_INSPECTION_INCOMPLETE", "The game's Java Steam calls could not be fully inspected.");
  if (!evidence.version) throw failure("JAVA_STEAM_VERSION_UNKNOWN", "This game's steamworks4j classes have no exact compatible Mac bridge.");
  if (evidence.unsupportedCalls.length) throw failure("JAVA_STEAM_API_UNQUALIFIED", "This game's Java Steam interfaces are not supported by the native helper.");
  if (evidence.appId.status !== "found") throw failure("JAVA_STEAM_APP_ID_UNKNOWN", evidence.appId.status === "conflict"
    ? "The game's Steam application IDs disagree." : "The game's Steam application ID could not be determined.");
  return { evidence, pin: catalog.find(pin => pin.version === evidence.version) };
}

module.exports = { LIMITS, inspectArchives, inspect, requirement, qualifiedClasses, manifestValues, readEntry, readArchive };
