const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeRtpId } = require("./rgss-utils");
const rawFs = (() => {
  try { return require("original-fs"); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; return fs; }
})();

const ASSETS_VERSION = 4;
const MARKER_FILE = ".maclauncher-assets.json";
const GENERATION_FILE = ".maclauncher-generation.json";
const GENERATION_NAME = /^[a-f0-9]{64}-[a-f0-9-]{36}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_RESOURCE_ROOT = path.resolve(__dirname, "resources");
const DEFAULT_KAWARIKI_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "external",
  "rpgmakermlinux-cicpoffs",
  "Kawariki-patches"
);
const KAWARIKI_OVERLAY_PATH = path.resolve(
  __dirname,
  "overlays",
  "kawariki",
  "patches-extra.rb"
);
const SOUND_FONT_FILE = "GMGSx.SF2";

const signatureCache = new Map();
const archiveHeaderCache = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function resolvePackagedExternalDir(...segments) {
  if (!process.resourcesPath) return null;
  const candidates = [
    path.join(process.resourcesPath, "external", ...segments),
    path.join(process.resourcesPath, "app.asar.unpacked", "external", ...segments),
    path.join(process.resourcesPath, "app.asar.unpacked", "src", "external", ...segments)
  ];
  for (const candidate of candidates) {
    const stat = safeStat(candidate);
    if (stat && stat.isDirectory()) return candidate;
  }
  return null;
}

function resolveResourceRoot(resourceRoot) {
  return resourceRoot ? path.resolve(resourceRoot) : DEFAULT_RESOURCE_ROOT;
}

function resolveKawarikiRoot(kawarikiRoot) {
  if (kawarikiRoot) return path.resolve(kawarikiRoot);
  const packaged = resolvePackagedExternalDir("rpgmakermlinux-cicpoffs", "Kawariki-patches");
  return packaged || DEFAULT_KAWARIKI_ROOT;
}

function resolveResourcePaths({ resourceRoot, kawarikiRoot } = {}) {
  const root = resolveResourceRoot(resourceRoot);
  const kawariki = resolveKawarikiRoot(kawarikiRoot);
  return {
    root,
    rtpRoot: path.join(root, "rtp"),
    kawarikiRoot: kawariki,
    soundfontPath: path.join(root, "soundfont", SOUND_FONT_FILE)
  };
}

function assetsRoot(userDataDir) {
  return path.join(userDataDir, "modules", "rgss", "assets");
}

function markerPath(userDataDir) {
  return path.join(assetsRoot(userDataDir), MARKER_FILE);
}

function statMetadata(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}

