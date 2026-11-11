const Upstream = require("../../../shared/runtime/upstream");
const { ARCHIVE } = require("../../../shared/runtime/safe-archive");

const REPOSITORY = "dappermint/winecx-gptk";
const SOURCE_URL = `https://github.com/${REPOSITORY}/releases`;

// A release's runtime is the archive that has a published SHA-256 file named
// after it. The version plist, when listed, is the release's other text file.
// Version numbers come from the release tag; assets are recognized by role.
function runtimeAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const byName = new Map(assets.map(asset => [asset?.name, asset]));
  const archives = assets.filter(asset => ARCHIVE.test(asset?.name || "") && byName.has(`${asset.name}.sha256`));
  if (archives.length !== 1) return null;
  const [archive] = archives, checksum = byName.get(`${archive.name}.sha256`);
  const plists = assets.filter(asset => /\.plist$/i.test(asset?.name || ""));
  return { archive, checksum, ...(plists.length === 1 ? { plist: plists[0] } : {}) };
}
function releaseVersion(tag) {
  return /(?:^|[^\d.])v?(\d+\.\d+(?:\.\d+)?)$/.exec(String(tag || ""))?.[1] || null;
}
const source = Upstream.github({ repository: REPOSITORY, allArchitectures: true,
  recognize: release => {
    const version = releaseVersion(release.tag_name), assets = runtimeAssets(release);
    return version && assets ? [{ version, assets: [assets.archive, assets.checksum, ...(assets.plist ? [assets.plist] : [])] }] : [];
  } });
const versionLabel = (pin, installed) => {
  const record = pin || installed?.catalogEntry || installed;
  const wine = installed?.installationMetadata?.wineVersion || installed?.wineVersion;
  return record?.version ? `WineCX ${record.version}${wine ? ` · Wine ${wine}` : ""}` : record?.versionLabel;
};
function entryFor(row) {
  const archive = row.files.find(file => ARCHIVE.test(file.name) && row.files.some(other => other.name === `${file.name}.sha256`));
  const checksum = archive && row.files.find(file => file.name === `${archive.name}.sha256`);
  if (!archive || !checksum) return null;
  const plist = row.files.find(file => /\.plist$/i.test(file.name));
  const asset = Upstream.asset(archive), tag = row.sourceUrl ? decodeURIComponent(row.sourceUrl.split("/").pop()) : "";
  return { version: row.version, versionLabel: versionLabel({ version: row.version }), upstreamTag: tag,
    upstreamRevision: `${tag || row.version}:${asset.sha256 ? "sha256:" + asset.sha256 : asset.url}`.slice(0, 200),
    sourceUrl: SOURCE_URL, localBuild: false, asset, checksum: Upstream.asset(checksum),
    ...(plist ? { plist: Upstream.asset(plist) } : {}), downloadBytes: asset.bytes || 0,
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}) };
}
function validateEntry(pin) {
  try {
    return Boolean(pin?.version && releaseVersion(`v${pin.version}`) === pin.version && pin.asset?.filename && pin.checksum?.filename === `${pin.asset.filename}.sha256` &&
      [pin.asset.url, pin.checksum.url].every(url => new URL(url).protocol === "https:"));
  } catch { return false; }
}
const compare = (a, b) => {
  const left = a.version.split(".").map(Number), right = b.version.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if ((right[index] || 0) !== (left[index] || 0)) return (right[index] || 0) - (left[index] || 0);
  return 0;
};
// Every listed runtime release, newest first.
async function discover(options = {}) {
  const result = new Map();
  for (const row of await source.discover(options)) {
    const pin = entryFor(row);
    if (pin && !result.has(pin.version)) result.set(pin.version, pin);
  }
  return [...result.values()].sort(compare);
}
discover.allArchitectures = true;

// The publisher's checksum file names the archive's SHA-256.
function readChecksum(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim()) || /^([a-f0-9]{64})$/i.exec(line.trim());
    if (match && (!match[2] || match[2] === filename)) return match[1].toLowerCase();
  }
  return null;
}

module.exports = { REPOSITORY, SOURCE_URL, source, runtimeAssets, releaseVersion, versionLabel, entryFor, validateEntry, discover, readChecksum };
