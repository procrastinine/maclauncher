const fs = require("node:fs");
const path = require("node:path");
const Upstream = require("./upstream");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("./runtime-catalog");
const Host = require("./dotnet-tool-host");

const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-z0-9][a-z0-9.-]*)?$/i;
const SOURCE = "https://www.nuget.org/packages/ilspycmd";
const LIMITS = Object.freeze({ versions: 128 });
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
// Folders holding the command-line tool, newest framework first: the tool
// may move below tools/<framework>/ and a package may carry several targets.
const TOOL_CONFIG = "ilspycmd.runtimeconfig.json";
function toolDirectories(names) {
  const rank = framework => framework.replace(/^net(?:coreapp)?/, "").split(".").map(Number);
  return names.flatMap(name => {
    const match = /^tools\/(net(?:coreapp)?\d+\.\d+)\/(?:[^/]+\/){0,3}ilspycmd\.runtimeconfig\.json$/.exec(name || "");
    return match ? [{ framework: match[1], prefix: name.slice(0, -TOOL_CONFIG.length) }] : [];
  }).sort((a, b) => {
    const [x, y] = [rank(a.framework), rank(b.framework)];
    return Number(Host.supported(b.framework)) - Number(Host.supported(a.framework)) || y[0] - x[0] || y[1] - x[1] ||
      Number(b.prefix.endsWith("/any/")) - Number(a.prefix.endsWith("/any/")) || a.prefix.length - b.prefix.length;
  });
}
// ilspycmd's NuGet versions with the package digest NuGet publishes. The
// package listing names the tool's framework and folder; without a listing,
// installation reads both from the package itself.
const REQUIRED = ["ilspycmd.dll", "ilspycmd.deps.json", "ICSharpCode.Decompiler.dll"];
const recognize = ({ version, entry, files }) => {
  try { version = normalizeVersion(version); } catch { return null; }
  const entries = Array.isArray(entry?.packageEntries) ? entry.packageEntries.map(item => item?.fullName) : null;
  const tool = entries && toolDirectories(entries)[0], repository = entry?.repository;
  const revision = repository?.type === "git" && /^https:\/\/github\.com\/icsharpcode\/ILSpy\/?$/i.test(repository.url || "") &&
    /^[a-f0-9]{40}$/i.test(repository.commit || "") ? repository.commit.toLowerCase() : null;
  return { version, files, sourceUrl: SOURCE + "/" + version, ...(revision ? { revision } : {}),
    ...(!entries || tool && REQUIRED.every(name => entries.includes(tool.prefix + name)) ? {} : { installReason: "This package's tool layout is unsupported." }),
    details: { framework: tool?.framework || null, license: entry?.licenseExpression || null } };
};
const source = Upstream.nuget({ id: "ilspycmd", recognize });
// A tool published per runtime identifier leaves only a pointer in ilspycmd;
// the framework-dependent build is NuGet's ilspycmd.any package of the same
// version, which then supplies that version's download.
const runtimeSource = Upstream.nuget({ id: "ilspycmd.any", recognize });
// The newest versions in the cached row shape, each listed once.
async function discover({ signal, logger } = {}) {
  const [main, any] = await Promise.all([source.discover({ signal, logger }), runtimeSource.discover({ signal, logger }).catch(error => {
    if (signal?.aborted) throw error;
    logger?.warn?.("[ilspy] ilspycmd.any: " + (error.message || error)); return [];
  })]);
  const rows = new Map();
  for (const row of [...main, ...any]) {
    const [listed] = row.files, previous = rows.get(row.version);
    if (!listed || previous && (!previous.installReason || row.installReason)) continue;
    rows.set(row.version, { version: row.version, framework: row.details?.framework || null, ...(row.installReason ? { installReason: row.installReason } : {}),
      sourceRevision: row.revision || null, upstreamRevision: row.revision || "nuget:ilspycmd@" + row.version, sourceUrl: row.sourceUrl,
      publishedAt: row.publishedAt || null, license: row.details?.license || null, url: listed.url,
      ...(listed.digest ? { [listed.digest.algorithm]: listed.digest.value } : {}), ...(listed.bytes ? { bytes: listed.bytes } : {}) });
  }
  const result = [...rows.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, LIMITS.versions);
  logger?.info?.("[ilspy] " + result.length + " NuGet versions");
  return result;
}
// Cached rows keep the shape earlier versions wrote. A row without NuGet's
// digest installs with its SHA-256 recorded.
function validEntry(row) {
  try {
    return row && normalizeVersion(row.version) === row.version && new URL(row.url).protocol === "https:" &&
      (row.framework == null || /^net(?:coreapp)?\d+\.\d+$/.test(row.framework)) &&
      (!row.minimumRuntime || /^\d+\.\d+\.\d+$/.test(row.minimumRuntime)) &&
      (!row.sourceRevision || /^[a-f0-9]{40}$/.test(row.sourceRevision)) &&
      (!row.sha512 || /^[a-f0-9]{128}$/.test(row.sha512)) && (!row.sha256 || /^[a-f0-9]{64}$/.test(row.sha256)) &&
      (row.bytes == null || Number.isSafeInteger(row.bytes) && row.bytes > 0);
  } catch { return false; }
}
function cachedCatalog(userDataDir) {
  return readRuntimeCatalog({ userDataDir, managerId: "ilspy", maxEntries: LIMITS.versions, validateEntry: validEntry });
}
function pins(userDataDir) {
  const cached = cachedCatalog(userDataDir), rows = new Map();
  for (const row of [...(cached?.retainedEntries || []), ...(cached?.entries || [])]) rows.set(row.version, row);
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
module.exports = { VERSION, SOURCE, LIMITS, source, normalizeVersion, compareVersions, packageUrl,
  toolDirectories, discover, validEntry, cachedCatalog, pins, pinFor, saveCatalog };