function sameMetadata(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function rawStat(file) {
  try { return rawFs.lstatSync(file, { bigint: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}

function archiveHeader(archive, expected) {
  const cached = archiveHeaderCache.get(archive);
  if (cached && sameMetadata(cached.metadata, expected)) return cached.header;
  const fd = rawFs.openSync(archive, rawFs.constants.O_RDONLY | (rawFs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameMetadata(statMetadata(rawFs.fstatSync(fd, { bigint: true })), expected)) throw new Error("RGSS asset source changed while reading.");
    function read(length) {
      const bytes = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const count = rawFs.readSync(fd, bytes, offset, length - offset, null);
        if (!count) throw new Error("RGSS packed asset metadata is incomplete.");
        offset += count;
      }
      return bytes;
    }
    const size = read(8), length = size.readUInt32LE(4);
    if (size.readUInt32LE(0) !== 4 || length < 8 || length > MAX_RECORD_BYTES || BigInt(length + 8) > BigInt(expected[3])) throw new Error("RGSS packed asset metadata is invalid.");
    const bytes = read(length), jsonLength = bytes.readUInt32LE(4);
    if (bytes.readUInt32LE(0) !== length - 4 || jsonLength < 2 || jsonLength > length - 8) throw new Error("RGSS packed asset metadata is invalid.");
    const header = JSON.parse(bytes.subarray(8, 8 + jsonLength).toString("utf8"));
    if (!header || typeof header.files !== "object" || Array.isArray(header.files)) throw new Error("RGSS packed asset metadata is invalid.");
    if (!sameMetadata(statMetadata(rawFs.fstatSync(fd, { bigint: true })), expected) || !sameMetadata(statMetadata(rawFs.lstatSync(archive, { bigint: true })), expected)) throw new Error("RGSS asset source changed while reading.");
    if (archiveHeaderCache.size >= 8 && !archiveHeaderCache.has(archive)) archiveHeaderCache.delete(archiveHeaderCache.keys().next().value);
    archiveHeaderCache.set(archive, { metadata: expected, header });
    return header;
  } finally { rawFs.closeSync(fd); }
}

function observeSource(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("RGSS asset resources must contain only real files and directories.");
  const absolute = path.resolve(file);
  for (let start = 0, end; (end = absolute.indexOf(".asar" + path.sep, start)) !== -1; start = end + 6) {
    const archive = absolute.slice(0, end + 5), container = rawStat(archive);
    if (!container) continue;
    if (container.isSymbolicLink()) throw new Error("RGSS asset resources must contain only real files and directories.");
    if (!container.isFile()) continue;
    const containerMetadata = statMetadata(container), relative = absolute.slice(end + 6);
    let member = archiveHeader(archive, containerMetadata);
    for (const segment of relative.split(path.sep)) {
      member = member?.files && Object.hasOwn(member.files, segment) ? member.files[segment] : null;
      if (!member || Object.hasOwn(member, "link")) throw new Error("RGSS packed assets must not use symlinks.");
    }
    if (member.unpacked === true) {
      const segments = ["", ...relative.split(path.sep)];
      let physical = archive + ".unpacked", unpacked;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (segment) physical = path.join(physical, segment);
        unpacked = rawFs.lstatSync(physical, { bigint: true });
        if (unpacked.isSymbolicLink() || index < segments.length - 1 && !unpacked.isDirectory()) throw new Error("RGSS unpacked assets must contain only real files and directories.");
      }
      if (stat.isFile() !== unpacked.isFile() || stat.isDirectory() !== unpacked.isDirectory() || stat.isFile() && stat.size !== unpacked.size) throw new Error("RGSS packed asset metadata differs from its source.");
      const physicalMetadata = statMetadata(unpacked);
      return { stat, size: stat.size, fileMetadata: physicalMetadata, metadata: ["asar-unpacked", archive, ...containerMetadata, ...physicalMetadata] };
    }
    // Electron synthesizes a new inode on every ASAR stat. Bind the real archive
    // and member's stable attributes instead; ordinary files keep all metadata.
    return { stat, size: stat.size, fileMetadata: null, metadata: ["asar", archive, ...containerMetadata, String(stat.mode), String(stat.size)] };
  }
  const metadata = statMetadata(stat);
  return { stat, size: stat.size, fileMetadata: metadata, metadata };
}

function sha256(file, expected) {
  const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true }), descriptorMetadata = statMetadata(before);
    if (!before.isFile() || before.size !== expected.size || expected.fileMetadata && !sameMetadata(descriptorMetadata, expected.fileMetadata)) throw new Error("RGSS asset source changed while reading.");
    let bytes, total = 0n;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, bytes)); total += BigInt(bytes); }
    if (total !== expected.size || !sameMetadata(statMetadata(fs.fstatSync(fd, { bigint: true })), descriptorMetadata) || !sameMetadata(observeSource(file).metadata, expected.metadata)) throw new Error("RGSS asset source changed while reading.");
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

