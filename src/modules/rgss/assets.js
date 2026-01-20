const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeRtpId } = require("./rgss-utils");

const ASSETS_VERSION = 2;
const MARKER_FILE = ".maclauncher-assets.json";
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
const RTP_PACKS = ["Standard", "RPGVX", "RPGVXAce"];

const signatureCache = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function resolveResourceRoot(resourceRoot) {
  return resourceRoot ? path.resolve(resourceRoot) : DEFAULT_RESOURCE_ROOT;
}

function resolveKawarikiRoot(kawarikiRoot) {
  return kawarikiRoot ? path.resolve(kawarikiRoot) : DEFAULT_KAWARIKI_ROOT;
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

function walkFiles(rootDir, baseDir, out, prefix = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, baseDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const rel = path.relative(baseDir, full).replaceAll(path.sep, "/");
    out.push({
      rel: prefix ? `${prefix}/${rel}` : rel,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs || 0)
    });
  }
}

function addFileSignature(out, filePath, rel) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile()) return;
  out.push({
    rel,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs || 0)
  });
}

function computeSignature({ resourceRoot, kawarikiRoot } = {}) {
  const root = resolveResourceRoot(resourceRoot);
  const kawariki = resolveKawarikiRoot(kawarikiRoot);
  const overlayStat = safeStat(KAWARIKI_OVERLAY_PATH);
  const overlayKey = overlayStat
    ? `${overlayStat.size}:${Math.round(overlayStat.mtimeMs || 0)}`
    : "missing";
  const cacheKey = `${root}::${kawariki}::${overlayKey}`;
  if (signatureCache.has(cacheKey)) return signatureCache.get(cacheKey);

  const { rtpRoot, kawarikiRoot: kawarikiPath, soundfontPath } = resolveResourcePaths({
    resourceRoot,
    kawarikiRoot
  });
  const entries = [];

  for (const pack of RTP_PACKS) {
    walkFiles(path.join(rtpRoot, pack), root, entries);
  }
  walkFiles(kawarikiPath, kawarikiPath, entries, "kawariki");
  walkFiles(path.dirname(soundfontPath), root, entries);
  addFileSignature(entries, KAWARIKI_OVERLAY_PATH, "kawariki/patches-extra.rb");

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = crypto.createHash("sha256");
  hash.update(`v${ASSETS_VERSION}`);
  for (const entry of entries) {
    hash.update(`|${entry.rel}:${entry.size}:${entry.mtimeMs}`);
  }
  const digest = hash.digest("hex");
  const res = { version: ASSETS_VERSION, hash: digest };
  signatureCache.set(cacheKey, res);
  return res;
}

function readMarker(userDataDir) {
  const p = markerPath(userDataDir);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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

function resolveStagedPaths(userDataDir, rtpId) {
  const root = assetsRoot(userDataDir);
  const rtpName = normalizeRtpId(rtpId);
  return {
    assetsRoot: root,
    rtpRoot: path.join(root, "rtp"),
    rtpPath: rtpName ? path.join(root, "rtp", rtpName) : null,
    kawarikiRoot: path.join(root, "kawariki"),
    kawarikiPreload: path.join(root, "kawariki", "preload.rb"),
    kawarikiOverlay: path.join(root, "kawariki", "patches-extra.rb"),
    soundfontPath: path.join(root, "soundfont", SOUND_FONT_FILE)
  };
}

function checkStagedPaths(userDataDir) {
  const { rtpRoot, kawarikiPreload, kawarikiOverlay, soundfontPath } =
    resolveStagedPaths(userDataDir);
  const missing = [];

  for (const pack of RTP_PACKS) {
    const dir = path.join(rtpRoot, pack);
    const stat = safeStat(dir);
    if (!stat || !stat.isDirectory()) missing.push(dir);
  }

  const preloadStat = safeStat(kawarikiPreload);
  if (!preloadStat || !preloadStat.isFile()) missing.push(kawarikiPreload);

  const overlayStat = safeStat(kawarikiOverlay);
  if (!overlayStat || !overlayStat.isFile()) missing.push(kawarikiOverlay);

  const fontStat = safeStat(soundfontPath);
  if (!fontStat || !fontStat.isFile()) missing.push(soundfontPath);

  return missing;
}

function getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot } = {}) {
  const expected = computeSignature({ resourceRoot, kawarikiRoot });
  const marker = readMarker(userDataDir);
  const missing = checkStagedPaths(userDataDir);
  const assetsStaged = Boolean(
    marker &&
      marker.version === expected.version &&
      marker.hash === expected.hash &&
      missing.length === 0
  );
  return {
    assetsStaged,
    marker,
    expected,
    missing
  };
}

