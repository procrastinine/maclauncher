const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Native = require("./local-native");
const { downloadToFile, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { buildRuntimeDownloadMeta } = require("./runtime-downloads");
const { catalogPath, readRuntimeCatalog, writeRuntimeCatalog } = require("./runtime-catalog");
const { systemVersionSync, versionAtLeast } = require("./bundled-native");
const Custom = require("./custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion } = require("./version-choices");

// Release stems retain their committed ordering; source hashes identify builds.
function compareRuntimeVersions(left, right) {
  const sourceID = /^(?=[a-f0-9]*[a-f])[a-f0-9]{7,}(?:[-_]|$)/i;
  if (sourceID.test(String(left)) || sourceID.test(String(right))) return 0;
  const stem = value => String(value).replace(/[-_][a-f0-9]{7,}(?:[-_].*)?$/i, "");
  const a = stem(left), b = stem(right);
  if (a === b) return 0;
  const release = /^(\d+(?:\.\d+)+)(?:-(.+))?$/;
  const aa = release.exec(a), bb = release.exec(b);
  if (aa && bb && aa[1] === bb[1] && Boolean(aa[2]) !== Boolean(bb[2])) return aa[2] ? 1 : -1;
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

function hashFile(filePath, algorithm = "sha256") {
  const hash = crypto.createHash(algorithm);
  const fd = fs.openSync(filePath, "r");
  try {
    const data = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, data, 0, data.length, null))) hash.update(data.subarray(0, count));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function extractPinnedArchive(archivePath, destination, signal) {
  const isZip = archivePath.endsWith(".zip");
  if (!isZip && !archivePath.endsWith(".tar.gz")) throw new Error("Unsupported pinned runtime archive.");
  return new Promise((resolve, reject) => {
    const child = spawn(isZip ? "/usr/bin/ditto" : "/usr/bin/tar",
      isZip ? ["-x", "-k", archivePath, destination] : ["-xzf", archivePath, "-C", destination],
      { ...(signal ? { signal } : {}), stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { if (error.length < 8192) error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Runtime extraction failed (${code}): ${error}`)));
  });
}

// Module preparation may return source/signature/payload evidence. Keep this
// nested, bounded and immutable; it cannot override the shared version,
// archive or executable identities and caller-owned objects are never retained.
function installationEvidence(value) {
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Runtime installation metadata must be a serializable object.");
  let nodes = 0;
  function clone(current, depth = 0) {
    if (++nodes > 4096 || depth > 12) throw new Error("Runtime installation metadata exceeds its structure limit.");
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (typeof current === "string" && current.length <= 16384) return current;
    if (Array.isArray(current) && current.length <= 512) return Object.freeze(current.map(item => clone(item, depth + 1)));
    if (current && typeof current === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(current))) {
      const pairs = Object.entries(current);
      if (pairs.length <= 512 && pairs.every(([key]) => key.length <= 256)) return Object.freeze(Object.fromEntries(pairs.map(([key, item]) => [key, clone(item, depth + 1)])));
    }
    throw new Error("Runtime installation metadata contains a non-serializable value.");
  }
  const output = clone(value);
  if (Buffer.byteLength(JSON.stringify(output)) > 65536) throw new Error("Runtime installation metadata exceeds its byte limit.");
  return output;
}

// Pinned identities stay available offline for exact selections. Discoverable
// release lists are displayed only after an explicit query or from a local cache.
// Every pinned manager offers the user's own default version, as other
// multi-version runtimes do, unless a game needs its exact engine version.
function createPinnedNativeManager({ id, label, catalog = [], discoverCatalog, projectBuilds, buildsRepository, upstreamUrl, upstreamLabel, resolveExecutable, inspectRuntime = Native.resolveLocalRuntime, verifyArtifact, validateRecordedArtifact, prepareInstall, buildRuntime, buildSourcePath, sourceUrl, buildHelpUrl, buildRequirements, bundledRuntime, legacyInstalledRuntime, bundledExecution = "copy", distributionRequired = false, importLocal = false, nativeLibrary = false, supportsDefault = true, maxEntries = 500, dependencies = {} }) {
  if (typeof distributionRequired !== "boolean") throw new Error("Runtime distribution requirements must be explicit booleans.");
  if (typeof importLocal !== "boolean") throw new Error("Local runtime imports must be explicitly enabled.");
  if (typeof nativeLibrary !== "boolean") throw new Error("Native library runtimes must be explicitly enabled.");
  if (typeof supportsDefault !== "boolean") throw new Error("Runtime default selection must be an explicit boolean.");
  if (typeof inspectRuntime !== "function") throw new Error("Runtime executable inspection requires a callback.");
  if (!/^[a-z0-9-]+$/.test(id || "") || !Array.isArray(catalog) || !catalog.length && typeof discoverCatalog !== "function" && !projectBuilds) {
    throw new Error("Pinned native manager needs an id and a version catalog.");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000) throw new Error("Pinned native catalog limit must be an integer from 1 to 2000.");
  if (buildRuntime !== undefined && typeof buildRuntime !== "function") throw new Error("Native source installation requires a build callback.");
  if (discoverCatalog !== undefined && typeof discoverCatalog !== "function") throw new Error("Native release discovery requires a catalog callback.");
  if (prepareInstall !== undefined && typeof prepareInstall !== "function") throw new Error("Native installation preparation requires a callback.");
  if (verifyArtifact !== undefined && typeof verifyArtifact !== "function") throw new Error("Runtime artifact verification requires a callback.");
  if (validateRecordedArtifact !== undefined && typeof validateRecordedArtifact !== "function") throw new Error("Publisher artifact validation requires a callback.");
  if (buildSourcePath !== undefined && (typeof buildSourcePath !== "string" || !path.isAbsolute(buildSourcePath))) throw new Error("Default runtime source checkout must be an absolute local path.");
  if (sourceUrl !== undefined && (typeof sourceUrl !== "string" || !sourceUrl.startsWith("https://"))) throw new Error("Runtime source URL must use HTTPS.");
  if (buildHelpUrl !== undefined && (typeof buildHelpUrl !== "string" || !/^https?:\/\//.test(buildHelpUrl))) throw new Error("Runtime setup URL must use HTTP or HTTPS.");
  if (bundledRuntime !== undefined && (!bundledRuntime || typeof bundledRuntime.resolve !== "function" ||
    typeof bundledRuntime.install !== "function" || typeof bundledRuntime.verifyInstalled !== "function")) {
    throw new Error("Bundled runtime integration requires resolve, install and verifyInstalled callbacks.");
  }
  if (!["copy", "direct"].includes(bundledExecution) || bundledExecution === "direct" && typeof bundledRuntime?.resolveRuntime !== "function")
    throw new Error("The included runtime cannot be resolved.");
  if (legacyInstalledRuntime !== undefined && typeof legacyInstalledRuntime?.verifyInstalled !== "function")
    throw new Error("Existing runtime installations require an integrity verifier.");
  const projectPackages = projectBuilds && require("./project-native-package").createProjectNativePackage(projectBuilds,
    { id, catalog, dependencies: dependencies.projectBuilds || {} });
  if (projectPackages) {
    const upstreamDiscovery = projectBuilds.upstreamMacDownloads === true ? discoverCatalog : null;
    discoverCatalog = async options => {
      if (options.sourceId === "builds") return projectPackages.discover(options);
      if (options.sourceId === "upstream") {
        if (!upstreamDiscovery) throw new Error("This runtime has no upstream Mac download source.");
        return upstreamDiscovery(options);
      }
      const [hosted, upstream] = await Promise.allSettled([
        projectPackages.discover(options), upstreamDiscovery ? upstreamDiscovery(options) : []
      ]);
      // A failed hosted provider retains the previous complete catalog.
      if (hosted.status === "rejected") throw hosted.reason;
      return [...hosted.value, ...(upstream.status === "fulfilled" ? upstream.value : [])];
    };
  }
  let manager;
  const sourceIds = projectPackages ? projectBuilds.upstreamMacDownloads === true ? ["builds", "upstream"] : ["builds"]
    : buildsRepository ? ["builds"] : ["upstream"];
  const catalogLimit = Math.min(2000, maxEntries * sourceIds.length);
  const entries = new Map();
  const validEntry = entry => Boolean(entry && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.version || "") &&
    typeof entry.upstreamRevision === "string" && entry.upstreamRevision && entry.upstreamRevision.length <= 200 &&
    (entry.minimumMacOS === undefined || typeof entry.minimumMacOS === "string" && /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(entry.minimumMacOS) && Number(entry.minimumMacOS.split(".")[0]) > 0) &&
    (!entry.asset || (/^https:\/\//.test(entry.asset.url || "") && (/^[a-f0-9]{64}$/.test(entry.asset.sha256 || "") ||
      (entry.asset.integrity === "publisher-md5" && /^[a-f0-9]{32}$/.test(entry.asset.md5 || "") && typeof verifyArtifact === "function") ||
      (entry.asset.integrity === "recorded-local" && ((Number.isSafeInteger(entry.asset.assetId) && entry.asset.assetId > 0 &&
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(entry.asset.url)) ||
        (typeof entry.asset.artifactId === "string" && entry.asset.artifactId.length > 0 && entry.asset.artifactId.length <= 256 &&
          Number.isSafeInteger(entry.asset.bytes) && entry.asset.bytes > 0 && validateRecordedArtifact?.(entry.asset, entry) === true)))) &&
      path.basename(entry.asset.filename || "") === entry.asset.filename && entry.asset.filename && ![".", ".."].includes(entry.asset.filename) && !entry.asset.filename.includes("\0") &&
      (entry.asset.expiresAt === undefined || typeof entry.asset.expiresAt === "string" && Number.isFinite(Date.parse(entry.asset.expiresAt))))));
  for (const entry of catalog) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.version || "") || !entry.upstreamRevision || entries.has(entry.version)) {
      throw new Error("Pinned runtime versions need unique safe names and upstream revisions.");
    }
    if (!validEntry(entry)) {
      throw new Error("Pinned runtime assets need an HTTPS URL, filename and SHA-256.");
    }
    entries.set(entry.version, Object.freeze({ ...entry,
      ...(entry.asset ? { asset: Object.freeze({ ...entry.asset }) } : {}) }));
  }
  let versions = [...entries.keys()];
  const baseVersions = versions.slice();
  const baseEntries = new Map(entries);
  let remoteEntries = [];
  const resolvedVersions = new Set();
  const canonicalVersion = version => typeof version === "string" ? version.trim().replace(/^v(?=\d)/i, "") : "";
  function managerDefault(userDataDir, { verification = "status", compatible } = {}) {
    const eligible = pin => !pin.deprecated && !hostReason(pin) && !pin.installReason && (!compatible || compatible(pin));
    const preview = pin => Boolean(pin.prerelease || ["development", "nightly", "prerelease"].includes(pin.channel) || /(?:^|[._-])(?:alpha|beta|rc|pre|preview|dev|nightly)\d*(?:[._-]|$)/i.test(pin.version));
    const listed = remoteEntries.filter(pin => eligible(pin) && !assetReason(pin)).sort((a, b) => Number(preview(a)) - Number(preview(b)) || compareRuntimeVersions(a.version, b.version)).map(pin => pin.version);
    const installed = listed.length ? [] : listRuntimeRows(userDataDir).filter(row => row.ready !== false && eligible({ ...(entries.get(row.version) || row), ...(row.minimumMacOS ? { minimumMacOS: row.minimumMacOS } : {}) }) &&
      (verification === "status" || resolveInstalled({ userDataDir, version: row.version, verification }))).map(row => row.version).sort(compareRuntimeVersions);
    return managerDefaultVersion({ listed, installed });
  }
  function hostReason(pin) {
    if (pin?.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) return `${label} ${pin.version} does not support this Mac's ${process.arch} CPU.`;
    if (!pin?.minimumMacOS) return null;
    const actual = process.platform === "darwin" || dependencies.systemVersionSync
      ? (dependencies.systemVersionSync || systemVersionSync)() : null;
    return actual && versionAtLeast(actual, pin.minimumMacOS) ? null : `${label} ${pin.version} requires macOS ${pin.minimumMacOS}.`;
  }
  const assetReason = pin => pin?.asset?.expiresAt && Date.parse(pin.asset.expiresAt) <= (dependencies.now || Date.now)()
    ? "This build's download expired. Refresh versions to find a current build." : null;
  let discoveryState = { status: "idle", fetchedAt: null, error: null, source: sourceUrl || null, mode: null };
  const sourceStates = Object.fromEntries(sourceIds.map(sourceId => [sourceId, { status: "idle", fetchedAt: null, error: null, mode: null }]));
  const discoveryPromises = new Map();
  // UI broadcasts only revisit registration/executable metadata. Actual
  // selection, install and explicit Reload retain full integrity checks.
  const displayCache = new Map();
  const includedFailures = new Map();
  const DISPLAY_CACHE_LIMIT = 128;
  const loadedCaches = new Map();
  const loadedInstalledPins = new Map();
  let loadedCatalogDirectory = null;
  function metadataIdentity(file) {
    try {
      const stat = fs.statSync(file, {bigint: true});
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch { return null; }
  }
  const root = userDataDir => {
    if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new Error("An absolute launcher data directory is required.");
    return path.join(userDataDir, "runtimes", id);
  };
  const entrySource = entry => entry.catalogSourceId || (entry.projectPackage ? "builds" : "upstream");
  function mergeEntries(incoming, sourceId) {
    if (!Array.isArray(incoming) || incoming.length > (sourceId ? maxEntries : catalogLimit) || !incoming.every(validEntry)) throw new Error("Discovered runtime catalog contains invalid version or artifact identities.");
    const selected = incoming.map(entry => sourceId ? { ...entry, catalogSourceId: sourceId } : entry);
    const combined = sourceId ? [...remoteEntries.filter(entry => entrySource(entry) !== sourceId), ...selected]
      .sort((a, b) => sourceIds.indexOf(entrySource(a)) - sourceIds.indexOf(entrySource(b))) : selected;
    const deduplicated = new Map();
    for (const original of combined) {
      const version = canonicalVersion(original.version);
      if (deduplicated.has(version)) continue;
      const entry = { ...original, version,
        ...(original.sourceKind === "commit" ? {} : { upstreamTag: original.upstreamTag || original.version }) };
      deduplicated.set(version, entry);
      const base = baseEntries.get(version);
      // A bundled/reviewed source build may have the same reported version as a
      // different published tag. Keep its build identity, expose the publisher's
      // identity separately, and render the canonical version only once.
      entries.set(version, Object.freeze(base ? entry.projectPackage ? { ...base, ...entry } : { ...base, publishedRelease: entry }
        : { ...entry, ...(entry.asset ? { asset: Object.freeze({ ...entry.asset }) } : {}) }));
    }
    remoteEntries = [...deduplicated.values()];
    // Successful refresh replaces the remote list. Removed releases remain
    // resolvable through installed records, never as stale download options.
    versions = [...new Set([...deduplicated.keys(), ...baseVersions.filter(version => !baseEntries.get(version).asset), ...resolvedVersions])];
  }
  function loadCatalog(userDataDir) {
    if (userDataDir && loadedCatalogDirectory !== null && loadedCatalogDirectory !== userDataDir) {
      entries.clear();
      for (const [version, pin] of baseEntries) entries.set(version, pin);
      versions = baseVersions.slice(); remoteEntries = []; resolvedVersions.clear();
      loadedCaches.delete(userDataDir); loadedInstalledPins.delete(userDataDir);
      discoveryState = { status: "idle", fetchedAt: null, error: null, source: sourceUrl || null, mode: null };
      for (const sourceId of sourceIds) sourceStates[sourceId] = { ...discoveryState };
    }
    if (userDataDir) {
      loadedCatalogDirectory = userDataDir;
      const directory = root(userDataDir), stamp = metadataIdentity(directory);
      const previous = loadedInstalledPins.get(userDataDir), pending = previous?.pending || new Map();
      let names;
      if (!previous || previous.stamp !== stamp) {
        names = stamp ? fs.readdirSync(directory, {withFileTypes: true}).slice(0, 500)
          .filter(item => item.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)).map(item => item.name) : [];
        for (const name of pending.keys()) if (!names.includes(name)) pending.delete(name);
      } else {
        // A writer may create the version directory before its atomic receipt.
        names = [...pending.keys()].filter(name => metadataIdentity(path.join(directory, name, "runtime.json")) !== pending.get(name));
      }
      for (const name of names) {
        if (entries.has(name)) { pending.delete(name);continue; }
        const file = path.join(directory, name, "runtime.json"), identity = metadataIdentity(file);
        try {
          if (fs.statSync(file).size > 1024 * 1024) throw Error("Runtime metadata exceeds its limit.");
          const record = JSON.parse(fs.readFileSync(file, "utf8")), pin = record.catalogEntry;
          if (!validEntry(pin) || pin.version !== name || record.version !== name || record.upstreamRevision !== pin.upstreamRevision)
            throw Error("Runtime metadata does not match its version.");
          entries.set(name, Object.freeze(pin));pending.delete(name);
        } catch { pending.set(name, identity); }
      }
      loadedInstalledPins.set(userDataDir, {stamp, pending});
    }
    if (!userDataDir) return;
    const stamp = metadataIdentity(catalogPath(userDataDir, id));
    if (loadedCaches.has(userDataDir) && loadedCaches.get(userDataDir) === stamp) return;
    const cached = readRuntimeCatalog({ userDataDir, managerId: id, validateEntry: validEntry, maxEntries: catalogLimit });
    if (cached && (!sourceUrl || cached.source === sourceUrl)) {
      for (const entry of cached.retainedEntries || []) {
        if (validEntry(entry) && !entries.has(entry.version)) entries.set(entry.version, Object.freeze(entry));
        if (entry.resolvedForGame === true && validEntry(entry)) resolvedVersions.add(entry.version);
      }
      mergeEntries(cached.entries);
      discoveryState = { status: "success", fetchedAt: cached.fetchedAt, source: cached.source || sourceUrl || null, error: null, mode: null };
      for (const sourceId of sourceIds) {
        const state = cached.sourceStates?.[sourceId];
        sourceStates[sourceId] = state
          ? { status: ["idle", "success", "error"].includes(state.status) ? state.status : "idle", fetchedAt: Number.isFinite(state.fetchedAt) ? state.fetchedAt : null,
            error: typeof state.error === "string" ? state.error.slice(0, 8192) : null, mode: ["all", "latest"].includes(state.mode) ? state.mode : null }
          : { status: "success", fetchedAt: cached.fetchedAt, error: null, mode: null };
      }
      if (sourceIds.length === 1) discoveryState = { ...discoveryState, ...sourceStates[sourceIds[0]] };
    }
    loadedCaches.set(userDataDir, stamp);
  }
  function saveCatalog(userDataDir) {
    if (!userDataDir) return;
    writeRuntimeCatalog({ userDataDir, managerId: id, maxEntries: catalogLimit, entries: remoteEntries,
      retainedEntries: [...entries.values()].filter(entry => !versions.includes(entry.version) ||
        (entry.resolvedForGame === true && !remoteEntries.some(remote => remote.version === entry.version))),
      source: sourceUrl || null, fetchedAt: discoveryState.fetchedAt, sourceStates });
    loadedCaches.set(userDataDir, metadataIdentity(catalogPath(userDataDir, id)));
  }
  async function refreshCatalog({ userDataDir, logger, signal, force = false, latestOnly = false, sourceId } = {}) {
    if (sourceId === "default") sourceId = sourceIds[0];
    if (sourceId != null && !sourceIds.includes(sourceId)) throw new Error("This runtime download source is unavailable.");
    loadCatalog(userDataDir);
    if (sourceId == null && sourceIds.length > 1) {
      const results = await Promise.allSettled(sourceIds.map(sourceId => refreshCatalog({ userDataDir, logger, signal, force, latestOnly, sourceId })));
      if (results.every(result => result.status === "rejected")) throw results[0].reason;
      return getState({ userDataDir }).catalog;
    }
    sourceId ||= sourceIds[0];
    const mode = latestOnly === true ? "latest" : "all", previous = sourceStates[sourceId];
    if (!discoverCatalog) {
      if (userDataDir) { clearDisplayCache(userDataDir); listInstalled(userDataDir); }
      bundledRuntime?.clearCache?.();
      return getState({ userDataDir }).catalog;
    }
    if (!force && previous.mode === mode && previous.status === "success" && previous.fetchedAt && Date.now() - previous.fetchedAt < 6 * 3600000)
      return getState({ userDataDir }).catalog;
    const pending = discoveryPromises.get(sourceId);
    if (pending) {
      if (pending.mode === mode) return pending.promise;
      try { await pending.promise; } catch {}
      throwIfAborted(signal);
      return refreshCatalog({ userDataDir, logger, signal, force, latestOnly, sourceId });
    }
    if (userDataDir) { clearDisplayCache(userDataDir); listInstalled(userDataDir); }
    bundledRuntime?.clearCache?.();
    sourceStates[sourceId] = { ...previous, status: "loading", error: null, mode };
    discoveryState = { ...discoveryState, status: "loading", error: null, mode };
    const promise = (async () => {
      try {
        const discovered = await discoverCatalog({ logger, signal, latestOnly, sourceId });
        throwIfAborted(signal);
        mergeEntries(discovered, sourceId);
        const fetchedAt = Date.now();
        sourceStates[sourceId] = { status: "success", fetchedAt, error: null, mode };
        discoveryState = { status: "success", fetchedAt, source: sourceUrl || null, error: null, mode };
        saveCatalog(userDataDir);
        return getState({ userDataDir }).catalog;
      } catch (error) {
        sourceStates[sourceId] = { ...previous, status: "error", error: error.message || String(error) };
        discoveryState = { ...discoveryState, status: "error", error: error.message || String(error),
          ...(sourceIds.length === 1 ? { mode: previous.mode, fetchedAt: previous.fetchedAt } : {}) };
        throw error;
      } finally { discoveryPromises.delete(sourceId); }
    })();
    discoveryPromises.set(sourceId, { mode, promise });
    return promise;
  }
  function normalizeVersion(version) {
    const value = canonicalVersion(version);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.endsWith(".") || value.includes(".."))
      throw new Error(`Unsupported ${label} version '${value}'.`);
    return value;
  }
  const installDir = (userDataDir, version) => path.join(root(userDataDir), normalizeVersion(version));
  function normalizeSettings(settings) {
    const version = typeof settings?.defaultVersion === "string" ? settings.defaultVersion.trim() : "";
    return { defaultVersion: version && version !== "auto" ? version : null };
  }
  function clearDisplayCache(userDataDir) {
    includedFailures.clear();
    const directory = userDataDir && root(userDataDir);
    for (const key of displayCache.keys()) {
      if (!directory || key.startsWith(directory + path.sep)) displayCache.delete(key);
    }
  }
  function rememberDisplay(directory, key, install) {
    displayCache.delete(directory);
    if (displayCache.size >= DISPLAY_CACHE_LIMIT) displayCache.delete(displayCache.keys().next().value);
    displayCache.set(directory, { key, install });
  }
  function identity(file) {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Runtime metadata or executable is not a regular file.");
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
  }
  function resolveRegistration({ userDataDir, version, verification = "full" } = {}) {
    let directory, cacheKey;
    try {
      if (!["full", "status"].includes(verification)) return null;
      loadCatalog(userDataDir);
      const normalized = normalizeVersion(version);
      directory = installDir(userDataDir, normalized);
      const recordPath = path.join(directory, "runtime.json");
      if (fs.statSync(recordPath).size > 1024 * 1024) return null;
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      const pin = record.catalogEntry && validEntry(record.catalogEntry) && record.catalogEntry.version === normalized
        ? record.catalogEntry : entries.get(normalized);
      if (record.version !== normalized || record.upstreamRevision !== pin.upstreamRevision || record.bundledExecution === "direct" ||
        !/^[a-f0-9]{64}$/.test(record.binarySha256 || "") || !["local", "download", "bundled"].includes(record.source)) return null;
      if (hostReason(pin)) return null;
      const runtimePath = record.source === "local" ? record.runtimePath : path.resolve(directory, record.executableRelative || "");
      cacheKey = JSON.stringify([identity(recordPath), runtimePath, identity(runtimePath), pin.upstreamRevision,
        record.source === "bundled" && record.bundledManifestSha256 ? identity(path.join(directory, "bundle-manifest.json")) : null]);
      const cached = displayCache.get(directory);
      if (record.source === "download" && (!runtimePath.startsWith(directory + path.sep) ||
        (pin.asset?.sha256 ? record.archiveSha256 !== pin.asset.sha256
          : pin.asset?.integrity === "publisher-md5" ? record.archiveMd5 !== pin.asset.md5 || record.artifactVerification?.verified !== true ||
            record.artifactVerification.archiveSha256 !== record.archiveSha256 || !/^[a-f0-9]{64}$/.test(record.archiveSha256 || "")
          : pin.asset?.integrity !== "recorded-local" ||
            (pin.asset.assetId ? record.assetId !== pin.asset.assetId : record.artifactId !== pin.asset.artifactId || record.archiveBytes !== pin.asset.bytes) ||
            !/^[a-f0-9]{64}$/.test(record.archiveSha256 || "")))) return null;
      if (record.source === "bundled" && (!runtimePath.startsWith(directory + path.sep) ||
        !(legacyInstalledRuntime || bundledRuntime)?.verifyInstalled({ installDir: directory, record, pin, verification }))) {
        rememberDisplay(directory, cacheKey, null);
        return null;
      }
      let project;
      if (projectPackages && pin.projectPackage && record.source === "download") {
        project = projectPackages.inspectInstalled(directory, pin, { verification });
        if (runtimePath !== project.executablePath) return null;
      }
      if (verification === "status" && cached?.key === cacheKey) return cached.install;
      const native = inspectRuntime({ runtimePath, runtimeVersion: normalized,
        upstreamRevision: pin.upstreamRevision, expectedSha256: record.binarySha256, allowLibrary: nativeLibrary });
      // resolveLocalRuntime already hashes the executable against this record.
      const installed = { ...record, ...native, version: normalized, runtimePath, installDir: directory,
        ...(project ? {
          environmentRelative: Object.fromEntries(Object.entries(project.manifest.environmentRelative || {}).map(([key, value]) => [key, path.posix.join("project-payload/files", value)])),
          runtimeFiles: Object.fromEntries(Object.entries(project.manifest.runtimeFiles || {}).map(([key, value]) => [key, path.posix.join("project-payload/files", value)]))
        } : {}),
        ...(record.installationMetadata === undefined ? {} : { installationMetadata: installationEvidence(record.installationMetadata) }) };
      rememberDisplay(directory, cacheKey, installed);
      return installed;
    } catch {
      if (directory && cacheKey) rememberDisplay(directory, cacheKey, null);
      return null;
    }
  }
  function resolveIncluded({ version, verification = "full" } = {}) {
    if (bundledExecution !== "direct") return null;
    let normalized, key;
    try {
      normalized = normalizeVersion(version);
      const pin = entries.get(normalized), bundle = bundledRuntime.resolve({ version: normalized, upstreamRevision: pin.upstreamRevision, verification });
      if (!bundle) { includedFailures.delete(normalized); return null; }
      key = JSON.stringify([identity(path.join(bundle.directory, "manifest.json")),
        identity(path.join(bundle.directory, "files", bundle.manifest.executableRelative))]);
      if (verification === "status" && includedFailures.get(normalized)?.key === key) return null;
      const included = bundledRuntime.resolveRuntime({ version: normalized, upstreamRevision: pin.upstreamRevision, verification });
      if (!included || included.version !== normalized || included.upstreamRevision !== pin.upstreamRevision ||
        included.source !== "bundled" || included.bundledExecution !== "direct" || included.readOnly !== true || included.removable !== false ||
        included.installDir !== bundle.directory || included.bundledManifestSha256 !== bundle.manifestSha256)
        throw new Error("Direct runtime resolution differs from its selected sealed bundle.");
      includedFailures.delete(normalized);
      return included;
    } catch (error) {
      if (normalized) includedFailures.set(normalized, { key, error: error.message || String(error) });
      return null;
    }
  }
  function resolveInstalled(options = {}) {
    loadCatalog(options.userDataDir);
    const pin = entries.get(canonicalVersion(options.version));
    if (hostReason(pin)) return null;
    const registered = resolveRegistration(options);
    if (registered) return registered;
    // A damaged/incomplete user-selected registration must remain visible and
    // removable. Never silently substitute the app's included version for it.
    if (options.userDataDir) {
      try { if (fs.existsSync(installDir(options.userDataDir, options.version))) return null; } catch { return null; }
    }
    return resolveIncluded(options);
  }
  function listInstalled(userDataDir) {
    loadCatalog(userDataDir);
    return [...entries.keys()].map(version => resolveInstalled({ userDataDir, version })).filter(Boolean);
  }
  function listRuntimeRows(userDataDir) {
    loadCatalog(userDataDir);
    return [...entries.keys()].flatMap(version => {
      const installed = resolveInstalled({ userDataDir, version, verification: "status" });
      if (installed) return [{ ...installed, ready: true, status: "ready" }];
      const directory = userDataDir && installDir(userDataDir, version);
      if (!directory || !fs.existsSync(directory)) {
        const failure = includedFailures.get(version);
        return failure ? [{ version, source: "bundled", bundledExecution: "direct", readOnly: true, removable: false,
          ready: false, status: "damaged-bundled", upstreamRevision: entries.get(version).upstreamRevision, error: failure.error }] : [];
      }
      let record = null;
      try { record = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8")); } catch {}
      const pin = validEntry(record?.catalogEntry) && record.catalogEntry.version === version && record.upstreamRevision === record.catalogEntry.upstreamRevision
        ? record.catalogEntry : entries.get(version);
      // Keep damaged registrations and failed builds removable through the same
      // version row. Launch/default resolution continues to require a valid record.
      return [{ version, installDir: directory, ready: false,
        status: hostReason(pin) ? "unsupported-host" : record ? "damaged" : "incomplete", source: record?.source || "incomplete",
        minimumMacOS: pin.minimumMacOS,
        runtimePath: typeof record?.runtimePath === "string" ? record.runtimePath : null,
        installedAt: typeof record?.installedAt === "string" ? record.installedAt : null,
        upstreamRevision: entries.get(version).upstreamRevision,
        error: hostReason(pin) || (record ? "The runtime executable or its version record changed. Remove this registration and install/register the selected version again."
          : "This runtime installation or build is incomplete. Remove it before retrying.") }];
    });
  }
  function publishRecord(directory, record) {
    displayCache.delete(directory);
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.runtime-${crypto.randomUUID()}.json`);
    try {
      fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      fs.renameSync(temp, path.join(directory, "runtime.json"));
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  function registerLocal({ userDataDir, version, runtimePath, verifiedBuild } = {}) {
    loadCatalog(userDataDir);
    const normalized = normalizeVersion(version);
    const pin = entries.get(normalized);
    if (!pin) throw new Error(`Unsupported ${label} version '${normalized}'. Refresh available versions first.`);
    if (hostReason(pin)) throw new Error(hostReason(pin));
    if (pin.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) {
      throw new Error(`${label} ${normalized} supports ${pin.hostArchitectures.join(", ")}; this Mac uses ${process.arch}.`);
    }
    const native = inspectRuntime({ runtimePath, runtimeVersion: normalized, upstreamRevision: pin.upstreamRevision, allowLibrary: nativeLibrary });
    if (["arm64", "x86_64"].includes(pin.architecture) && !native.architectures.includes(pin.architecture)) {
      throw new Error(`${label} ${normalized} requires a ${pin.architecture} executable.`);
    }
    if (verifiedBuild && (verifiedBuild.sourceRevision !== pin.upstreamRevision ||
      !/^[a-f0-9]{64}$/.test(verifiedBuild.sourceTreeSha256 || "") ||
      (verifiedBuild.overlaySha256 != null && !/^[a-f0-9]{64}$/.test(verifiedBuild.overlaySha256)))) {
      throw new Error("The native build metadata does not match the selected source revision and SHA-256 values.");
    }
    const directory = installDir(userDataDir, normalized);
    if (fs.existsSync(path.join(directory, "runtime.json"))) {
      throw new Error(`${label} ${normalized} is already registered. Remove that registration before replacing it.`);
    }
    // Local build provenance is supplied by the user; recording a release pin does
    // not establish that an arbitrary executable was built from that source.
    publishRecord(directory, { version: normalized, upstreamRevision: pin.upstreamRevision,
      catalogEntry: pin,
      runtimePath: native.executablePath, binarySha256: hashFile(native.executablePath),
      source: "local", provenanceVerified: Boolean(verifiedBuild),
      ...(verifiedBuild ? { verifiedBuild: { ...verifiedBuild } } : {}), installedAt: new Date().toISOString() });
    return resolveInstalled({ userDataDir, version: normalized });
  }
  function resolveSelection(entry, settings, userDataDir, { verification = "full", version: selectedVersion, recommendedVersion, recommended, compatible } = {}) {
    loadCatalog(userDataDir);
    // An automatic version option leaves the game's own choice in place.
    const manual = [selectedVersion, entry?.runtimeData?.[id]?.version].find(value => selectRuntimeVersion({ manual: value }).version);
    const configured = settings?.runtimes?.[id], recommendation = recommendedVersion ?? recommended;
    const gameRecommendation = manual ? null : typeof recommendation === "function" ? recommendation() : recommendation;
    const saved = supportsDefault ? normalizeSettings(configured).defaultVersion : null;
    const layer = selectRuntimeVersion({ manual, recommended: gameRecommendation, defaultVersion: saved,
      fallback: manual || gameRecommendation || saved ? null : managerDefault(userDataDir, { verification, compatible }) });
    const version = layer.version ? canonicalVersion(layer.version) : null, pin = version && entries.get(version);
    const install = version && pin && !hostReason(pin) && (!compatible || compatible(pin)) &&
      resolveInstalled({ userDataDir, version, verification });
    const remote = new Set(remoteEntries.map(pin => canonicalVersion(pin.version)));
    if (!version) return { version: null, install: null, ready: false, requiresDownload: true,
      discoveryRequired: remote.size === 0,
      reason: `No ${label} versions are available to download.` };
    return { version, install, ready: Boolean(install), requiresDownload: !install, selectionSource: layer.source || "default",
      discoveryRequired: !pin || !remote.has(version), reason: install ? null : !entries.has(version)
      ? `${label} ${version} is not available. Available versions: ${versions.join(", ")}.`
      : hostReason(entries.get(version)) || (compatible && !compatible(entries.get(version)) ? `${label} ${version} has an incompatible runtime profile.` : null) || includedFailures.get(version)?.error ||
        (userDataDir && listRuntimeRows(userDataDir).find(row => row.version === version && row.status === "unsupported-host")?.error) ||
        (pin.projectPackage?.unavailable && pin.installReason) || `${label} ${version} is not installed, or its executable changed.` };
  }
  async function installVersion({ userDataDir, version, signal, onProgress, logger, sourceDir } = {}) {
    if (process.platform !== "darwin") throw new Error(`${label} installation requires macOS.`);
    loadCatalog(userDataDir);
    const normalized = normalizeVersion(version);
    const pin = entries.get(normalized);
    if (!pin) throw new Error(`Unsupported ${label} version '${normalized}'. Refresh available versions first.`);
    if (hostReason(pin)) throw new Error(hostReason(pin));
    if (pin.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) {
      throw new Error(`${label} ${normalized} supports ${pin.hostArchitectures.join(", ")}; this Mac uses ${process.arch}.`);
    }
    const existing = resolveInstalled({ userDataDir, version: normalized });
    if (existing) return existing;
    if (assetReason(pin)) throw new Error(assetReason(pin));
    if (!versions.includes(normalized)) throw new Error("This runtime release is no longer in the current upstream catalog. Existing installed copies can be used or removed.");
    const destination = installDir(userDataDir, normalized);
    const replacing = fs.existsSync(destination);
    if (replacing && (!pin.asset || !fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink()))
      throw new Error(`Remove the incomplete ${label} ${normalized} registration before replacing it.`);
    throwIfAborted(signal);
    if (bundledExecution === "direct" && bundledRuntime.resolve({ version: normalized, upstreamRevision: pin.upstreamRevision, verification: "full" })) {
      throw new Error(includedFailures.get(normalized)?.error || "The included runtime could not start. Reinstall MacLauncher or choose a compatible imported runtime.");
    }
    if (bundledRuntime) {
      const installed = await bundledRuntime.install({ manager, userDataDir, version: normalized, signal, onProgress, logger });
      throwIfAborted(signal);
      if (installed) {
        const verified = resolveInstalled({ userDataDir, version: normalized });
        if (installed.version !== normalized || !verified) throw new Error("Bundled runtime failed its selected version and integrity check.");
        return verified;
      }
    }
    if (pin.deprecated) throw new Error(pin.installReason || "This upstream runtime download is no longer available; choose a published release.");
    if (!pin.asset && buildRuntime && pin.localBuild !== false) {
      const built = await buildRuntime({ manager, userDataDir, version: normalized, sourceDir: sourceDir || buildSourcePath, logger, signal, onProgress });
      throwIfAborted(signal);
      const installed = resolveInstalled({ userDataDir, version: normalized });
      if (!built || built.version !== normalized || !installed) throw new Error("Native source build did not register the selected pinned runtime version.");
      return installed;
    }
    if (!pin.asset) throw new Error(pin.installReason || `${label} ${normalized} requires a local Mac build. A compatible runtime can be imported in Runtimes.`);
    fs.mkdirSync(root(userDataDir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(root(userDataDir), ".install-"));
    let preserveStaging = false;
    try {
      const archivePath = path.join(staging, pin.asset.filename);
      onProgress?.({ downloaded: 0, total: pin.asset.bytes || null, detail: "Downloading…" });
      await (dependencies.downloadToFile || downloadToFile)(pin.asset.url, archivePath, { signal, onProgress });
      const archiveBytes = fs.statSync(archivePath).size;
      const progressBytes = { downloaded: archiveBytes, total: archiveBytes };
      onProgress?.({ ...progressBytes, detail: "Checking download…" });
      if (pin.asset.bytes !== undefined && archiveBytes !== pin.asset.bytes) throw new Error(`${label} archive size does not match the selected release. No runtime was installed.`);
      const archiveSha256 = hashFile(archivePath);
      if (pin.asset.sha256 && archiveSha256 !== pin.asset.sha256) throw new Error(`${label} archive SHA-256 does not match the pinned release. No runtime was installed.`);
      const archiveMd5 = pin.asset.integrity === "publisher-md5" ? hashFile(archivePath, "md5") : null;
      if (archiveMd5 && archiveMd5 !== pin.asset.md5) throw new Error(`${label} archive MD5 does not match the publisher's legacy release metadata. No runtime was installed.`);
      // A legacy publisher digest alone is insufficient. The module must verify
      // the signed installer/author identity before any payload is extracted.
      const artifactVerification = verifyArtifact && !(projectPackages && pin.projectPackage) ? await verifyArtifact({ archivePath, archiveSha256, pin, signal, logger }) : null;
      if (pin.asset.integrity === "publisher-md5" && (artifactVerification?.verified !== true ||
        artifactVerification.archiveSha256 !== archiveSha256 || typeof artifactVerification.identity !== "string" || !artifactVerification.identity)) {
        throw new Error("The runtime's signed artifact identity could not be verified. No runtime was installed.");
      }
      throwIfAborted(signal);
      const unpacked = path.join(staging, "unpacked");
      fs.mkdirSync(unpacked);
      // Extraction happens only after checking a reviewed upstream artifact's digest.
      onProgress?.({ ...progressBytes, detail: "Extracting files…" });
      await (dependencies.extractArchive || (projectPackages && pin.projectPackage ? projectPackages.extract : extractPinnedArchive))(archivePath, unpacked, signal);
      onProgress?.({ ...progressBytes, detail: "Checking installation…" });
      const preparation = projectPackages && pin.projectPackage ? projectPackages.prepare : prepareInstall;
      const installationMetadata = preparation
        ? installationEvidence(await preparation({ unpacked, pin, userDataDir, signal, logger, onProgress })) : undefined;
      let installedPin = pin;
      if (installationMetadata?.minimumMacOS !== undefined) {
        const required = installationMetadata.minimumMacOS;
        if (typeof required !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(required) || Number(required.split(".")[0]) === 0)
          throw new Error("Runtime preparation returned an invalid macOS requirement.");
        if (!pin.minimumMacOS || versionAtLeast(required, pin.minimumMacOS)) installedPin = { ...pin, minimumMacOS: required };
        if (hostReason(installedPin)) throw new Error(hostReason(installedPin));
      }
      throwIfAborted(signal);
      const runtimePath = projectPackages && pin.projectPackage ? projectPackages.inspectInstalled(unpacked, pin).executablePath
        : (pin.resolveExecutable || resolveExecutable)(unpacked, pin);
      const native = inspectRuntime({ runtimePath, runtimeVersion: normalized, upstreamRevision: pin.upstreamRevision, allowLibrary: nativeLibrary });
      const executableRelative = path.relative(unpacked, native.executablePath);
      if (!executableRelative || executableRelative.startsWith("..") || path.isAbsolute(executableRelative)) throw new Error("Pinned runtime executable escaped the installation.");
      publishRecord(unpacked, { version: normalized, upstreamRevision: pin.upstreamRevision,
        catalogEntry: installedPin,
        binarySha256: hashFile(native.executablePath), executableRelative,
        archiveSha256, ...(archiveMd5 ? { archiveMd5 } : {}), ...(artifactVerification ? { artifactVerification } : {}),
        ...(installationMetadata === undefined ? {} : { installationMetadata }),
        assetUrl: pin.asset.url, assetId: pin.asset.assetId || null,
        ...(pin.asset.artifactId ? { artifactId: pin.asset.artifactId, archiveBytes } : {}),
        source: "download", provenanceVerified: Boolean(pin.asset.sha256 || artifactVerification?.verified),
        integritySource: pin.asset.integritySource || (pin.asset.sha256 ? "publisher-sha256" : archiveMd5 ? "publisher-md5-and-signature" : "recorded-local"), installedAt: new Date().toISOString() });
      throwIfAborted(signal);
      const previous = path.join(staging, "previous");
      if (replacing) fs.renameSync(destination, previous);
      try {
        fs.renameSync(unpacked, destination);
        clearDisplayCache(userDataDir);
        const installed = resolveInstalled({ userDataDir, version: normalized });
        if (!installed) throw new Error("Installed runtime failed its version and executable integrity check.");
        return installed;
      } catch (error) {
        if (replacing) {
          try { fs.rmSync(destination, { recursive: true, force: true }); fs.renameSync(previous, destination); }
          catch { preserveStaging = true; throw new Error(`Runtime replacement failed. The previous installation remains at ${previous}.`); }
        } else fs.rmSync(destination, { recursive: true, force: true });
        throw error;
      }
    } finally {
      if (!preserveStaging) fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  function uninstallRuntime({ userDataDir, version } = {}) {
    const directory = installDir(userDataDir, version);
    if (bundledRuntime?.isResourcePath?.(directory)) throw new Error("Included app resources cannot be removed as runtime installations.");
    if (!fs.existsSync(directory) && resolveIncluded({ version, verification: "status" }))
      throw new Error("This runtime is included in the app and cannot be removed separately.");
    displayCache.delete(directory);
    bundledRuntime?.clearCache?.(directory);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true; // A local registration never owns or removes the external executable.
  }
  // Large upstream archives may omit an exact old game version from their
  // bounded list. A module can explicitly resolve that release on Play without
  // replacing the shared catalog or silently selecting a newer engine.
  function rememberResolvedVersion({ userDataDir, entry } = {}) {
    loadCatalog(userDataDir);
    if (!validEntry(entry)) throw new Error("Resolved runtime release has an invalid version or artifact identity.");
    const version = canonicalVersion(entry.version);
    if (resolvedVersions.size >= maxEntries && !resolvedVersions.has(version)) throw new Error("Resolved runtime release cache exceeds its bound.");
    if (!baseEntries.has(version)) entries.set(version, Object.freeze({ ...entry, version, resolvedForGame: true }));
    resolvedVersions.add(version);
    if (!versions.includes(version)) versions.push(version);
    if (userDataDir) {
      writeRuntimeCatalog({ userDataDir, managerId: id, maxEntries: catalogLimit, entries: remoteEntries,
        retainedEntries: [...entries.values()].filter(item => !remoteEntries.some(remote => remote.version === item.version) && !baseEntries.has(item.version)),
        source: discoveryState.source, fetchedAt: discoveryState.fetchedAt || Date.now(), sourceStates });
      loadedCaches.set(userDataDir, metadataIdentity(catalogPath(userDataDir, id)));
    }
    return entries.get(version);
  }
  function getState({ settings, userDataDir } = {}) {
    loadCatalog(userDataDir);
    const cfg = normalizeSettings(settings);
    const installed = userDataDir || bundledExecution === "direct" ? listRuntimeRows(userDataDir) : [];
    const verifiedMinimums = new Map(installed.map(item => [item.version, item.catalogEntry?.minimumMacOS || item.minimumMacOS]));
    const verifiedHostReason = pin => hostReason(verifiedMinimums.get(pin.version) ? { ...pin, minimumMacOS: verifiedMinimums.get(pin.version) } : pin);
    const bundleErrors = new Map();
    const bundleAvailability = new Map([...entries.values()].map(pin => {
      try { return [pin.version, bundledRuntime?.resolve({ managerId: id, version: pin.version, upstreamRevision: pin.upstreamRevision, arch: process.arch }) || null]; }
      catch (error) { bundleErrors.set(pin.version, error.message || String(error)); return [pin.version, null]; }
    }));
    // Packaged apps ship built payloads rather than a Git checkout. Do not offer
    // a source Build action when its default input cannot exist in that app.
    const sourceAvailable = Boolean(buildRuntime) && (!buildSourcePath || fs.existsSync(path.join(buildSourcePath, ".git")));
    const includedVersions = installed.filter(item => item.bundledExecution === "direct").map(item => item.version);
    // Download rows come from explicit discovery or its persisted snapshot.
    // Installed registrations and automatic Play pins remain separate.
    const displayVersions = remoteEntries.map(pin => pin.version);
    const visibleVersions = displayVersions.filter(version => !entries.get(version).deprecated || installed.some(row => row.version === version));
    const installable = visibleVersions.filter(version => versions.includes(version)).map(version => entries.get(version)).filter(pin => !pin.deprecated && !includedVersions.includes(pin.version) && !bundleErrors.has(pin.version) &&
      !verifiedHostReason(pin) && !assetReason(pin) &&
      (!pin.hostArchitectures || pin.hostArchitectures.includes(process.arch)) &&
      (pin.asset || bundleAvailability.get(pin.version) || (sourceAvailable && pin.localBuild !== false)));
    const sourceOnly = installable.length > 0 && installable.every(pin => !pin.asset && !bundleAvailability.get(pin.version));
    const sources = sourceUrl || [...entries.values()].map(pin => pin.sourceUrl || pin.asset?.url).find(Boolean) || null;
    const versionLabels = Object.fromEntries(visibleVersions.map(version => {
      const pin = entries.get(version);
      return [version, /^(?:MCLv[1-9]\d*-\d{4}|.+-MCLv[1-9]\d*)$/.test(version) ? version : pin.versionLabel || (pin.publishedRelease && pin.publishedRelease.upstreamRevision !== pin.upstreamRevision
        ? `${version} · Mac build ${pin.upstreamRevision.slice(0, 8)}` : version)];
    }));
    const state = { supportsDefault, defaultVersion: cfg.defaultVersion || managerDefault(userDataDir), defaultSource: cfg.defaultVersion ? "saved" : "manager", installed, installing: null, variants: [], versionLabels,
      catalog: { ...discoveryState, sourceStates: structuredClone(sourceStates), versions: visibleVersions, source: sources, sourceUrl: sourceUrl || null,

        installable: installable.length > 0,
        ...(importLocal ? { importable: true, importVersionRequired: true, importLabel: "Import local build…",
          importInputKinds: ["file", "directory"],
          importDescription: "Select the matching version, then choose its macOS executable or app. The original files stay in place; removing the registration leaves them unchanged. Imported builds must match the selected version and its native dependencies." } : {}),
        installableVersions: installable.map(pin => pin.version),
        buildableVersions: sourceAvailable ? visibleVersions.filter(version => versions.includes(version) && !entries.get(version).asset && entries.get(version).localBuild !== false && !entries.get(version).deprecated && !hostReason(entries.get(version))) : [],
        versionRequirements: Object.fromEntries([...entries.values()].map(pin => {
          const bundle = bundleAvailability.get(pin.version);
          const registration = installed.find(item => item.version === pin.version);
          const minimumMacOS = registration?.catalogEntry?.minimumMacOS || registration?.minimumMacOS || bundle?.minimumMacOS || pin.minimumMacOS || null;
          return [pin.version, { minimumMacOS, installReason: hostReason({ ...pin, minimumMacOS: minimumMacOS || undefined }) || assetReason(pin) || pin.installReason || null,
            included: includedVersions.includes(pin.version), available: installed.some(item => item.version === pin.version && item.ready),
            requiresDownload: !bundle && Boolean(pin.asset || (projectPackages || pin.projectPackage) && !pin.deprecated),
            requiresBuild: !bundle && !pin.asset && sourceAvailable && pin.localBuild !== false && !pin.deprecated,
            installLabel: includedVersions.includes(pin.version) ? "Included" : !pin.asset && !bundle && sourceAvailable && pin.localBuild !== false ? "Build" : "Install" }];
        })),
        installLabel: sourceOnly ? "Build" : "Install",
        installHelpUrl: buildHelpUrl || null,
        includedVersions,
        installReason: bundleErrors.size ? [...bundleErrors].map(([version, error]) => `${version}: ${error}`).join(" · ")
          : sourceOnly ? buildRequirements || "Source builds require Apple Command Line Tools and the runtime's build dependencies."
          : buildRuntime && !sourceAvailable && !installable.length ? "No runtime is included for this Mac. A compatible local runtime or source checkout can be imported in Runtimes."
          : installable.length || includedVersions.length ? null : "A compatible local runtime can be imported in Runtimes.",
        supportsLatestOnly: false, latestAvailableVersion: null, latestInstalledVersion: null, updateAvailable: false } };
    state.catalog.versionLabels = versionLabels;
    if (projectPackages || buildsRepository) state.catalog = require("./runtime-sources").projectSources(state.catalog, [...entries.values()],
      { projectId: id, repository: projectBuilds?.repository || buildsRepository, upstreamUrl: upstreamUrl || (projectBuilds ? sourceUrl : undefined), upstreamLabel,
        upstreamDownloads: projectBuilds?.upstreamMacDownloads === true });
    return { ...state, sections: [{ id: "default", label: `${label} versions`, ...state }] };
  }
  manager = {
    id, label, bundledExecution, distributionRequired, normalizeSettings, resolveSelection, getState,
    distributionVersions: distributionRequired ? [...baseEntries.keys()] : [],
    delivery: Object.freeze({ included: bundledRuntime ? bundledExecution : "none",
      catalog: discoverCatalog ? "remote" : "pinned", sourceBuild: typeof buildRuntime === "function" }),
    refreshCatalog,
    applySettingsUpdate: (action, payload, settings) => action === "setDefault"
      ? { ...normalizeSettings(settings), defaultVersion: payload?.version ? normalizeVersion(payload.version) : null } : settings,
    installRuntime: async ({ downloads, onProgress, signal, ...options } = {}) => {
      loadCatalog(options.userDataDir);
      const requested = [options.version, normalizeSettings(options.settings?.runtimes?.[id] || options.settings).defaultVersion]
        .find(value => typeof value === "string" && value.trim() && value.trim() !== "auto") || null;
      let selection = resolveSelection({}, options.settings?.runtimes ? options.settings : { runtimes: { [id]: options.settings } }, options.userDataDir, { version: requested });
      let version = selection.version;
      let pin = entries.get(version);
      if (!selection.ready && (selection.discoveryRequired || projectPackages && pin && !pin.projectPackage)) {
        // This is an explicit install, including consented Play preparation.
        // Resolve its binary before considering an upstream source recipe.
        await refreshCatalog({ userDataDir: options.userDataDir, logger: options.logger, signal, force: true });
        selection = resolveSelection({}, {}, options.userDataDir, { version: requested });
        version = selection.version;
        pin = entries.get(version);
      }
      if (!pin || !version) throw new Error(selection.reason || `No ${label} versions are available to download.`);
      const isBuild = !pin.asset && pin.localBuild !== false && Boolean(buildRuntime) && !bundledRuntime?.resolve({ managerId: id, version, upstreamRevision: pin.upstreamRevision, arch: process.arch });
      return runDownloadTask(downloads,
        buildRuntimeDownloadMeta({ label: isBuild ? `Build ${label}` : label, managerId: id, sectionId: "default", version,
          kind: isBuild ? "runtime-build" : "runtime" }),
        task => installVersion({ ...options, version,
          signal: task.signal && signal ? AbortSignal.any([task.signal, signal]) : task.signal || signal,
          onProgress: task.onProgress }), { onProgress });
    },
    uninstallRuntime,
    ...(importLocal ? { importRuntime: ({ userDataDir, version, runtimePath } = {}) => {
      if (!version || version === "auto") throw new Error("Select the version matching the local build before importing it.");
      return registerLocal({ userDataDir, version, runtimePath });
    } } : {}),
    updateSettingsAfterInstall: (settings, installed) => !supportsDefault ? undefined : normalizeSettings(settings).defaultVersion
      ? settings : { ...settings, defaultVersion: installed.version },
    updateSettingsAfterUninstall: (settings, _payload, { userDataDir } = {}) => {
      if (!supportsDefault) return undefined;
      const cfg = normalizeSettings(settings);
      const installed = listInstalled(userDataDir);
      return installed.some(item => item.version === cfg.defaultVersion)
        ? settings : { ...settings, defaultVersion: installed[0]?.version || null };
    },
    core: { normalizeVersion, registerLocal, resolveInstalled, resolveRegistered: resolveRegistration, listInstalled, installVersion, clearDisplayCache, rememberResolvedVersion,
      listCatalog: ({ userDataDir } = {}) => { loadCatalog(userDataDir); return versions.map(version => entries.get(version)); },
      listDiscoveredCatalog: ({ userDataDir } = {}) => { loadCatalog(userDataDir); return remoteEntries.slice(); },
      getInstallDir: ({ userDataDir, version }) => { loadCatalog(userDataDir); return installDir(userDataDir, version); },
      get catalog() { return [...entries.values()]; } }
  };
  Custom.configure(manager, { defaultsPath: () => ["defaultVersion"], providers: [{ core: manager.core,
    lists: { listInstalled: "default" }, resolves: { resolveInstalled: "default", resolveRegistered: "default" },
    versions: ["normalizeVersion"], directories: ["getInstallDir"] }], inspect(runtimePath, { verification } = {}) {
    const packaged = inspectRuntime === Native.resolveLocalRuntime && Custom.inspectManifest(runtimePath, { managerId: id, allowLibrary: nativeLibrary, verification });
    if (packaged) {
      const pin = [...entries.values()].find(row => row.version === packaged.runtimeVersion && row.upstreamRevision === packaged.upstreamRevision);
      return { ...packaged, ...(pin ? { catalogEntry: pin } : {}) };
    }
    let executablePath = runtimePath, root = path.dirname(runtimePath);
    if (fs.statSync(runtimePath).isDirectory()) {
      root = runtimePath;
      executablePath = runtimePath.toLowerCase().endsWith(".app")
        ? require("./app-bundle").resolveAppBundleExecutablePath(runtimePath)
        : resolveExecutable(runtimePath, {});
    }
    if (!executablePath) throw new Error("The selected runtime has no executable.");
    const inspected = inspectRuntime === Native.resolveLocalRuntime
      ? Custom.inspectExecutable(executablePath, { allowLibrary: nativeLibrary })
      : inspectRuntime({ runtimePath: executablePath, runtimeVersion: "custom", upstreamRevision: "custom" });
    return { ...inspected, appPath: runtimePath, installDir: root, root, payloadRoot: root,
      requiresRosetta: inspected.needsRosetta, binarySha256: inspected.sha256 };
  } });
  Custom.instrumentManagers([manager]);
  return manager;
}

module.exports = { createPinnedNativeManager, hashFile, compareRuntimeVersions };
