const { fetchUrlBuffer, throwIfAborted } = require("./download-utils");

const { packageRecord, object, identity, version, contract } = require("./package-contract.cjs");
const LAUNCHER_ARCHITECTURES = new Set(["arm64", "x64"]);
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function catalogUrl(options) {
  const { projectId, repository } = identity(options);
  return `https://raw.githubusercontent.com/${repository}/main/catalogs/${projectId}.json`;
}

function preferredPackages(catalog) {
  const versions = new Map();
  for (const record of catalog.packages) {
    const previous = versions.get(record.version);
    // One UI version maps to one payload. Preserve a complete universal build
    // when both it and an architecture-specific publication are available.
    if (!previous || record.arch === "universal" && previous.arch !== "universal") versions.set(record.version, record);
  }
  return [...versions.values()];
}

function options(value) {
  const { projectId, repository } = identity(value);
  if (value.architecture !== undefined && !LAUNCHER_ARCHITECTURES.has(value.architecture))
    throw new Error("Choose an ARM or Intel launcher architecture.");
  return { projectId, repository, architecture: value.architecture, launcherContract: contract(value.launcherContract) };
}

// A later record schema or launcher contract is reported, not misread. Unknown
// fields are additive and ignored.
/** Validate one record, for example an installed package's recorded catalog entry. */
function validateProjectRecord(record, value = {}) {
  const selected = options(value), result = packageRecord(record, selected);
  if (selected.architecture !== undefined && !result.launcherArchitectures.includes(selected.architecture))
    throw new Error("The selected runtime does not support this Mac.");
  return result;
}

/** Validate each record separately. A named record that cannot be used stays
 * listed in `unavailable` with its reason; only the catalog envelope is fatal. */
function validateProjectCatalog(catalog, value = {}) {
  const selected = options(value), { projectId, architecture } = selected;
  if (!object(catalog) || !Number.isSafeInteger(catalog.schemaVersion) || catalog.schemaVersion < 2 || catalog.projectId !== projectId ||
      catalog.updatePolicy !== "manual" || !Array.isArray(catalog.packages))
    throw new Error("The runtime catalog does not match the selected project or update policy.");
  const rows = Array.from(catalog.packages).map(record => {
    try { return { value: record, record: packageRecord(record, selected) }; }
    catch (error) { return { value: record, reason: error.message }; }
  });
  const key = record => `${record.version}/${record.arch}`, counts = new Map();
  for (const { record } of rows) if (record) counts.set(key(record), (counts.get(key(record)) || 0) + 1);
  for (const row of rows) if (row.record && counts.get(key(row.record)) > 1)
    Object.assign(row, { record: null, reason: "The runtime catalog repeats this version and architecture." });
  // Records for another known Mac CPU are not offered here. A record naming a
  // CPU this launcher does not know stays listed with its reason.
  const forHost = list => architecture === undefined || !Array.isArray(list) ||
    list.some(arch => arch === architecture || !LAUNCHER_ARCHITECTURES.has(arch));
  const packages = rows.flatMap(({ record }) => record && forHost(record.launcherArchitectures) ? [record] : []);
  const listed = new Set(packages.map(record => record.version)), unavailable = new Map();
  for (const { value, record, reason } of rows) {
    if (record || !object(value) || !version(value.version) || listed.has(value.version) || unavailable.has(value.version) ||
        !forHost(value.launcherArchitectures)) continue;
    unavailable.set(value.version, Object.freeze({ version: value.version, reason }));
  }
  return Object.freeze({ schemaVersion: 2, projectId, updatePolicy: "manual",
    packages: Object.freeze(packages), unavailable: Object.freeze([...unavailable.values()]) });
}

/** Catalog rows for listed records that cannot be installed by this launcher. */
function unavailablePins(projectId, rows = []) {
  return rows.map(({ version, reason, upstreamRevision = "unavailable" }) => ({ version, upstreamRevision, localBuild: false,
    installReason: reason, projectPackage: Object.freeze({ id: projectId, version, unavailable: true }) }));
}

/** Explicit refresh only. Importing this module and validation perform no I/O. */
async function fetchProjectCatalog(options = {}, dependencies = {}) {
  const url = catalogUrl(options);
  if (options.architecture !== undefined && !LAUNCHER_ARCHITECTURES.has(options.architecture))
    throw new Error("Choose an ARM or Intel launcher architecture.");
  throwIfAborted(options.signal);
  const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(url, {
    headers: { "User-Agent": "MacLauncher", Accept: "application/json" }, signal: options.signal,
    maxBytes: MAX_CATALOG_BYTES, maxRedirects: 0
  });
  throwIfAborted(options.signal);
  if (response?.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > MAX_CATALOG_BYTES)
    throw new Error("The runtime catalog could not be downloaded.");
  let catalog;
  try { catalog = JSON.parse(response.body.toString("utf8")); }
  catch { throw new Error("The runtime catalog is not valid JSON."); }
  return validateProjectCatalog(catalog, options);
}

module.exports = { catalogUrl, validateProjectRecord, validateProjectCatalog, fetchProjectCatalog, preferredPackages, unavailablePins };
