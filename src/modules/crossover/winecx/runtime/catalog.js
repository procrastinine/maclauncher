const zlib = require("node:zlib");
const Upstream = require("../../../shared/runtime/upstream");
const { ARCHIVE } = require("../../../shared/runtime/safe-archive");
const { parseMachOLoadCommands } = require("../../../shared/runtime/macho-load-commands");

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
  return withFloor([...result.values()].sort(compare), options);
}
discover.allArchitectures = true;

// The archive's first Wine executable states the release's macOS floor. Its
// start is read in parts and inflated until that executable's load commands are
// complete, about 4 MB of a 450 MB archive, so a version's requirement is known
// before its download. The installed closure's floor replaces it after install.
const HEADER = 64 * 1024, MACHO = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe]);
function tarString(bytes, start, length) { const text = bytes.toString("utf8", start, start + length); const end = text.indexOf("\0"); return end < 0 ? text : text.slice(0, end); }
// The first Mach-O file in a Wine bin folder of an inflated tar prefix:
// its header bytes, null when none is in the archive, or undefined when more input is needed.
function wineExecutable(tar) {
  let offset = 0, longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return null;
    const size = parseInt(tarString(header, 124, 12).trim() || "0", 8), type = String.fromCharCode(header[156] || 48), data = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const ustar = tarString(header, 257, 6) === "ustar" ? tarString(header, 345, 155) : "";
    const name = longName || (ustar ? `${ustar}/` : "") + tarString(header, 0, 100);
    longName = null;
    if (type === "L" || type === "x") {
      if (data + size > tar.length) return undefined;
      const text = tar.toString("utf8", data, data + size);
      longName = type === "L" ? text.replace(/\0[\s\S]*$/, "") : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] || null;
    } else if ((type === "0" || type === "\0") && /(?:^|\/)Wine\/bin\/(?!\._)[^/]+$/.test(name) && size >= 4) {
      if (data + Math.min(size, HEADER) > tar.length) return undefined;
      const bytes = tar.subarray(data, data + Math.min(size, HEADER));
      if (MACHO.has(bytes.readUInt32BE(0))) return bytes;
    }
    offset = data + Math.ceil(size / 512) * 512;
  }
  return undefined;
}
async function archiveFloor(listed, { signal, range = Upstream.range, step = 2 << 20, limit = 16 << 20 } = {}) {
  if (!/\.(?:tar\.gz|tgz)$/i.test(listed?.filename || listed?.name || "")) return null;
  let compressed = Buffer.alloc(0), total = Infinity;
  while (compressed.length < Math.min(limit, total)) {
    const part = await range(Upstream.listedFile(listed), compressed.length, Math.min(step, total - compressed.length), { signal });
    compressed = Buffer.concat([compressed, part.bytes]); total = part.total;
    const tar = zlib.gunzipSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 8 * limit });
    const executable = wineExecutable(tar);
    if (executable === null) return null;
    if (executable) {
      try { return parseMachOLoadCommands(executable).slices.map(slice => slice.minimumMacOS).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) || null; }
      catch { return null; }
    }
  }
  return null;
}
const floors = new Map();
// Refresh reads the floor of the newest release, the one Play prepares. A floor
// already read for the same archive is reused.
async function withFloor(pins, options = {}) {
  const pin = pins[0], key = pin && (pin.asset.sha256 || pin.asset.url);
  if (!pin) return pins;
  if (!floors.has(key)) {
    try { floors.set(key, await (options.archiveFloor || archiveFloor)(pin.asset, options)); }
    catch (error) { if (error?.name === "AbortError") throw error; options.logger?.warn?.(`[winecx] The macOS requirement of ${pin.version} could not be read before download: ${error.message}`); return pins; }
  }
  const minimumMacOS = floors.get(key);
  return minimumMacOS ? [{ ...pin, minimumMacOS }, ...pins.slice(1)] : pins;
}

// The publisher's checksum file names the archive's SHA-256.
function readChecksum(text, filename) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim()) || /^([a-f0-9]{64})$/i.exec(line.trim());
    if (match && (!match[2] || match[2] === filename)) return match[1].toLowerCase();
  }
  return null;
}

module.exports = { REPOSITORY, SOURCE_URL, source, runtimeAssets, releaseVersion, versionLabel, entryFor, validateEntry, discover, readChecksum, archiveFloor, wineExecutable };
