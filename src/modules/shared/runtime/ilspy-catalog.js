const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const { fetchUrlBuffer, throwIfAborted } = require("./download-utils");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("./runtime-catalog");

const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-z0-9][a-z0-9.-]*)?$/i;
const SOURCE = "https://www.nuget.org/packages/ilspycmd";
const INDEX = "https://api.nuget.org/v3/index.json";
const LIMITS = Object.freeze({ versions: 128, pages: 8, pageItems: 64, responseBytes: 2 * 1024 * 1024, packageBytes: 32 * 1024 * 1024 });
function normalizeVersion(version) {
  const value = typeof version === "string" ? version.trim().replace(/^v(?=\d)/i, "").toLowerCase() : "";
  if (!VERSION.test(value)) throw new Error("Unsupported ILSpy version.");
  return value;
}
const packageUrl = version => "https://api.nuget.org/v3-flatcontainer/ilspycmd/" + normalizeVersion(version) + "/ilspycmd." + normalizeVersion(version) + ".nupkg";
function compareVersions(a, b) {
  const [baseA, preA] = a.split("-"), [baseB, preB] = b.split("-");
  const partsA = baseA.split(".").map(Number), partsB = baseB.split(".").map(Number);
  for (let i = 0; i < 4; i++) { const result = (partsA[i] || 0) - (partsB[i] || 0); if (result) return result; }
  return !preA && preB ? 1 : preA && !preB ? -1 : (preA || "").localeCompare(preB || "", undefined, { numeric: true });
}
function trustedUrl(value, prefix) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "api.nuget.org" || url.username || url.password || url.search || url.hash ||
    !url.pathname.startsWith(prefix)) throw new Error("ILSpy package metadata has an unexpected source.");
  return url.href;
}
async function readJson(url, { request = fetchUrlBuffer, signal } = {}) {
  const response = await request(url, { signal, headers: { "User-Agent": "MacLauncher", Accept: "application/json" } });
  throwIfAborted(signal);
  if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > LIMITS.responseBytes) throw new Error("ILSpy version metadata is unavailable.");
  const body = /gzip/i.test(response.headers?.["content-encoding"] || "")
    ? zlib.gunzipSync(response.body, { maxOutputLength: LIMITS.responseBytes }) : response.body;
  if (body.length > LIMITS.responseBytes) throw new Error("ILSpy version metadata exceeds its limit.");
  return JSON.parse(body.toString("utf8"));
}
function metadataEntry(data, version, catalogUrl) {
  version = normalizeVersion(version);
  if (data?.id?.toLowerCase() !== "ilspycmd" || normalizeVersion(data.version) !== version || data.packageHashAlgorithm !== "SHA512" ||
    typeof data.packageHash !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(data.packageHash) ||
    !Number.isSafeInteger(data.packageSize) || data.packageSize < 1 || data.packageSize > LIMITS.packageBytes ||
    !Array.isArray(data.packageEntries) || data.packageEntries.length > 1000) throw new Error("ILSpy package metadata is incomplete.");
  const hash = Buffer.from(data.packageHash, "base64");
  if (hash.length !== 64 || hash.toString("base64") !== data.packageHash) throw new Error("ILSpy package digest is invalid.");
  const frameworks = [...new Set(data.packageEntries.flatMap(entry => {
    const match = /^tools\/(net(?:coreapp)?\d+\.\d+)\/any\/ilspycmd\.runtimeconfig\.json$/.exec(entry.fullName || "");
    return match ? [match[1]] : [];
  }))];
  const framework = frameworks.length === 1 ? frameworks[0] : null, prefix = "tools/" + framework + "/any/";
  const complete = framework && ["ilspycmd.dll", "ilspycmd.deps.json", "ICSharpCode.Decompiler.dll"]
    .every(name => data.packageEntries.some(item => item.fullName === prefix + name));
  const repository = data.repository;
  const sourceRevision = repository && repository.type === "git" && /^https:\/\/github\.com\/icsharpcode\/ILSpy\/?$/i.test(repository.url || "") &&
    /^[a-f0-9]{40}$/i.test(repository.commit || "") ? repository.commit.toLowerCase() : null;
  return { version, framework, ...(complete ? {} : { installReason: "This package's tool layout is unsupported." }),
    sourceRevision, upstreamRevision: sourceRevision || "nuget:ilspycmd@" + version,
    sourceUrl: SOURCE + "/" + version, metadataUrl: trustedUrl(catalogUrl, "/v3/catalog0/data/"),
    publishedAt: data.published || null, license: data.licenseExpression || null,
    url: packageUrl(version), sha512: hash.toString("hex"), bytes: data.packageSize };
}
async function discover({ request, signal, logger } = {}) {
  const options = { request, signal }, index = await readJson(INDEX, options);
  const resource = index.resources?.find(item => item["@type"] === "RegistrationsBaseUrl/3.6.0");
  if (!resource) throw new Error("NuGet package registration metadata is unavailable.");
  const base = trustedUrl(resource["@id"], "/v3/registration"), registration = await readJson(base + "ilspycmd/index.json", options);
  if (!Array.isArray(registration.items) || registration.items.length > LIMITS.pages) throw new Error("ILSpy version history exceeds its page limit.");
  const leaves = [];
  for (const descriptor of registration.items) {
    const page = descriptor.items ? descriptor : await readJson(trustedUrl(descriptor["@id"], "/v3/registration"), options);
    if (!Array.isArray(page.items) || page.items.length > LIMITS.pageItems) throw new Error("ILSpy version page is invalid.");
    leaves.push(...page.items);
  }
  if (leaves.length > LIMITS.versions) throw new Error("ILSpy version history exceeds its limit.");
  const rows = new Map();
  for (const leaf of leaves) {
    const data = leaf.catalogEntry;
    if (data?.id?.toLowerCase() !== "ilspycmd" || data.listed === false || !VERSION.test(data.version || "")) continue;
    const version = normalizeVersion(data.version);
    if (leaf.packageContent !== packageUrl(version)) throw new Error("ILSpy package URL does not match its version.");
    rows.set(version, { version, metadataUrl: trustedUrl(data["@id"], "/v3/catalog0/data/") });
  }
  const sorted = [...rows.values()].sort((a, b) => compareVersions(b.version, a.version));
  const results = [];
  // Small metadata requests run in bounded parallel groups; no packages are downloaded.
  for (let i = 0; i < sorted.length; i += 4) {
    throwIfAborted(signal);
    results.push(...await Promise.all(sorted.slice(i, i + 4).map(async row =>
      metadataEntry(await readJson(row.metadataUrl, options), row.version, row.metadataUrl))));
  }
  logger?.info?.("[ilspy] " + results.length + " explicit NuGet versions");
  return results;
}
const PINS = Object.freeze({
  "9.1.0.7988": Object.freeze({ version: "9.1.0.7988", framework: "net8.0", minimumRuntime: "8.0.0",
    sourceRevision: "03b7444943e720b3134d296c0c8dd3876f8ea4ce",
    url: packageUrl("9.1.0.7988"), sourceUrl: SOURCE + "/9.1.0.7988",
    sha256: "2b5058f5ccc164c33b7aabf1a5eb0cf3d3a6af6c145aaf58efd3ed891443af7c" }),
  "11.1.0.9782": Object.freeze({ version: "11.1.0.9782", framework: "net10.0", minimumRuntime: "10.0.0",
    sourceRevision: "a6909b2e1062d2404a52711926fa74030bd96119",
    url: packageUrl("11.1.0.9782"), sourceUrl: SOURCE + "/11.1.0.9782",
    sha256: "74c07facaf1850c78a779fc509031f756e1c0de24b1a536f3363d7ef81ce001f",
    sha512: "17b0a5bbfad858fb7d7c29432f3660597234376fd1b78e2de6d3ae90e61466dd6d23c930653098f3311956022bede4e425086e645256e9127c1f34429709c842",
    bytes: 4632113 })
});
function validEntry(row) {
  try {
    return row && normalizeVersion(row.version) === row.version && row.url === packageUrl(row.version) &&
      row.sourceUrl === SOURCE + "/" + row.version &&
      (row.framework == null || /^net(?:coreapp)?\d+\.\d+$/.test(row.framework)) &&
      (!row.minimumRuntime || /^\d+\.\d+\.\d+$/.test(row.minimumRuntime)) &&
      (!row.sourceRevision || /^[a-f0-9]{40}$/.test(row.sourceRevision)) &&
      (/^[a-f0-9]{128}$/.test(row.sha512 || "") || /^[a-f0-9]{64}$/.test(row.sha256 || "")) &&
      (row.bytes == null || Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= LIMITS.packageBytes);
  } catch { return false; }
}
function cachedCatalog(userDataDir) {
  return readRuntimeCatalog({ userDataDir, managerId: "ilspy", maxEntries: LIMITS.versions, validateEntry: validEntry });
}
function pins(userDataDir) {
  const cached = cachedCatalog(userDataDir), rows = new Map();
  for (const row of [...(cached?.retainedEntries || []), ...(cached?.entries || []), ...Object.values(PINS)]) rows.set(row.version, row);
  return [...rows.values()].sort((a, b) => compareVersions(b.version, a.version));
}
function pinFor(version, userDataDir) {
  version = normalizeVersion(version);
  const selected = pins(userDataDir).find(row => row.version === version);
  if (selected) return selected;
  // Installed identities survive removal of a release from the public catalog.
  if (userDataDir) {
    const file = path.join(userDataDir, "runtimes", "fna-tools", "ilspy", version, "tool.json");
    try {
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 256 * 1024) {
        const row = JSON.parse(fs.readFileSync(file, "utf8")).catalogEntry;
        if (row?.version === version && validEntry(row)) return row;
      }
    } catch {}
  }
  throw new Error("Unsupported ILSpy version. Refresh ILSpy versions or select an available version.");
}
function saveCatalog(userDataDir, entries, retainedEntries = []) {
  if (!entries.every(validEntry) || !retainedEntries.every(validEntry)) throw new Error("ILSpy version metadata is invalid.");
  return writeRuntimeCatalog({ userDataDir, managerId: "ilspy", entries, retainedEntries, source: SOURCE, maxEntries: LIMITS.versions });
}
module.exports = { VERSION, SOURCE, LIMITS, normalizeVersion, compareVersions, packageUrl, trustedUrl, readJson, metadataEntry,
  discover, PINS, validEntry, cachedCatalog, pins, pinFor, saveCatalog };