function inventory(root, { prefix = "", previous = [], force = false, sourcePaths = false } = {}) {
  const cached = new Map((Array.isArray(previous) ? previous : []).filter(Boolean).map(file => [file.relative, file]));
  const files = [];
  function walk(file, relative) {
    let observation;
    try { observation = observeSource(file); }
    catch (error) { if (error.code === "ENOENT") { files.push({ relative, type: "missing" }); return; } throw error; }
    const { stat } = observation;
    const item = { relative, type: stat.isDirectory() ? "directory" : "file", mode: Number(stat.mode & 0o777n), metadata: observation.metadata };
    if (sourcePaths) item.sourcePath = path.resolve(file);
    if (stat.isFile()) {
      item.size = Number(stat.size);
      const prior = cached.get(relative);
      item.sha256 = !force && /^[a-f0-9]{64}$/.test(prior?.sha256 || "") && JSON.stringify(prior.metadata) === JSON.stringify(item.metadata)
        ? prior.sha256 : sha256(file, observation);
    }
    if (relative) files.push(item);
    if (files.length > 16384) throw new Error("Too many RGSS runtime asset files.");
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) {
      if (!relative && name === GENERATION_FILE) continue;
      walk(path.join(file, name), relative ? relative + "/" + name : name);
    }
  }
  walk(root, prefix);
  return files;
}

function contentIdentity(files) {
  return crypto.createHash("sha256").update(JSON.stringify(files.map(({ metadata: _metadata, sourcePath: _sourcePath, ...file }) => file))).digest("hex");
}

function computeSignature({ resourceRoot, kawarikiRoot, previous, force = false } = {}) {
  const paths = resolveResourcePaths({ resourceRoot, kawarikiRoot });
  const roots = [paths.root, paths.kawarikiRoot, KAWARIKI_OVERLAY_PATH].map(file => {
    try { return fs.realpathSync(file); } catch { return path.resolve(file); }
  });
  const key = JSON.stringify(roots), stored = signatureCache.get(key) || previous;
  const prior = stored?.roots && JSON.stringify(stored.roots) === key && Array.isArray(stored.files) ? stored.files : [];
  const files = [];
  files.push(...inventory(paths.kawarikiRoot, { prefix: "kawariki", previous: prior, force, sourcePaths: true }));
  files.push(...inventory(paths.soundfontPath, { prefix: "soundfont/" + SOUND_FONT_FILE, previous: prior, force, sourcePaths: true }));
  files.push(...inventory(KAWARIKI_OVERLAY_PATH, { prefix: "overlay/patches-extra.rb", previous: prior, force, sourcePaths: true }));
  files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const hash = crypto.createHash("sha256").update(JSON.stringify([ASSETS_VERSION, contentIdentity(files)])).digest("hex");
  const result = { version: ASSETS_VERSION, hash, roots, files };
  if (signatureCache.size >= 8 && !signatureCache.has(key)) signatureCache.delete(signatureCache.keys().next().value);
  signatureCache.set(key, result); return result;
}

