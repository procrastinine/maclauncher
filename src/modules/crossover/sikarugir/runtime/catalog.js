const crypto = require("node:crypto");
const Upstream = require("../../../shared/runtime/upstream");
const { versionAtLeast } = require("../../../shared/runtime/bundled-native");
const { ARCHIVE } = require("./archive");

const SOURCE_URL = "https://github.com/Sikarugir-App/Engines/releases";

// Asset names follow upstream: any WSnn wrapper generation, an optional
// platform suffix and any archive the extractor reads. Files for other
// platforms and debug symbols published next to them are not packages.
const FOREIGN = /(?:^|[-_.])(?:linux|windows|win(?:32|64)|android|ios|riscv\d*|aarch64|debug|symbols?|dsym)(?:[-_.]|$)/i;
function archiveStem(name) {
  const value = String(name || ""), extension = ARCHIVE.exec(value);
  return extension && !FOREIGN.test(value) ? value.slice(0, extension.index) : null;
}
// Support Templates from 1.0.19 on.
function parseTemplateName(name) {
  const match = /^Template-(\d+\.\d+\.\d+)(?:[-_.][A-Za-z][\w.-]*)?$/.exec(archiveStem(name) || "");
  return match && versionAtLeast(match[1], "1.0.19") ? { version: match[1] } : null;
}
// Wine engines from 10.0_8 on, except the first 11.0 build. The WSnn number
// names the wrapper generation the engine was built for.
function parseEngineName(name) {
  const match = /^WS(\d+)WineSikarugir((\d+)\.(\d+)(?:_(\d+))?)(?:[-_.][A-Za-z][\w.-]*)?$/.exec(archiveStem(name) || "");
  if (!match) return null;
  const [major, minor, revision] = [Number(match[3]), Number(match[4]), Number(match[5] || 0)];
  if (![major, minor, revision].every(Number.isSafeInteger) || major < 10 || major === 10 && (minor === 0 && revision < 8) ||
    major === 11 && minor === 0 && revision < 1) return null;
  return { version: match[2], major, minor, revision, wrapper: Number(match[1]) };
}
// One archive per version and release: the newest wrapper generation, then
// a name without a variant suffix, then the publisher's current .tar.xz form.
const preferred = (rank, other) => { const index = rank.findIndex((value, at) => value !== other[at]); return index >= 0 && rank[index] < other[index]; };
function archives(release, parse) {
  const found = new Map();
  for (const asset of release.assets || []) {
    const parsed = parse(asset?.name);
    if (!parsed) continue;
    const rank = [-(parsed.wrapper || 0), Number(!archiveStem(asset.name).endsWith(parsed.version)), Number(!/\.tar\.xz$/i.test(asset.name))];
    if (!found.has(parsed.version) || preferred(rank, found.get(parsed.version).rank)) found.set(parsed.version, { parsed, asset, rank });
  }
  return [...found.values()].map(({ parsed, asset }) => ({ version: parsed.version, assets: [asset] }));
}
// Engines are assets of the Engines releases, support libraries assets of the
// Template releases. The rolling release tag is not a Wine version.
const engines = Upstream.github({ repository: "Sikarugir-App/Engines", prerelease: true, allArchitectures: true,
  recognize: release => archives(release, parseEngineName) });
const templates = Upstream.github({ repository: "Sikarugir-App/Template", prerelease: true, allArchitectures: true,
  recognize: release => archives(release, parseTemplateName) });

