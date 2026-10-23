const Github = require("../../../shared/runtime/github-releases");
const crypto = require("node:crypto");
const { githubAssetDigest } = require("../../../shared/runtime/github-runtime-catalog");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");

const SOURCE_URL = "https://github.com/Sikarugir-App/Engines/releases";
const TEMPLATE_SOURCE_URL = "https://github.com/Sikarugir-App/Template/releases";
const DIGEST = /^[a-f0-9]{64}$/i;
const MAXIMUM_ASSET_BYTES = 512 * 1024 * 1024;
const DEFAULT_TEMPLATE = Object.freeze({ version: "1.0.21", minimumMacOS: "14.0", asset: Object.freeze({
  filename: "Template-1.0.21.tar.xz", bytes: 95883080, assetId: 604330514,
  url: "https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.21.tar.xz",
  sha256: "bbe996e4e4375318485953d0c7818b7b4b0a4dc1f13303bcc584f99f7602f78d",
  integritySource: "github-published-sha256"
}) });

function parseEngineName(name) {
  const match = /^WS12WineSikarugir((\d+)\.(\d+)(?:_(\d+))?)\.tar\.xz$/.exec(name || "");
  if (!match) return null;
  const [major, minor, revision] = [Number(match[2]), Number(match[3]), Number(match[4] || 0)];
  if (![major, minor, revision].every(Number.isSafeInteger) || major < 10 || major === 10 && (minor === 0 && revision < 8) ||
    major === 11 && minor === 0 && revision < 1) return null;
  return { version: match[1], major, minor, revision };
}
function snapshotVersion(engineVersion, engineDigest, template) {
  if (!parseEngineName(`WS12WineSikarugir${engineVersion}.tar.xz`) || !DIGEST.test(engineDigest || "") ||
    !/^\d+\.\d+\.\d+$/.test(template?.version || "") || !DIGEST.test(template?.asset?.sha256 || ""))
    throw new Error("Sikarugir downloads require identified engine and support archive checksums.");
  // Wine also places this directory in Windows paths with MAX_PATH limits.
  // Keep the folder compact; full identities remain in the catalog and receipt.
  const identity = crypto.createHash("sha256").update(JSON.stringify([
    engineVersion, engineDigest.toLowerCase(), template.version, template.asset.sha256.toLowerCase()
  ])).digest("hex").slice(0, 24);
  return `${engineVersion}-template-${template.version}-${identity}`;
}
function assetUrlAllowed(url, repository, tag, filename) {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && value.hostname === "github.com" && !value.username && !value.password &&
      !value.search && !value.hash && value.pathname === `/Sikarugir-App/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
  } catch { return false; }
}
function identifiedAsset(asset, repository, tag) {
  const digest = githubAssetDigest(asset);
  if (!digest || !Number.isSafeInteger(asset?.size) || asset.size < 1 || asset.size > MAXIMUM_ASSET_BYTES ||
    !assetUrlAllowed(asset.browser_download_url, repository, tag, asset.name)) return null;
  return { filename: asset.name, url: asset.browser_download_url, sha256: digest, bytes: asset.size,
    ...(Number.isSafeInteger(asset.id) && asset.id > 0 ? { assetId: asset.id } : {}), integritySource: "github-published-sha256" };
}
function entryFor(engine, asset, template, releaseTag = "v1.0") {
  return {
    version: snapshotVersion(engine.version, asset.sha256, template),
    versionLabel: `${engine.major}.${engine.minor} · revision ${engine.revision} · ${asset.sha256.slice(0, 8)} · support ${template.version} (${template.asset.sha256.slice(0, 8)})`,
    engineVersion: engine.version, engineName: asset.filename.replace(/\.tar\.xz$/, ""),
    // A binary asset's checksum identifies the consumed engine. The release
    // repository is a packaging catalog and does not identify its Wine source.
    upstreamRevision: `WS12WineSikarugir${engine.version}:sha256:${asset.sha256}`,
    upstreamTag: releaseTag, sourceUrl: SOURCE_URL, minimumMacOS: "14.0",
    hostArchitectures: ["arm64", "x64"], localBuild: false, asset,
    template: { ...template, asset: { ...template.asset } },
    downloadBytes: asset.bytes + template.asset.bytes
  };
}
const LATEST_ENTRY = Object.freeze(entryFor(parseEngineName("WS12WineSikarugir11.0_1.tar.xz"), Object.freeze({
  filename: "WS12WineSikarugir11.0_1.tar.xz", bytes: 167322744, assetId: 602173037,
  url: "https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir11.0_1.tar.xz",
  sha256: "67e29fb3d74f363af39c69ba11f9b13a79812c5db07cf4748672658e4a200a0e", integritySource: "github-published-sha256"
}), DEFAULT_TEMPLATE));
const DEFAULT_ENTRY = Object.freeze(entryFor(parseEngineName("WS12WineSikarugir10.0_8.tar.xz"), Object.freeze({
  filename: "WS12WineSikarugir10.0_8.tar.xz", bytes: 166321980, assetId: 604320750,
  url: "https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir10.0_8.tar.xz",
  sha256: "2a6bcf2a3bf13cddf825599b6bc1e3659cbf71e1282c6d77141a92f6ac8d4c68", integritySource: "github-published-sha256"
}), DEFAULT_TEMPLATE));
const PREVIOUS_ENTRY = DEFAULT_ENTRY;
const DEFAULT_VERSION = DEFAULT_ENTRY.version;

function validateEntry(pin) {
  try {
    const engine = parseEngineName(pin?.asset?.filename), template = pin?.template;
    const templateTag = new URL(template?.asset?.url).pathname.split("/")[5];
    return Boolean(engine && engine.version === pin.engineVersion && pin.version === snapshotVersion(engine.version, pin.asset.sha256, template) &&
      assetUrlAllowed(pin.asset.url, "Engines", pin.upstreamTag, pin.asset.filename) &&
      template.asset.filename === `Template-${template.version}.tar.xz` &&
      assetUrlAllowed(template.asset.url, "Template", templateTag, template.asset.filename) &&
      [pin.asset.bytes, template.asset.bytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_ASSET_BYTES));
  } catch { return false; }
}

function createDiscovery(dependencies = {}) {
  return async ({ signal, logger } = {}) => {
    throwIfAborted(signal);
    const fetch = dependencies.fetchGithubReleases || Github.fetchGithubReleases;
    const [engines, templates] = await Promise.all([
      fetch({ owner: "Sikarugir-App", repo: "Engines", includePrerelease: true, maxPages: 5, signal, logger,
        assetFilter: asset => Boolean(parseEngineName(asset.name)) }),
      fetch({ owner: "Sikarugir-App", repo: "Template", includePrerelease: true, maxPages: 5, signal, logger,
        assetFilter: asset => /^Template-1\.0\.(\d+)\.tar\.xz$/.test(asset.name) && Number(/^Template-1\.0\.(\d+)/.exec(asset.name)[1]) >= 19 })
    ]);
    throwIfAborted(signal);
    const support = [];
    let inspected = 0;
    for (const release of templates.slice(0, 500)) {
      if (release.draft || typeof release.tag_name !== "string") continue;
      for (const asset of (release.assets || []).slice(0, 500)) {
        if (++inspected > 2500) throw new Error("Sikarugir support catalog exceeds its supported size.");
        const match = /^Template-(\d+)\.(\d+)\.(\d+)\.tar\.xz$/.exec(asset.name || "");
        const pin = match && identifiedAsset(asset, "Template", release.tag_name);
        if (!pin || Number(match[1]) !== 1 || Number(match[2]) !== 0 || Number(match[3]) < 19) continue;
        support.push({ version: match.slice(1).join("."), minimumMacOS: "14.0", asset: pin });
      }
    }
    support.sort((a, b) => Number(b.version.split(".")[2]) - Number(a.version.split(".")[2]));
    if (!support.length) throw new Error("No compatible Sikarugir support archive is available.");
    const result = [], seen = new Set();
    inspected = 0;
    for (const release of engines.slice(0, 500)) {
      throwIfAborted(signal);
      if (release.draft || typeof release.tag_name !== "string") continue;
      for (const asset of (release.assets || []).slice(0, 500)) {
        if (++inspected > 2500) throw new Error("Sikarugir engine catalog exceeds its supported size.");
        const engine = parseEngineName(asset.name), pin = engine && identifiedAsset(asset, "Engines", release.tag_name);
        if (!pin) continue;
        const row = entryFor(engine, pin, support[0], release.tag_name);
        if (!seen.has(row.version)) { seen.add(row.version); result.push(row); }
      }
    }
    result.sort((a, b) => {
      const left = parseEngineName(a.asset.filename), right = parseEngineName(b.asset.filename);
      return right.major - left.major || right.minor - left.minor || right.revision - left.revision || a.version.localeCompare(b.version);
    });
    if (result.length > 500) throw new Error("Sikarugir engine catalog exceeds its supported size.");
    return result;
  };
}

module.exports = { SOURCE_URL, TEMPLATE_SOURCE_URL, DEFAULT_ENTRY, LATEST_ENTRY, PREVIOUS_ENTRY, DEFAULT_TEMPLATE,
  DEFAULT_VERSION, parseEngineName, snapshotVersion, assetUrlAllowed, identifiedAsset, entryFor, validateEntry, createDiscovery };
