const { assetArchitecture } = require("../../runtime/architecture");
const { archiveFormat } = require("../../runtime/release-files");

// ONScripter-Yuri versions: any number of numeric parts with an optional
// alpha, beta or rc suffix ("0.7.6beta2", "0.8", "1.0.0rc1"). MacLauncher
// Builds packages add their own release revision.
const SUFFIX = "(?:[-_. ]?(alpha|beta|b|rc)(?:[-_. ]?(\\d+))?)?";
function parseOnsyuriVersion(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const match = new RegExp(`(\\d+(?:\\.\\d+)+)${SUFFIX}`, "i").exec(raw) || new RegExp(`^v?(\\d+)${SUFFIX}$`, "i").exec(raw);
  if (!match) return null;
  const parts = match[1].split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  const type = match[2] ? (match[2].toLowerCase() === "b" ? "beta" : match[2].toLowerCase()) : null;
  const number = match[3] ? Number(match[3]) : null;
  return { parts, major: parts[0], minor: parts[1] || 0, patch: parts[2] || 0, prereleaseType: type,
    prereleaseNum: Number.isFinite(number) ? number : null, normalized: `${parts.join(".")}${type ? `${type}${number ?? ""}` : ""}` };
}
function normalizeOnsyuriVersion(input) {
  return parseOnsyuriVersion(input)?.normalized || null;
}
function parseOnsyuriMacVersion(input) {
  const raw = String(input || "").trim().replace(/^v(?=\d)/i, "");
  const match = /^(\d+(?:\.\d+)*(?:(?:alpha|beta|rc)\d*)?)-(?:macos-v|MCLv)([1-9]\d*)$/.exec(raw);
  if (match) {
    const upstream = parseOnsyuriVersion(match[1]), macRevision = Number(match[2]);
    if (!upstream || upstream.normalized !== match[1] || !Number.isSafeInteger(macRevision)) return null;
    return { ...upstream, upstreamVersion: upstream.normalized, normalized: raw, macRevision };
  }
  if (/-macos-|-MCL/i.test(raw)) return null;
  const upstream = parseOnsyuriVersion(input);
  return upstream ? { ...upstream, upstreamVersion: upstream.normalized, macRevision: 0 } : null;
}
function normalizeOnsyuriMacVersion(input) {
  return parseOnsyuriMacVersion(input)?.normalized || null;
}
const RANK = { alpha: 0, beta: 1, rc: 2 };
function compareOnsyuriVersionsDesc(a, b) {
  const left = parseOnsyuriVersion(a), right = parseOnsyuriVersion(b);
  if (!left || !right) return String(b || "").localeCompare(String(a || ""));
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (right.parts[index] || 0) - (left.parts[index] || 0);
    if (difference) return difference;
  }
  const rank = version => version.prereleaseType ? RANK[version.prereleaseType] ?? 0 : 3;
  return rank(right) - rank(left) || (right.prereleaseNum || 0) - (left.prereleaseNum || 0);
}
function compareOnsyuriVersions(a, b) { return compareOnsyuriVersionsDesc(b, a); }
function compareOnsyuriMacVersionsDesc(a, b) {
  const left = parseOnsyuriMacVersion(a), right = parseOnsyuriMacVersion(b);
  if (!left || !right) return String(b || "").localeCompare(String(a || ""));
  return compareOnsyuriVersionsDesc(left.upstreamVersion, right.upstreamVersion) || right.macRevision - left.macRevision;
}
function compareOnsyuriMacVersions(a, b) { return compareOnsyuriMacVersionsDesc(b, a); }

// Mac builds are raw executables or archives with a Mac word in the name; a
// name without a CPU word serves both CPUs. Web builds are archives.
function matchesOnsyuriAsset(name, { arch, variant } = {}) {
  const lower = String(name || "").toLowerCase();
  if (variant === "web") return /(?:^|[^a-z])web(?:[^a-z]|$)/.test(lower) && !/(?:^|[^a-z])(?:debug|symbols|dsym)(?:[^a-z]|$)/.test(lower) &&
    /\.(?:7z|zip|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2)$/.test(lower);
  if (!/osx|darwin|mac/.test(lower) || /(?:^|[^a-z])(?:web|wasm|debug|symbols|dsym|src|source)(?:[^a-z]|$)/.test(lower)) return false;
  if (!archiveFormat(lower) && /\.[a-z0-9]{1,8}$/.test(lower)) return false;
  const named = assetArchitecture(lower);
  return !arch || !named || named === "universal" || named === arch;
}

// A release's downloads: one row per CPU (a build named for the CPU wins over
// one that serves both) and one for the Web build.
function recognizeRelease(release) {
  const version = normalizeOnsyuriVersion(release?.tag_name || release?.name);
  const label = release?.tag_name || release?.name || version;
  const assets = Array.isArray(release?.assets) ? release.assets.filter(asset => asset && typeof asset.name === "string") : [];
  if (!version) return [];
  const rows = [];
  for (const arch of ["arm64", "x64"]) {
    const candidates = assets.filter(asset => matchesOnsyuriAsset(asset.name, { arch }));
    const asset = candidates.find(item => assetArchitecture(item.name) === arch) || candidates[0];
    if (asset) rows.push({ version, label, architecture: arch, details: { section: "mac" }, assets: [asset] });
  }
  const web = assets.find(asset => matchesOnsyuriAsset(asset.name, { variant: "web" }));
  if (web) rows.push({ version, label, details: { section: "web" }, assets: [web] });
  return rows;
}

module.exports = { parseOnsyuriVersion, normalizeOnsyuriVersion, parseOnsyuriMacVersion, normalizeOnsyuriMacVersion,
  compareOnsyuriVersionsDesc, compareOnsyuriVersions, compareOnsyuriMacVersionsDesc, compareOnsyuriMacVersions,
  matchesOnsyuriAsset, recognizeRelease };