// A downloaded archive's identity: the publisher's SHA-256, or its listed URL,
// asset and size when the publisher states no digest.
const identity = asset => asset?.sha256 || (asset?.url ? [asset.digest?.value, asset.assetId, asset.url, asset.bytes].filter(Boolean).join(":") : "");
// Both versions become part of a folder name. Characters other than letters,
// digits, dots and underscores become hyphens; the digest of the unchanged
// values keeps each name distinct, so the published versions keep their form.
const folderPart = value => String(value ?? "").replace(/[^0-9A-Za-z._]/g, "-").replace(/^[.-]+/, "").slice(0, 32) || "unnamed";
function snapshotVersion(engineVersion, engineIdentity, template) {
  // Wine also places this directory in Windows paths with MAX_PATH limits.
  // Keep the folder compact; full identities remain in the catalog and receipt.
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    engineVersion, String(engineIdentity).toLowerCase(), template?.version, identity(template?.asset).toLowerCase()
  ])).digest("hex").slice(0, 24);
  return `${folderPart(engineVersion)}-template-${folderPart(template?.version)}-${digest}`;
}
function versionLabel(pin, installed) {
  const record = pin || installed?.catalogEntry || installed;
  const engine = record?.engineVersion || installed?.engineVersion;
  const template = record?.template?.version || installed?.templateVersion;
  if (!engine) return record?.versionLabel;
  const [version, revision] = engine.split("_");
  // The same form as the other Wine sources: the source and its release, then
  // the Wine release and engine revision.
  return `Sikarugir${template ? ` ${template}` : ""} · Wine ${version}${revision ? ` rev ${Number(revision)}` : ""}`;
}
function entryFor(engine, asset, template, releaseTag = "v1.0") {
  return {
    version: snapshotVersion(engine.version, identity(asset), template),
    versionLabel: versionLabel({ engineVersion: engine.version, template }),
    engineVersion: engine.version, engineName: asset.filename.replace(ARCHIVE, ""),
    // A binary asset's identity names the consumed engine. The release
    // repository is a packaging catalog and does not identify its Wine source.
    upstreamRevision: `${asset.filename.replace(ARCHIVE, "")}:${asset.sha256 ? "sha256:" + asset.sha256 : identity(asset)}`.slice(0, 200),
    upstreamTag: releaseTag, sourceUrl: SOURCE_URL, localBuild: false, asset,
    template: { ...template, asset: { ...template.asset } },
    downloadBytes: (asset.bytes || 0) + (template.asset.bytes || 0)
  };
}
// A catalog row or installation record names both archives and the version
// that combines them.
function validateEntry(pin) {
  try {
    const engine = parseEngineName(pin?.asset?.filename), template = pin?.template;
    return Boolean(engine && engine.version === pin.engineVersion && parseTemplateName(template?.asset?.filename)?.version === template.version &&
      [pin.asset.url, template.asset.url].every(url => new URL(url).protocol === "https:") &&
      pin.version === snapshotVersion(engine.version, identity(pin.asset), template));
  } catch { return false; }
}

// Every listed engine paired with the newest listed support archive.
async function discover(options = {}) {
  const [engineRows, templateRows] = await Promise.all([engines.discover(options), templates.discover(options)]);
  const [support] = templateRows.filter(row => row.files[0]).sort((a, b) => versionAtLeast(b.version, a.version) - versionAtLeast(a.version, b.version));
  if (!support) throw new Error("No compatible Sikarugir support archive is available.");
  const template = { version: support.version, asset: Upstream.asset(support.files[0]) }, result = new Map();
  for (const row of engineRows) {
    const listed = row.files[0], engine = parseEngineName(listed?.name);
    if (!engine) continue;
    const pin = entryFor(engine, Upstream.asset(listed), template, row.sourceUrl ? decodeURIComponent(row.sourceUrl.split("/").pop()) : undefined);
    if (!result.has(pin.version)) result.set(pin.version, pin);
  }
  return [...result.values()].sort((a, b) => {
    const left = parseEngineName(a.asset.filename), right = parseEngineName(b.asset.filename);
    return right.major - left.major || right.minor - left.minor || right.revision - left.revision || a.version.localeCompare(b.version);
  });
}
discover.allArchitectures = true;

module.exports = { SOURCE_URL, engines, templates,
  parseEngineName, parseTemplateName, archives, snapshotVersion, versionLabel, entryFor, validateEntry, discover };