function ensureAssetsStaged({ userDataDir, logger, force, resourceRoot, kawarikiRoot } = {}) {
  const status = getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot });
  if (status.assetsStaged && !force) return { ...status, stagedNow: false };

  const { rtpRoot, kawarikiRoot: kawarikiPath, soundfontPath } = resolveResourcePaths({
    resourceRoot,
    kawarikiRoot
  });
  const missingResources = [];
  for (const pack of RTP_PACKS) {
    const dir = path.join(rtpRoot, pack);
    const stat = safeStat(dir);
    if (!stat || !stat.isDirectory()) missingResources.push(dir);
  }
  const kawarikiStat = safeStat(kawarikiPath);
  if (!kawarikiStat || !kawarikiStat.isDirectory()) missingResources.push(kawarikiPath);
  const fontStat = safeStat(soundfontPath);
  if (!fontStat || !fontStat.isFile()) missingResources.push(soundfontPath);
  const overlayStat = safeStat(KAWARIKI_OVERLAY_PATH);
  if (!overlayStat || !overlayStat.isFile()) missingResources.push(KAWARIKI_OVERLAY_PATH);
  if (missingResources.length > 0) {
    throw new Error(
      `RGSS assets missing: ${missingResources.join(
        ", "
      )}. Ensure external repos are present under src/external and overlays are available.`
    );
  }
  const destRoot = assetsRoot(userDataDir);

  safeRm(destRoot);
  ensureDir(destRoot);

  const destRtpRoot = path.join(destRoot, "rtp");
  ensureDir(destRtpRoot);
  for (const pack of RTP_PACKS) {
    const src = path.join(rtpRoot, pack);
    const dest = path.join(destRtpRoot, pack);
    logger?.info?.(`[rgss] staging RTP ${pack}`);
    fs.cpSync(src, dest, { recursive: true, force: true });
  }

  const destKawariki = path.join(destRoot, "kawariki");
  logger?.info?.("[rgss] staging Kawariki");
  fs.cpSync(kawarikiPath, destKawariki, { recursive: true, force: true });
  applyKawarikiOverlay({ destKawariki, logger });

  const destFont = path.join(destRoot, "soundfont", SOUND_FONT_FILE);
  ensureDir(path.dirname(destFont));
  logger?.info?.("[rgss] staging soundfont");
  fs.cpSync(soundfontPath, destFont, { force: true });

  const expected = computeSignature({ resourceRoot, kawarikiRoot });
  const marker = {
    version: expected.version,
    hash: expected.hash,
    stagedAt: new Date().toISOString()
  };
  fs.writeFileSync(markerPath(userDataDir), JSON.stringify(marker, null, 2));

  const nextStatus = getAssetsStatus({ userDataDir, resourceRoot, kawarikiRoot });
  return { ...nextStatus, stagedNow: true };
}

function removeStagedAssets({ userDataDir } = {}) {
  safeRm(assetsRoot(userDataDir));
  return true;
}

module.exports = {
  ASSETS_VERSION,
  ensureAssetsStaged,
  getAssetsStatus,
  resolveStagedPaths,
  removeStagedAssets
};
