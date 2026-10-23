const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Native = require("./local-native");
const { downloadToFile, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { buildRuntimeDownloadMeta } = require("./runtime-downloads");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("./runtime-catalog");
const { systemVersionSync, versionAtLeast } = require("./bundled-native");

// Source hashes identify builds but do not order them. Equal release stems
// retain the publisher/catalog order (including the primary included build).
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
function createPinnedNativeManager({ id, label, catalog, recommendedVersion, discoverCatalog, projectBuilds, resolveExecutable, verifyArtifact, validateRecordedArtifact, prepareInstall, buildRuntime, buildSourcePath, sourceUrl, buildHelpUrl, buildRequirements, bundledRuntime, bundledExecution = "copy", distributionRequired = false, importLocal = false, nativeLibrary = false, supportsDefault = nativeLibrary, maxEntries = 500, dependencies = {} }) {
  if (typeof distributionRequired !== "boolean") throw new Error("Runtime distribution requirements must be explicit booleans.");
  if (typeof importLocal !== "boolean") throw new Error("Local runtime imports must be explicitly enabled.");
  if (typeof nativeLibrary !== "boolean") throw new Error("Native library runtimes must be explicitly enabled.");
  if (typeof supportsDefault !== "boolean") throw new Error("Runtime default selection must be an explicit boolean.");
  if (!/^[a-z0-9-]+$/.test(id || "") || !Array.isArray(catalog) || !catalog.length && typeof discoverCatalog !== "function") {
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
  const projectPackages = projectBuilds && require("./project-native-package").createProjectNativePackage(projectBuilds,
    { id, catalog, dependencies: dependencies.projectBuilds || {} });
  if (projectPackages) {
    const upstreamDiscovery = discoverCatalog;
    discoverCatalog = async options => {
      const [hosted, upstream] = await Promise.allSettled([
        projectPackages.discover(options), upstreamDiscovery ? upstreamDiscovery(options) : []
      ]);
      // A failed hosted provider retains the previous complete catalog.
      if (hosted.status === "rejected") throw hosted.reason;
      return [...hosted.value, ...(upstream.status === "fulfilled" ? upstream.value : [])];
    };
  }
  let manager;
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
  if (recommendedVersion && !entries.has(recommendedVersion)) throw new Error("Recommended runtime must be in the offline catalog.");
  const defaultVersion = () => recommendedVersion || versions[0];
  function hostReason(pin) {
    if (pin?.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) return `${label} ${pin.version} does not support this Mac's ${process.arch} CPU.`;
    if (!pin?.minimumMacOS) return null;
    const actual = process.platform === "darwin" || dependencies.systemVersionSync
      ? (dependencies.systemVersionSync || systemVersionSync)() : null;
    return actual && versionAtLeast(actual, pin.minimumMacOS) ? null : `${label} ${pin.version} requires macOS ${pin.minimumMacOS}.`;
  }
  const assetReason = pin => pin?.asset?.expiresAt && Date.parse(pin.asset.expiresAt) <= (dependencies.now || Date.now)()
    ? "This build's download expired. Refresh versions to find a current build." : null;
  let discoveryState = { status: discoverCatalog ? "idle" : "success", fetchedAt: null, error: null, source: sourceUrl || null, mode: null };
  let discoveryPromise = null;
  // UI broadcasts only revisit registration/executable metadata. Actual
  // selection, install and explicit Reload retain full integrity checks.
  const displayCache = new Map();
  const includedFailures = new Map();
  const DISPLAY_CACHE_LIMIT = 128;
  const loadedCaches = new Set();
  const loadedInstalledPins = new Set();
  const root = userDataDir => {
    if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) throw new Error("An absolute launcher data directory is required.");
    return path.join(userDataDir, "runtimes", id);
  };
  function mergeEntries(incoming) {
    if (!Array.isArray(incoming) || incoming.length > maxEntries || !incoming.every(validEntry)) throw new Error("Discovered runtime catalog contains invalid version or artifact identities.");
    const deduplicated = new Map();
    for (const original of incoming) {
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
    versions = [...new Set([...deduplicated.keys(), ...baseVersions, ...resolvedVersions])];
  }
  function loadCatalog(userDataDir) {
    if (userDataDir && !loadedInstalledPins.has(userDataDir)) {
      const directory = root(userDataDir);
      if (fs.existsSync(directory)) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).slice(0, 500)) {
          if (!item.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name)) continue;
          try {
            const file = path.join(directory, item.name, "runtime.json");
            if (fs.statSync(file).size > 1024 * 1024) continue;
            const record = JSON.parse(fs.readFileSync(file, "utf8")), pin = record.catalogEntry;
            if (validEntry(pin) && pin.version === item.name && record.version === item.name &&
              record.upstreamRevision === pin.upstreamRevision && !entries.has(item.name)) entries.set(item.name, Object.freeze(pin));
          } catch {}
        }
      }
      loadedInstalledPins.add(userDataDir);
    }
    if (!discoverCatalog || !userDataDir || loadedCaches.has(userDataDir)) return;
    const cached = readRuntimeCatalog({ userDataDir, managerId: id, validateEntry: validEntry, maxEntries });
    if (cached && (!sourceUrl || cached.source === sourceUrl)) {
      for (const entry of cached.retainedEntries || []) {
        if (validEntry(entry) && !entries.has(entry.version)) entries.set(entry.version, Object.freeze(entry));
        if (entry.resolvedForGame === true && validEntry(entry)) resolvedVersions.add(entry.version);
      }
      mergeEntries(cached.entries);
      discoveryState = { status: "success", fetchedAt: cached.fetchedAt, source: cached.source || sourceUrl || null, error: null, mode: null };
    }
    loadedCaches.add(userDataDir);
  }
  async function refreshCatalog({ userDataDir, logger, signal, force = false, latestOnly = false } = {}) {
    const mode = latestOnly === true ? "latest" : "all";
    if (userDataDir) {
      clearDisplayCache(userDataDir);
      // Reload is an explicit action: surface changed auxiliary payloads once,
      // then retain that outcome for subsequent inexpensive broadcasts.
      listInstalled(userDataDir);
    }
    bundledRuntime?.clearCache?.();
    if (!discoverCatalog) return getState({ userDataDir }).catalog;
    loadCatalog(userDataDir);
    if (!force && discoveryState.mode === mode && discoveryState.status === "success" && discoveryState.fetchedAt && Date.now() - discoveryState.fetchedAt < 6 * 3600000) return getState({ userDataDir }).catalog;
    if (discoveryPromise) {
      if (discoveryState.mode === mode) return discoveryPromise;
      try { await discoveryPromise; } catch {}
      throwIfAborted(signal);
      return refreshCatalog({ userDataDir, logger, signal, force, latestOnly });
    }
    const previous = discoveryState;
    discoveryState = { ...discoveryState, status: "loading", error: null, mode };
    discoveryPromise = (async () => {
      try {
        const discovered = await discoverCatalog({ logger, signal, latestOnly });
        throwIfAborted(signal);
        mergeEntries(discovered);
        discoveryState = { status: "success", fetchedAt: Date.now(), source: sourceUrl || null, error: null, mode };
        if (userDataDir) writeRuntimeCatalog({ userDataDir, managerId: id, maxEntries,
          entries: remoteEntries, retainedEntries: [...entries.values()].filter(entry => !versions.includes(entry.version) ||
            (entry.resolvedForGame === true && !remoteEntries.some(remote => remote.version === entry.version))),
          source: discoveryState.source, fetchedAt: discoveryState.fetchedAt });
        return getState({ userDataDir }).catalog;
      } catch (error) {
        discoveryState = { ...previous, status: "error", error: error.message || String(error) };
        throw error;
      } finally { discoveryPromise = null; }
    })();
    return discoveryPromise;
  }
  function normalizeVersion(version) {
    const value = canonicalVersion(version);
    if (!entries.has(value)) throw new Error(`Unsupported ${label} version '${value}'. Available: ${versions.join(", ")}.`);
    return value;
  }
  const installDir = (userDataDir, version) => path.join(root(userDataDir), normalizeVersion(version));
  function normalizeSettings(settings) {
    const version = typeof settings?.defaultVersion === "string" ? settings.defaultVersion.trim() : "";
    return { defaultVersion: supportsDefault && version && version !== "auto" ? version : null };
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
        !bundledRuntime?.verifyInstalled({ installDir: directory, record, pin, verification }))) {
        rememberDisplay(directory, cacheKey, null);
        return null;
      }
      let project;
      if (projectPackages && pin.projectPackage) {
        if (record.source !== "download") return null;
        project = projectPackages.inspectInstalled(directory, pin, { verification });
        if (runtimePath !== project.executablePath) return null;
      }
      if (verification === "status" && cached?.key === cacheKey) return cached.install;
      const native = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: normalized,
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
      // Keep damaged registrations and failed builds removable through the same
      // version row. Launch/default resolution continues to require a valid record.
      return [{ version, installDir: directory, ready: false,
        status: hostReason(entries.get(version)) ? "unsupported-host" : record ? "damaged" : "incomplete", source: record?.source || "incomplete",
        runtimePath: typeof record?.runtimePath === "string" ? record.runtimePath : null,
        installedAt: typeof record?.installedAt === "string" ? record.installedAt : null,
        upstreamRevision: entries.get(version).upstreamRevision,
        error: hostReason(entries.get(version)) || (record ? "The runtime executable or its version record changed. Remove this registration and install/register the selected version again."
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
    if (hostReason(pin)) throw new Error(hostReason(pin));
    if (pin.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) {
      throw new Error(`${label} ${normalized} supports ${pin.hostArchitectures.join(", ")}; this Mac uses ${process.arch}.`);
    }
    const native = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: normalized, upstreamRevision: pin.upstreamRevision, allowLibrary: nativeLibrary });
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
  function resolveSelection(entry, settings, userDataDir, { verification = "full", version: selectedVersion } = {}) {
    loadCatalog(userDataDir);
    const override = typeof selectedVersion === "string" && selectedVersion.trim() && selectedVersion.trim() !== "auto"
      ? selectedVersion : entry?.runtimeData?.[id]?.version;
    const requested = typeof override === "string" ? override.trim() : "";
    const explicit = requested && requested !== "auto" ? canonicalVersion(requested) : null;
    const configured = normalizeSettings(settings?.runtimes?.[id]).defaultVersion;
    const attempted = new Map();
    if (!explicit && !configured) {
      for (const version of [...entries.keys()].sort(compareRuntimeVersions)) {
        if (entries.get(version)?.deprecated || hostReason(entries.get(version))) continue;
        const install = resolveInstalled({ userDataDir, version, verification });
        attempted.set(version, install);
        if (install) return { version, install, ready: true, reason: null };
      }
    }
    const version = explicit || configured || defaultVersion();
    const install = attempted.has(version) ? attempted.get(version) : resolveInstalled({ userDataDir, version, verification });
    return { version, install, ready: Boolean(install), reason: install ? null : !entries.has(version)
      ? `${label} ${version} is not available. Available versions: ${versions.join(", ")}.`
      : hostReason(entries.get(version)) || includedFailures.get(version)?.error || `${label} ${version} is not installed, or its executable changed.` };
  }
  async function installVersion({ userDataDir, version = defaultVersion(), signal, onProgress, logger, sourceDir } = {}) {
    if (process.platform !== "darwin") throw new Error(`${label} installation requires macOS.`);
    loadCatalog(userDataDir);
    const normalized = normalizeVersion(version);
    const pin = entries.get(normalized);
    if (hostReason(pin)) throw new Error(hostReason(pin));
    if (pin.hostArchitectures && !pin.hostArchitectures.includes(process.arch)) {
      throw new Error(`${label} ${normalized} supports ${pin.hostArchitectures.join(", ")}; this Mac uses ${process.arch}.`);
    }
    const existing = resolveInstalled({ userDataDir, version: normalized });
    if (existing) return existing;
    if (assetReason(pin)) throw new Error(assetReason(pin));
    if (!versions.includes(normalized)) throw new Error("This runtime release is no longer in the current upstream catalog. Existing installed copies can be used or removed.");
    const destination = installDir(userDataDir, normalized);
    if (fs.existsSync(destination)) throw new Error(`Remove the incomplete ${label} ${normalized} installation before reinstalling.`);
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
    try {
      const archivePath = path.join(staging, pin.asset.filename);
      await (dependencies.downloadToFile || downloadToFile)(pin.asset.url, archivePath, { signal, onProgress });
      const archiveBytes = fs.statSync(archivePath).size;
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
      await (dependencies.extractArchive || (projectPackages && pin.projectPackage ? projectPackages.extract : extractPinnedArchive))(archivePath, unpacked, signal);
      const preparation = projectPackages && pin.projectPackage ? projectPackages.prepare : prepareInstall;
      const installationMetadata = preparation
        ? installationEvidence(await preparation({ unpacked, pin, userDataDir, signal, logger, onProgress })) : undefined;
      throwIfAborted(signal);
      const runtimePath = projectPackages && pin.projectPackage ? projectPackages.inspectInstalled(unpacked, pin).executablePath
        : (pin.resolveExecutable || resolveExecutable)(unpacked, pin);
      const native = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: normalized, upstreamRevision: pin.upstreamRevision, allowLibrary: nativeLibrary });
      const executableRelative = path.relative(unpacked, native.executablePath);
      if (!executableRelative || executableRelative.startsWith("..") || path.isAbsolute(executableRelative)) throw new Error("Pinned runtime executable escaped the installation.");
      publishRecord(unpacked, { version: normalized, upstreamRevision: pin.upstreamRevision,
        catalogEntry: pin,
        binarySha256: hashFile(native.executablePath), executableRelative,
        archiveSha256, ...(archiveMd5 ? { archiveMd5 } : {}), ...(artifactVerification ? { artifactVerification } : {}),
        ...(installationMetadata === undefined ? {} : { installationMetadata }),
        assetUrl: pin.asset.url, assetId: pin.asset.assetId || null,
        ...(pin.asset.artifactId ? { artifactId: pin.asset.artifactId, archiveBytes } : {}),
        source: "download", provenanceVerified: Boolean(pin.asset.sha256 || artifactVerification?.verified),
        integritySource: pin.asset.integritySource || (pin.asset.sha256 ? "publisher-sha256" : archiveMd5 ? "publisher-md5-and-signature" : "recorded-local"), installedAt: new Date().toISOString() });
      throwIfAborted(signal);
      fs.renameSync(unpacked, destination);
      const installed = resolveInstalled({ userDataDir, version: normalized });
      if (!installed) throw new Error("Installed runtime failed its version and executable integrity check.");
      return installed;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
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
    if (userDataDir) writeRuntimeCatalog({ userDataDir, managerId: id, maxEntries, entries: remoteEntries,
      retainedEntries: [...entries.values()].filter(item => !remoteEntries.some(remote => remote.version === item.version) && !baseEntries.has(item.version)),
      source: discoveryState.source, fetchedAt: discoveryState.fetchedAt || Date.now() });
    return entries.get(version);
  }
  function getState({ settings, userDataDir } = {}) {
    loadCatalog(userDataDir);
    const cfg = normalizeSettings(settings);
    const installed = userDataDir || bundledExecution === "direct" ? listRuntimeRows(userDataDir) : [];
    const usable = installed.filter(item => item.ready).sort((a, b) => compareRuntimeVersions(a.version, b.version));
    const bundleErrors = new Map();
    const bundleAvailability = new Map([...entries.values()].map(pin => {
      try { return [pin.version, bundledRuntime?.resolve({ managerId: id, version: pin.version, upstreamRevision: pin.upstreamRevision, arch: process.arch }) || null]; }
      catch (error) { bundleErrors.set(pin.version, error.message || String(error)); return [pin.version, null]; }
    }));
    // Packaged apps ship built payloads rather than a Git checkout. Do not offer
    // a source Build action when its default input cannot exist in that app.
    const sourceAvailable = Boolean(buildRuntime) && (!buildSourcePath || fs.existsSync(path.join(buildSourcePath, ".git")));
    const includedVersions = installed.filter(item => item.bundledExecution === "direct").map(item => item.version);
    // Factory pins describe identities, not a fetched upstream history. Actual
    // included/installed payloads and explicitly resolved game versions remain
    // selectable when a publisher removes them from its current release list.
    const displayVersions = discoverCatalog ? [...new Set([
      ...remoteEntries.map(pin => pin.version), ...resolvedVersions,
      ...installed.map(row => row.version),
      ...(importLocal ? baseVersions : []),
      ...baseVersions.filter(version => bundleAvailability.get(version))
    ])] : versions;
    const visibleVersions = displayVersions.filter(version => !entries.get(version).deprecated || installed.some(row => row.version === version));
    const installable = visibleVersions.filter(version => versions.includes(version)).map(version => entries.get(version)).filter(pin => !pin.deprecated && !includedVersions.includes(pin.version) && !bundleErrors.has(pin.version) &&
      !hostReason(pin) && !assetReason(pin) &&
      (!pin.hostArchitectures || pin.hostArchitectures.includes(process.arch)) &&
      (pin.asset || bundleAvailability.get(pin.version) || (sourceAvailable && pin.localBuild !== false)));
    const sourceOnly = installable.length > 0 && installable.every(pin => !pin.asset && !bundleAvailability.get(pin.version));
    const sources = sourceUrl || [...entries.values()].map(pin => pin.sourceUrl || pin.asset?.url).filter(Boolean).join(" · ") || "Local versions";
    const versionLabels = Object.fromEntries(visibleVersions.map(version => {
      const pin = entries.get(version);
      return [version, pin.versionLabel || (pin.publishedRelease && pin.publishedRelease.upstreamRevision !== pin.upstreamRevision
        ? `${version} · Mac build ${pin.upstreamRevision.slice(0, 8)}` : version)];
    }));
    const state = { supportsDefault, defaultVersion: cfg.defaultVersion, installed, installing: null, variants: [], versionLabels,
      catalog: { ...discoveryState, versions: visibleVersions, source: sources, sourceUrl: sourceUrl || null,
        recommendedVersion: visibleVersions.includes(defaultVersion()) ? defaultVersion() : visibleVersions[0] || null,
        installable: installable.length > 0,
        ...(importLocal ? { importable: true, importVersionRequired: true, importLabel: "Import local build…",
          importInputKinds: ["file", "directory"],
          importDescription: "Select the matching version, then choose its macOS executable or app. The original files stay in place; removing the registration leaves them unchanged. Imported builds must match the selected version and its native dependencies." } : {}),
        installableVersions: installable.map(pin => pin.version),
        buildableVersions: sourceAvailable ? visibleVersions.filter(version => versions.includes(version) && !entries.get(version).asset && entries.get(version).localBuild !== false && !entries.get(version).deprecated && !hostReason(entries.get(version))) : [],
        versionRequirements: Object.fromEntries([...entries.values()].map(pin => {
          const bundle = bundleAvailability.get(pin.version);
          return [pin.version, { minimumMacOS: bundle?.minimumMacOS || pin.minimumMacOS || null, installReason: hostReason(pin) || assetReason(pin) || pin.installReason || null,
            included: includedVersions.includes(pin.version), available: installed.some(item => item.version === pin.version && item.ready),
            requiresDownload: !bundle && Boolean(pin.asset || projectPackages && !pin.deprecated),
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
        supportsLatestOnly: false, latestAvailableVersion: visibleVersions[0], latestInstalledVersion: usable[0]?.version || null, updateAvailable: false } };
    return { ...state, sections: [{ id: "default", label: `${label} versions`, ...state }] };
  }
  manager = {
    id, label, bundledExecution, distributionRequired, normalizeSettings, resolveSelection, getState,
    distributionVersions: distributionRequired ? [defaultVersion()] : [],
    delivery: Object.freeze({ included: bundledRuntime ? bundledExecution : "none",
      catalog: discoverCatalog ? "remote" : "pinned", sourceBuild: typeof buildRuntime === "function" }),
    refreshCatalog,
    applySettingsUpdate: (action, payload, settings) => action === "setDefault" && supportsDefault
      ? { ...normalizeSettings(settings), defaultVersion: payload?.version ? normalizeVersion(payload.version) : null } : settings,
    installRuntime: async ({ downloads, onProgress, signal, ...options } = {}) => {
      loadCatalog(options.userDataDir);
      const version = options.version === undefined ? defaultVersion() : normalizeVersion(options.version);
      let pin = entries.get(version);
      if (projectPackages && !pin.projectPackage && !resolveInstalled({ userDataDir: options.userDataDir, version })) {
        // This is an explicit install, including consented Play preparation.
        // Resolve its binary before considering an upstream source recipe.
        await refreshCatalog({ userDataDir: options.userDataDir, logger: options.logger, signal, force: true });
        pin = entries.get(version);
      }
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
      return listInstalled(userDataDir).some(item => item.version === cfg.defaultVersion)
        ? settings : { ...settings, defaultVersion: listInstalled(userDataDir)[0]?.version || null };
    },
    core: { normalizeVersion, registerLocal, resolveInstalled, resolveRegistered: resolveRegistration, listInstalled, installVersion, clearDisplayCache, rememberResolvedVersion,
      listCatalog: ({ userDataDir } = {}) => { loadCatalog(userDataDir); return versions.map(version => entries.get(version)); },
      getInstallDir: ({ userDataDir, version }) => { loadCatalog(userDataDir); return installDir(userDataDir, version); },
      get catalog() { return [...entries.values()]; } }
  };
  return manager;
}

module.exports = { createPinnedNativeManager, hashFile, compareRuntimeVersions };