function readRecord(p) {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMarker(userDataDir) { return readRecord(markerPath(userDataDir)); }

function writeRecord(file, value) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function ownedRoot(userDataDir, { create = false } = {}) {
  if (create) ensureDir(userDataDir);
  let root;
  try { root = fs.realpathSync(userDataDir); }
  catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
  let current = root;
  for (const segment of ["modules", "rgss", "assets"]) {
    current = path.join(current, segment);
    if (create) { try { fs.mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("RGSS asset directories must not use symlinks.");
  }
  return current;
}

function generationPath(userDataDir, marker) {
  return marker?.version === ASSETS_VERSION && GENERATION_NAME.test(marker.generation || "")
    ? path.join(assetsRoot(userDataDir), "generations", marker.generation) : null;
}

function validateGeneration(root, expected, force = false) {
  try {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return false;
    const record = readRecord(path.join(root, GENERATION_FILE));
    if (record?.version !== (expected.version || ASSETS_VERSION) || record.hash !== expected.hash || !Array.isArray(record.output) || record.output.length > 16384) return false;
    return contentIdentity(inventory(root, { previous: record.output, force })) === record.outputHash;
  } catch { return false; }
}

function applyKawarikiOverlay({ destKawariki, logger }) {
  const overlayStat = safeStat(KAWARIKI_OVERLAY_PATH);
  if (!overlayStat || !overlayStat.isFile()) {
    throw new Error(`RGSS overlay missing: ${KAWARIKI_OVERLAY_PATH}`);
  }
  const overlayDest = path.join(destKawariki, "patches-extra.rb");
  fs.cpSync(KAWARIKI_OVERLAY_PATH, overlayDest, { force: true });

  const preloadPath = path.join(destKawariki, "preload.rb");
  const preloadStat = safeStat(preloadPath);
  if (!preloadStat || !preloadStat.isFile()) {
    throw new Error(`Kawariki preload missing in staged assets: ${preloadPath}`);
  }
  const requireLine = "Kernel.require File.join(Preload::Path, 'patches.rb')";
  const overlayLine = "Kernel.require File.join(Preload::Path, 'patches-extra.rb')";
  let contents = fs.readFileSync(preloadPath, "utf8");
  if (!contents.includes(overlayLine)) {
    if (contents.includes(requireLine)) {
      contents = contents.replace(requireLine, `${requireLine}\n${overlayLine}`);
    } else {
      contents = `${contents}\n${overlayLine}\n`;
      logger?.warn?.("[rgss] Kawariki preload missing patches.rb require; appended overlay require.");
    }
    fs.writeFileSync(preloadPath, contents, "utf8");
  }
}

function resolveStagedPaths(userDataDir, rtpId, { generationRoot, rtpPaths } = {}) {
  const root = generationRoot || generationPath(userDataDir, readMarker(userDataDir)) || assetsRoot(userDataDir);
  const rtpName = normalizeRtpId(rtpId);
  return {
    assetsRoot: root,
    rtpRoot: path.join(root, "rtp"),
    rtpPath: Array.isArray(rtpPaths) ? rtpPaths[0] || null : (rtpName ? getLegacyRtpRoots(userDataDir).map(base => path.join(base, "rtp", rtpName)).find(base => safeStat(base)?.isDirectory()) || null : null),
    rtpPaths: Array.isArray(rtpPaths) ? rtpPaths : [],
    kawarikiRoot: path.join(root, "kawariki"),
    kawarikiPreload: path.join(root, "kawariki", "preload.rb"),
    kawarikiOverlay: path.join(root, "kawariki", "patches-extra.rb"),
    soundfontPath: path.join(root, "soundfont", SOUND_FONT_FILE)
  };
}

function checkStagedPaths(userDataDir, generationRoot) {
  const { kawarikiPreload, kawarikiOverlay, soundfontPath } =
    resolveStagedPaths(userDataDir, null, { generationRoot });
  const missing = [];

  const preloadStat = safeStat(kawarikiPreload);
  if (!preloadStat || !preloadStat.isFile()) missing.push(kawarikiPreload);

  const overlayStat = safeStat(kawarikiOverlay);
  if (!overlayStat || !overlayStat.isFile()) missing.push(kawarikiOverlay);

  const fontStat = safeStat(soundfontPath);
  if (!fontStat || !fontStat.isFile()) missing.push(soundfontPath);

  return missing;
}

function getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot, force = false } = {}) {
  const marker = readMarker(userDataDir);
  const expected = computeSignature({ resourceRoot, kawarikiRoot, previous: marker?.source, force });
  const root = generationPath(userDataDir, marker);
  const missing = checkStagedPaths(userDataDir, root);
  let assetsStaged = false;
  if (root && marker.hash === expected.hash && missing.length === 0) {
    try {
      if (!ownedRoot(userDataDir) || fs.lstatSync(path.dirname(root)).isSymbolicLink() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Invalid RGSS asset generation.");
      assetsStaged = validateGeneration(root, expected, force);
    } catch { assetsStaged = false; }
  }
  return {
    assetsStaged,
    marker,
    expected,
    missing,
    generationRoot: assetsStaged ? fs.realpathSync(root) : null
  };
}

function legacyGenerations(marker) {
  const names = marker?.version === 3 ? [marker.generation] : marker?.legacyRtpGenerations;
  return [...new Set((Array.isArray(names) ? names : []).slice(0, 8).filter(name => GENERATION_NAME.test(name || "")))];
}

function getLegacyRtpRoots(userDataDir, { force = false } = {}) {
  if (!ownedRoot(userDataDir)) return [];
  const generations = path.join(assetsRoot(userDataDir), "generations");
  try { if (!fs.lstatSync(generations).isDirectory() || fs.lstatSync(generations).isSymbolicLink()) return []; }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return legacyGenerations(readMarker(userDataDir)).map(name => path.join(generations, name)).filter(root =>
    validateGeneration(root, { version: 3, hash: path.basename(root).slice(0, 64) }, force));
}

function ensureAssetsStaged({ userDataDir, logger, force, resourceRoot, kawarikiRoot } = {}) {
  const status = getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot, force });
  if (status.assetsStaged) {
    // Persist refreshed observations without touching the immutable payload.
    if (JSON.stringify(status.marker.source) !== JSON.stringify(status.expected)) {
      writeRecord(markerPath(userDataDir), { ...status.marker, source: status.expected });
    }
    return { ...status, stagedNow: false };
  }

  const { kawarikiRoot: kawarikiPath, soundfontPath } = resolveResourcePaths({
    resourceRoot,
    kawarikiRoot
  });
  const missingResources = [];
  const kawarikiStat = safeStat(kawarikiPath);
  if (!kawarikiStat || !kawarikiStat.isDirectory()) missingResources.push(kawarikiPath);
  const fontStat = safeStat(soundfontPath);
  if (!fontStat || !fontStat.isFile()) missingResources.push(soundfontPath);
  const overlayStat = safeStat(KAWARIKI_OVERLAY_PATH);
  if (!overlayStat || !overlayStat.isFile()) missingResources.push(KAWARIKI_OVERLAY_PATH);
  if (missingResources.length > 0) {
    throw new Error(
      `The included RGSS support files are missing: ${missingResources.join(", ")}. Restore MacLauncher’s support files.`
    );
  }
  const destRoot = ownedRoot(userDataDir, { create: true });
  const generations = path.join(destRoot, "generations");
  ensureDir(generations);
  if (fs.lstatSync(generations).isSymbolicLink()) throw new Error("RGSS asset generations must not use symlinks.");
  const firstGeneration = status.expected.hash + "-00000000-0000-0000-0000-000000000000";
  // Rollbacks and concurrent cold publishers share a completed healthy tree.
  for (const name of fs.readdirSync(generations).filter(name => GENERATION_NAME.test(name) && name.startsWith(status.expected.hash + "-"))) {
    const candidate = path.join(generations, name);
    if (!validateGeneration(candidate, status.expected, force)) continue;
    const marker = { version: ASSETS_VERSION, hash: status.expected.hash, generation: name, source: status.expected, legacyRtpGenerations: legacyGenerations(status.marker), stagedAt: new Date().toISOString() };
    writeRecord(path.join(destRoot, MARKER_FILE), marker);
    return { assetsStaged: true, marker, expected: status.expected, missing: [], generationRoot: candidate, stagedNow: false };
  }
  for (const source of [kawarikiPath, soundfontPath]) {
    const real = fs.realpathSync(source);
    if (real === destRoot || real.startsWith(destRoot + path.sep) || destRoot.startsWith(real + path.sep)) throw new Error("RGSS source and staged asset directories overlap.");
  }
  const staging = fs.mkdtempSync(path.join(generations, ".prepare-"));
  try {
    const copyOptions = { recursive: true, force: false, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE };
    const destKawariki = path.join(staging, "kawariki");
    logger?.info?.("[rgss] staging Kawariki");
    fs.cpSync(kawarikiPath, destKawariki, copyOptions);
    applyKawarikiOverlay({ destKawariki, logger });
    const destFont = path.join(staging, "soundfont", SOUND_FONT_FILE);
    ensureDir(path.dirname(destFont));
    fs.copyFileSync(soundfontPath, destFont, fs.constants.COPYFILE_FICLONE);
    const after = computeSignature({ resourceRoot, kawarikiRoot });
    if (after.hash !== status.expected.hash || JSON.stringify(after.files) !== JSON.stringify(status.expected.files)) {
      throw new Error("RGSS asset source changed while staging.");
    }
    const output = inventory(staging, { force: true });
    const outputFiles = new Map(output.filter(file => file.type === "file").map(file => [file.relative, file]));
    for (const original of after.files.filter(file => file.type === "file")) {
      if (["kawariki/preload.rb", "kawariki/patches-extra.rb"].includes(original.relative)) continue;
      const relative = original.relative === "overlay/patches-extra.rb" ? "kawariki/patches-extra.rb" : original.relative;
      if (outputFiles.get(relative)?.sha256 !== original.sha256) throw new Error("RGSS asset bytes changed during staging: " + relative);
    }
    for (const file of output) {
      const target = path.join(staging, file.relative);
      fs.chmodSync(target, file.mode & ~0o222);
    }
    const frozen = inventory(staging, { force: true });
    writeRecord(path.join(staging, GENERATION_FILE), { version: ASSETS_VERSION, hash: after.hash, output: frozen, outputHash: contentIdentity(frozen) });
    fs.chmodSync(path.join(staging, GENERATION_FILE), 0o444);
    const completedFirst = fs.existsSync(path.join(generations, firstGeneration)) && validateGeneration(path.join(generations, firstGeneration), after, force);
    let generation = !completedFirst && fs.existsSync(path.join(generations, firstGeneration)) ? after.hash + "-" + crypto.randomUUID() : firstGeneration;
    let published = path.join(generations, generation);
    try { if (!completedFirst) fs.renameSync(staging, published); }
    catch (error) {
      // Darwin may report EACCES when another publisher has already frozen
      // the destination directory. Only an existing, validated tree can win.
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(error.code) || !fs.existsSync(published)) throw error;
      if (!validateGeneration(published, after, force)) {
        generation = after.hash + "-" + crypto.randomUUID(); published = path.join(generations, generation);
        fs.renameSync(staging, published);
      }
    }
    fs.chmodSync(published, 0o555);
    const marker = { version: ASSETS_VERSION, hash: after.hash, generation, source: after, legacyRtpGenerations: legacyGenerations(status.marker), stagedAt: new Date().toISOString() };
    writeRecord(path.join(destRoot, MARKER_FILE), marker);
    return { assetsStaged: true, marker, expected: after, missing: [], generationRoot: published, stagedNow: true };
  } finally { if (fs.existsSync(staging)) removeTree(staging); }
}

function removeTree(root) {
  // Only explicit guarded removal or an unpublished owned stage uses this.
  const stat = fs.lstatSync(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(root, stat.mode | 0o700);
    for (const name of fs.readdirSync(root)) removeTree(path.join(root, name));
    fs.rmdirSync(root);
  } else fs.unlinkSync(root);
}

function removeStagedAssets({ userDataDir } = {}) {
  const root = ownedRoot(userDataDir);
  if (root) removeTree(root);
  return true;
}

module.exports = {
  ASSETS_VERSION,
  applyKawarikiOverlay,
  ensureAssetsStaged,
  getAssetsStatus,
  getLegacyRtpRoots,
  resolveStagedPaths,
  removeStagedAssets
};
