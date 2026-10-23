const { fetchUrlBuffer, throwIfAborted } = require("./download-utils");

const SHA256 = /^[a-f0-9]{64}$/;
const ARCHITECTURES = new Set(["arm64", "x64", "universal"]);
const LAUNCHER_ARCHITECTURES = new Set(["arm64", "x64"]);
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checksum(value) {
  return typeof value === "string" && SHA256.test(value);
}

function identity({ projectId, repository } = {}) {
  if (typeof projectId !== "string" || projectId.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId))
    throw new Error("A runtime catalog requires a valid project ID.");
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
      repository.includes("..") || repository.split("/").some(part => part.endsWith(".")))
    throw new Error("A runtime catalog requires an explicit GitHub owner/repository.");
  return { projectId, repository };
}

function catalogUrl(options) {
  const { projectId, repository } = identity(options);
  return `https://raw.githubusercontent.com/${repository}/main/catalogs/${projectId}.json`;
}

function version(value) {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock");
}

function relativeFile(value) {
  return typeof value === "string" && value.length <= 1024 && value.split("/").every(part =>
    part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

/** Validate the complete project catalog before selecting compatible records. */
function validateProjectCatalog(catalog, options = {}) {
  const { projectId, repository } = identity(options);
  if (options.architecture !== undefined && !LAUNCHER_ARCHITECTURES.has(options.architecture))
    throw new Error("Choose an ARM or Intel launcher architecture.");
  if (!object(catalog) || catalog.schemaVersion !== 2 || catalog.projectId !== projectId ||
      catalog.updatePolicy !== "manual" || !Array.isArray(catalog.packages))
    throw new Error("The runtime catalog does not match the selected project or update policy.");

  const seen = new Set();
  const packages = Array.from(catalog.packages).map(record => {
    if (!object(record) || record.schemaVersion !== 2 || record.id !== projectId || record.updatePolicy !== "manual" ||
        !version(record.version) || !ARCHITECTURES.has(record.arch) ||
        !Array.isArray(record.launcherArchitectures) || record.launcherArchitectures.length < 1 ||
        Array.from(record.launcherArchitectures).some(arch => !LAUNCHER_ARCHITECTURES.has(arch)) ||
        new Set(record.launcherArchitectures).size !== record.launcherArchitectures.length ||
        typeof record.minimumMacOS !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(record.minimumMacOS) ||
        Number(record.minimumMacOS.split(".")[0]) < 1 || !relativeFile(record.manifestRelative) ||
        !checksum(record.manifestSha256) || !checksum(record.sourceSha256) || !object(record.asset))
      throw new Error("The runtime catalog contains an invalid package record.");

    const key = `${record.version}/${record.arch}`;
    if (seen.has(key)) throw new Error("The runtime catalog repeats a version and architecture.");
    seen.add(key);
    const tag = `${projectId}/v${record.version}/${record.arch}`;
    const filename = `${projectId}-${record.version}-${record.arch}.tar.gz`;
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}`;
    if (record.tag !== tag || record.asset.filename !== filename || record.asset.url !== url ||
        !checksum(record.asset.sha256) || !Number.isSafeInteger(record.asset.bytes) ||
        record.asset.bytes < 1 || record.asset.bytes > MAX_ARCHIVE_BYTES)
      throw new Error("The runtime download does not match its project, version, architecture or repository.");

    let sourceAsset;
    if (record.sourceAsset !== undefined) {
      const source = record.sourceAsset;
      if (!object(source) || source.filename !== `${record.version}-source.tar.gz` ||
          !source.filename.endsWith("-source.tar.gz") || !checksum(source.sha256) ||
          !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_ARCHIVE_BYTES ||
          source.url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${source.filename}`)
        throw new Error("The runtime source download does not match its release.");
      sourceAsset = Object.freeze({ filename: source.filename, url: source.url, sha256: source.sha256, bytes: source.bytes });
    }
    let source;
    if (record.source !== undefined) {
      const value = record.source;
      identity({ projectId, repository: value?.repository });
      if (!object(value) || !/^[a-f0-9]{40}$/.test(value.revision || '') ||
          value.path !== undefined && !relativeFile(value.path))
        throw new Error("The runtime source must identify a pinned source commit.");
      source = Object.freeze({ repository: value.repository, revision: value.revision,
        ...(value.path === undefined ? {} : { path: value.path }) });
    }
    return Object.freeze({ schemaVersion: 2, id: projectId, version: record.version, arch: record.arch,
      launcherArchitectures: Object.freeze([...record.launcherArchitectures]), minimumMacOS: record.minimumMacOS,
      manifestRelative: record.manifestRelative, manifestSha256: record.manifestSha256,
      sourceSha256: record.sourceSha256, updatePolicy: "manual", tag,
      asset: Object.freeze({ filename, sha256: record.asset.sha256, bytes: record.asset.bytes, url }),
      ...(sourceAsset ? { sourceAsset } : {}), ...(source ? { source } : {}) });
  });

  return Object.freeze({ schemaVersion: 2, projectId, updatePolicy: "manual",
    packages: Object.freeze(packages.filter(record => options.architecture === undefined ||
      record.launcherArchitectures.includes(options.architecture))) });
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

module.exports = { catalogUrl, validateProjectCatalog, fetchProjectCatalog };
