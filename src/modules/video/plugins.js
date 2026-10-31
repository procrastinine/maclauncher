const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const Upstream = require("../shared/runtime/upstream");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../shared/runtime/runtime-downloads");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../shared/runtime/runtime-catalog");
const { managerDefaultVersion } = require("../shared/runtime/version-choices");
const { readMachOLoadCommands } = require("../shared/runtime/macho-load-commands");
const { removeManagedRuntimeQuarantine } = require("../shared/runtime/managed-quarantine");
const Rosetta = require("../shared/runtime/rosetta");
const Sources = require("./plugin-sources");
const execute = promisify(execFile);
const MANAGER_ID = "mpv-plugins";
// Versions come from each plugin's published catalog: the cache from the last
// Refresh, or discovery during Install. These records hold only integration.
const packages = Object.freeze({
  uosc: Object.freeze({ id: "uosc", label: "uosc controls", settingKey: "uosc", sourceUrl: "https://github.com/tomasklaen/uosc/releases",
    updateSource: Sources.UOSC_SOURCE, scriptRelative: "scripts/uosc",
    description: "Playback controls, track menus and a seekable timeline." }),
  thumbfast: Object.freeze({ id: "thumbfast", label: "Timeline previews", settingKey: "timelinePreviews", sourceUrl: "https://github.com/po5/thumbfast",
    updateSource: Sources.THUMBFAST_SOURCE, scriptRelative: "thumbfast.lua",
    description: "Thumbnail previews when hovering over the timeline. Works with uosc and other thumbfast-compatible controls." })
});
const REVISION = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const safeRelative = value => typeof value === "string" && !/[\\\0]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
function required(settings = {}) {
  settings ||= {};
  return [settings.uosc !== false && packages.uosc, settings.timelinePreviews !== false && packages.thumbfast].filter(Boolean);
}
function provides(plugin, id) {
  if (plugin?.scripts?.some(script => path.basename(script).replace(/\.(lua|js)$/i, "") === id)) return true;
  try {
    const url = new URL(plugin?.sourceUrl), repository = id === "uosc" ? "tomasklaen/uosc" : id === "thumbfast" ? "po5/thumbfast" : null;
    return Boolean(repository && ["github.com", "raw.githubusercontent.com"].includes(url.hostname) && url.pathname.split("/").filter(Boolean).slice(0, 2).join("/") === repository);
  } catch { return false; }
}
function playbackStatus(userDataDir, id) {
  const supplied = module.exports.manager.listCustom(userDataDir, { full: true }).find(plugin => plugin.ready && plugin.enabled !== false && provides(plugin, id));
  if (!supplied) return status(userDataDir, id);
  if (id !== "uosc") return supplied;
  const script = supplied.scriptPaths.find(script => fs.statSync(script, { throwIfNoEntry: false })?.isDirectory()), helperPath = script && path.join(script, "bin", "ziggy-darwin");
  return { ...supplied, ...(helperPath && fs.statSync(helperPath, { throwIfNoEntry: false })?.isFile() ? { helperPath } : {}) };
}
function hash(file) {
  const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, "r");
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest("hex");
}
function packageFor(id) {
  if (typeof id !== "string" || !Object.hasOwn(packages, id)) throw new Error("The selected mpv plugin is unavailable.");
  return packages[id];
}
function storageRoot(userDataDir) {
  if (!path.isAbsolute(userDataDir || "") || userDataDir.includes("\0")) throw new Error("An absolute launcher data folder is required.");
  const root = path.join(userDataDir, "runtimes", MANAGER_ID);
  for (const current of [userDataDir, path.join(userDataDir, "runtimes"), root]) {
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("mpv plugin folders must be local directories."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return root;
}
function installDirectory(userDataDir, id, version) {
  if (!Sources.SAFE_VERSION.test(version || "")) throw new Error("The selected mpv plugin version is unavailable.");
  const directory = path.join(storageRoot(userDataDir), id, version);
  for (const current of [path.dirname(directory), directory]) {
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("mpv plugin folders must be local directories."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return directory;
}
// Version folders on disk, whether or not their contents still verify.
function installedVersions(userDataDir, id) {
  try {
    const parent = path.join(storageRoot(userDataDir), id), stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return fs.readdirSync(parent, { withFileTypes: true }).filter(item => item.isDirectory() && Sources.SAFE_VERSION.test(item.name)).map(item => item.name);
  } catch { return []; }
}
function inventory(directory) {
  const files = [], pending = [directory]; let bytes = 0;
  while (pending.length) {
    for (const item of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
      const file = path.join(item.parentPath || item.path || directory, item.name);
      if (item.isDirectory()) pending.push(file);
      else if (item.isFile()) {
        const stat = fs.statSync(file); bytes += stat.size;
        files.push({ path: path.relative(directory, file).split(path.sep).join("/"), bytes: stat.size, sha256: hash(file), executable: Boolean(stat.mode & 0o111) });
      } else throw new Error("The mpv plugin contains an unsupported file link.");
      if (files.length + pending.length > 512 || bytes > 64 * 1024 * 1024) throw new Error("The mpv plugin exceeds its package limits.");
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function validAsset(asset) {
  if (!asset || !safeRelative(asset.filename) || asset.bytes != null && !(Number.isSafeInteger(asset.bytes) && asset.bytes > 0) ||
    asset.sha256 != null && !SHA256.test(asset.sha256)) return false;
  try { return new URL(asset.url).protocol === "https:"; } catch { return false; }
}
function validEntry(entry) {
  return Sources.SAFE_VERSION.test(entry?.version || "") && REVISION.test(entry.upstreamRevision || "") &&
    Array.isArray(entry.assets) && entry.assets.length > 0 && entry.assets.length <= 16 && entry.assets.every(validAsset);
}
function cachedCatalog(userDataDir, id) {
  return userDataDir ? readRuntimeCatalog({ userDataDir, managerId: MANAGER_ID, sourceId: id, validateEntry: validEntry }) : null;
}
const verificationCache = new Map();
function stamp(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); }
// An installed version is defined by its receipt: the files it lists must
// still match their recorded sizes, modes and SHA-256 hashes.
function receipt(userDataDir, id, version, verification = "status") {
  const pkg = packageFor(id);
  try {
    const installDir = installDirectory(userDataDir, id, version), manifest = path.join(installDir, "plugin.json");
    const metadata = fs.lstatSync(manifest, { bigint: true });
    if (!metadata.isFile() || metadata.size > 128n * 1024n) return null;
    const record = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (record.schema !== 1 || record.id !== id || record.version !== version || !REVISION.test(record.upstreamRevision || "") ||
      !Array.isArray(record.assets) || !Array.isArray(record.files) || !record.files.length || record.files.length > 512) return null;
    const observed = [stamp(metadata)];
    for (const file of record.files) {
      if (typeof file.path !== "string" || file.path === "plugin.json" || !safeRelative(file.path) || !SHA256.test(file.sha256)) return null;
      const target = path.join(installDir, file.path), stat = fs.lstatSync(target, { bigint: true });
      if (!stat.isFile() || Number(stat.size) !== file.bytes || Boolean(Number(stat.mode) & 0o111) !== file.executable || !fs.realpathSync(target).startsWith(fs.realpathSync(installDir) + path.sep)) return null;
      observed.push(stamp(stat));
    }
    const signature = observed.join("|");
    if (verification === "full" || verificationCache.get(installDir) !== signature) {
      if (record.files.some(file => hash(path.join(installDir, file.path)) !== file.sha256)) return null;
      if (verificationCache.size > 64) verificationCache.clear();
      verificationCache.set(installDir, signature);
    }
    const scriptPath = path.join(installDir, pkg.scriptRelative);
    if (!fs.existsSync(scriptPath)) return null;
    return { id, version, versionLabel: typeof record.versionLabel === "string" && record.versionLabel ? record.versionLabel : null,
      installDir, scriptPath, source: "managed", ready: true, removable: true, installedAt: record.installedAt,
      upstreamRevision: record.upstreamRevision, sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : pkg.sourceUrl,
      ...(id === "uosc" ? { fontsDirectory: path.join(installDir, "fonts"), configFile: path.join(installDir, "script-opts/uosc.conf"),
        helperPath: path.join(installDir, "scripts/uosc/bin/ziggy-darwin") } : {}) };
  } catch { return null; }
}
// Ready installed versions, most recently installed first.
function installs(userDataDir, id, verification) {
  return installedVersions(userDataDir, id).map(version => receipt(userDataDir, id, version, verification)).filter(Boolean)
    .sort((a, b) => String(b.installedAt || "").localeCompare(String(a.installedAt || "")));
}
// One installed version, or without a version the one playback uses.
function status(userDataDir, id, { version, verification = "status" } = {}) {
  packageFor(id);
  if (version != null) return receipt(userDataDir, id, version, verification);
  for (const install of installs(userDataDir, id)) {
    const verified = verification === "full" ? receipt(userDataDir, id, install.version, "full") : install;
    if (verified) return verified;
  }
  return null;
}
function removeVersion(userDataDir, id, version) {
  const directory = installDirectory(userDataDir, id, version);
  fs.rmSync(directory, { recursive: true, force: true }); verificationCache.delete(directory);
}
function createManager(dependencies = {}) {
  const run = dependencies.execute || execute;
  const custom = require("./custom-plugins").create({ storageRoot, inventory, hash, ...dependencies,
    installRuntime: options => manager.installRuntime(options) });
  const active = new Map(), discovery = new Map();
  // A successful discovery replaces the plugin's catalog; a failed one keeps it.
  async function discover({ userDataDir, id, signal, logger }) {
    const pkg = packageFor(id);
    discovery.set(id, { status: "loading", error: null });
    try {
      const entries = (await Sources.discoverVersions(id, { signal, logger })).filter(validEntry);
      if (!entries.length) throw new Error(`No ${pkg.label} versions are available to download.`);
      const record = writeRuntimeCatalog({ userDataDir, managerId: MANAGER_ID, sourceId: id, source: pkg.sourceUrl, entries });
      discovery.set(id, { status: "success", error: null, fetchedAt: record?.fetchedAt || Date.now() });
      return record?.entries || entries;
    } catch (error) {
      discovery.set(id, { status: "error", error: error.message }); throw error;
    }
  }
  async function install({ sectionId, version, userDataDir, signal, downloads, onProgress, ...context } = {}) {
    const pkg = packageFor(sectionId);
    const requested = typeof version === "string" && version.trim() ? version.trim() : null;
    let entries = cachedCatalog(userDataDir, pkg.id)?.entries || [];
    // Without a requested version, Install uses the default: the newest listed
    // version, or the newest installed one while nothing is listed.
    const target = requested || managerDefaultVersion({ listed: entries.map(entry => entry.version), installed: installs(userDataDir, pkg.id).map(install => install.version) });
    const existing = target && status(userDataDir, pkg.id, { version: target, verification: "full" });
    if (existing) return existing;
    let entry = entries.find(item => item.version === target);
    if (!entry) {
      // Selecting Install is the consent for discovery; preparation continues
      // with the discovered version.
      entries = await discover({ userDataDir, id: pkg.id, signal, logger: context.logger });
      entry = requested ? entries.find(item => item.version === requested) : entries[0];
      if (!entry) throw new Error(`The selected ${pkg.label} version is no longer published.`);
      const current = status(userDataDir, pkg.id, { version: entry.version, verification: "full" });
      if (current) return current;
    }
    const directory = installDirectory(userDataDir, pkg.id, entry.version), key = directory;
    if (active.has(key)) return active.get(key);
    const operation = runDownloadTask(downloads, buildRuntimeDownloadMeta({ managerId: MANAGER_ID, sectionId: pkg.id, version: entry.version, label: pkg.label, kind: "mpv-plugin" }), async task => {
      const combined = signal && task.signal ? AbortSignal.any([signal, task.signal]) : signal || task.signal;
      throwIfAborted(combined);
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      const stage = fs.mkdtempSync(path.join(path.dirname(directory), ".install-")), unpacked = path.join(stage, "payload");
      fs.mkdirSync(unpacked);
      try {
        const assets = [];
        for (const asset of entry.assets) {
          throwIfAborted(combined);
          const target = path.join(asset.filename.endsWith(".zip") ? stage : unpacked, asset.filename);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // The publisher's size and digest verify a download when they are
          // published; the receipt records the hash of every download.
          const { bytes, sha256 } = await Upstream.download(Upstream.listedFile(asset), target,
            { signal: combined, onProgress: task.onProgress, headers: { "User-Agent": "MacLauncher" } });
          assets.push({ filename: asset.filename, url: asset.url, bytes, sha256 });
          if (asset.filename.endsWith(".zip")) {
            await run("/usr/bin/ditto", ["-x", "-k", target, unpacked], { ...(combined ? { signal: combined } : {}), timeout: 60000, maxBuffer: 128 * 1024 });
          }
        }
        // The repository's license notice at the installed revision.
        if (entry.licenseRepository) {
          const notice = path.join(unpacked, "LICENSE"), license = await Upstream.githubLicense({ repository: entry.licenseRepository,
            revision: entry.upstreamRevision, destination: notice, signal: combined, label: pkg.label });
          assets.push({ filename: "LICENSE", url: license.licenseUrl, bytes: fs.statSync(notice).size, sha256: license.licenseSha256 });
        }
        let nativeHelper = null;
        if (pkg.id === "uosc") {
          const helpers = path.join(unpacked, "scripts/uosc/bin"), binary = path.join(helpers, "ziggy-darwin");
          fs.mkdirSync(helpers, {recursive: true});
          for (const file of ["ziggy-linux", "ziggy-windows.exe"]) fs.rmSync(path.join(helpers, file), { force: true });
          nativeHelper = await require("./runtime/uosc-helper-manager").stageHelper({root: unpacked, binary,
            ...context, userDataDir, downloads, signal: combined, onProgress: task.onProgress});
          if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw new Error("The uosc release has no macOS helper.");
          // Any CPU this Mac runs: its own, or Intel through Rosetta.
          const info = readMachOLoadCommands(binary);
          if (!info.architectures.some(cpu => ["arm64", "x86_64"].includes(cpu)) || info.slices.some(slice => slice.platform !== 1 || slice.dependencies.some(dep => !dep.path.startsWith("/usr/lib/") && !dep.path.startsWith("/System/Library/")))) throw new Error("The uosc helper has unsupported native dependencies.");
          fs.chmodSync(binary, 0o755);
          await (dependencies.ensureForExecutable || Rosetta.ensureForExecutable)(binary, { ...context, signal: combined, onProgress: task.onProgress });
        }
        const files = inventory(unpacked);
        fs.writeFileSync(path.join(unpacked, "plugin.json"), JSON.stringify({ schema: 1, id: pkg.id, version: entry.version, versionLabel: entry.versionLabel || entry.version,
          upstreamRevision: entry.upstreamRevision, sourceUrl: entry.sourceUrl || pkg.sourceUrl, ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
          assets, ...(nativeHelper ? {nativeHelper} : {}), installedAt: new Date().toISOString(), files }, null, 2) + "\n");
        throwIfAborted(combined);
        await (dependencies.removeManagedRuntimeQuarantine || removeManagedRuntimeQuarantine)({ installDir: unpacked }, { userDataDir, signal: combined });
        const retired = path.join(stage, "retired");
        if (fs.existsSync(directory)) fs.renameSync(directory, retired);
        try { fs.renameSync(unpacked, directory); }
        catch (error) { if (fs.existsSync(retired)) fs.renameSync(retired, directory); throw error; }
        verificationCache.delete(directory);
        const result = status(userDataDir, pkg.id, { version: entry.version, verification: "full" });
        if (!result) throw new Error("The installed mpv plugin could not be verified.");
        return result;
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }, { onProgress });
    active.set(key, operation);
    try { return await operation; } finally { active.delete(key); }
  }
  // One plugin's failed discovery leaves the others refreshed.
  async function refreshCatalog({ userDataDir, sectionId, signal, logger } = {}) {
    const results = await Promise.allSettled((sectionId ? [packageFor(sectionId)] : Object.values(packages)).map(pkg => discover({ userDataDir, id: pkg.id, signal, logger })));
    if (results.every(result => result.status === "rejected")) throw results[0].reason;
    return manager.getState({ userDataDir });
  }
  const manager = {
    id: MANAGER_ID, label: "mpv plugins", normalizeSettings: () => ({}), upstream: [Sources.uosc, Sources.thumbfast],
    delivery: Object.freeze({ included: "none", catalog: "remote", sourceBuild: false }),
    getState({ userDataDir } = {}) {
      const customInstalls = custom.list(userDataDir);
      const sections = Object.values(packages).map(pkg => {
        const cached = cachedCatalog(userDataDir, pkg.id), entries = cached?.entries || [], newest = entries[0];
        const listed = entries.map(entry => entry.version);
        const managed = userDataDir ? installs(userDataDir, pkg.id) : [], ready = new Set(managed.map(install => install.version));
        const damaged = userDataDir ? installedVersions(userDataDir, pkg.id).filter(version => !ready.has(version)) : [];
        const supplied = customInstalls.find(plugin => plugin.ready && plugin.enabled !== false && provides(plugin, pkg.id));
        const labels = Object.fromEntries(entries.map(entry => [entry.version, entry.versionLabel || entry.version]));
        for (const install of managed) if (install.versionLabel) labels[install.version] ||= install.versionLabel;
        const labelFor = version => labels[version] || (REVISION.test(version) ? version.slice(0, 12) : version);
        const versions = [...new Set([...listed, ...managed.map(install => install.version), ...damaged])];
        const versionLabels = Object.fromEntries(versions.map(version => [version, labelFor(version)]));
        // The card shows the copy playback uses, otherwise the default version
        // that Install obtains, discovering it first when nothing is listed.
        const version = supplied?.version || managed[0]?.version || managerDefaultVersion({ listed }) || damaged[0] || null;
        const current = supplied || managed[0];
        return { id: pkg.id, label: pkg.label, supportsDefault: false,
          plugin: { settingKey: pkg.settingKey, version, versionLabel: supplied ? supplied.versionLabel || undefined : version ? labelFor(version) : undefined,
            sourceUrl: pkg.sourceUrl, updatable: true, latestVersionLabel: newest?.versionLabel,
            updateAvailable: Boolean(newest && current && newest.upstreamRevision !== current.upstreamRevision), description: pkg.description },
          installed: [
            ...(supplied ? [{ ...supplied, providedVersion: supplied.version, providedVersionLabel: supplied.versionLabel, removable: false, suppliedBy: supplied.label }] : []),
            ...managed.map(install => ({ ...install, versionLabel: labelFor(install.version) })),
            ...damaged.map(version => ({ version, versionLabel: labelFor(version), installDir: path.join(storageRoot(userDataDir), pkg.id, version), ready: false, status: "damaged", removable: true,
              reason: "The installed plugin is incomplete or changed. Install it again to repair it." }))],
          versionLabels, variants: [],
          catalog: { status: cached ? "success" : "idle", fetchedAt: cached?.fetchedAt || null, error: null, ...discovery.get(pkg.id), source: pkg.sourceUrl, sourceUrl: pkg.sourceUrl,
            versions: listed, versionLabels, installable: true, installableVersions: listed, supportsLatestOnly: false,
            versionRequirements: Object.fromEntries(versions.map(version => [version, { requiresDownload: !ready.has(version), available: ready.has(version), installLabel: "Install" }])) } };
      });
      sections.push(...customInstalls.map(install => ({ id: install.id, label: install.label, supportsDefault: false,
        plugin: { custom: true, enabled: install.enabled, version: install.version, versionLabel: install.versionLabel, sourceUrl: install.sourceUrl,
          updatable: Boolean(install.updateSource || install.sourceKey || install.sourceUrl),
          description: `${install.scripts.length} installed script${install.scripts.length === 1 ? "" : "s"}.` },
        installed: [install], variants: [], catalog: { status: "idle", versions: [], installableVersions: [], installable: false } })));
      return { id: MANAGER_ID, label: "mpv plugins", supportsDefault: false, sections };
    },
    refreshCatalog, installRuntime: options => options?.source ? custom.install(options) : install(options),
    async updatePlugin({ id, ...context }) {
      if (require("./custom-plugins").validId(id)) return custom.update({ ...context, id });
      const pkg = packageFor(id), supplied = custom.list(context.userDataDir, { full: true }).find(plugin => plugin.ready && plugin.enabled !== false && provides(plugin, id));
      // An added copy that provides this plugin keeps updating as an added plugin.
      if (supplied) return manager.installRuntime({ ...context, source: pkg.updateSource, label: id, enabled: true, previous: supplied });
      const previous = status(context.userDataDir, id, { verification: "full" });
      if (!previous?.ready) throw new Error("The plugin must be installed before it can be updated.");
      const [newest] = await discover({ userDataDir: context.userDataDir, id, signal: context.signal, logger: context.logger });
      if (newest.version === previous.version) return { ...previous, updated: false };
      const result = await manager.installRuntime({ ...context, sectionId: id, version: newest.version });
      // The verified new version replaces the earlier copies of this plugin. A
      // copy that a running playback still uses stays until the next update.
      for (const version of installedVersions(context.userDataDir, id)) {
        if (version === result.version) continue;
        try { await manager.uninstallRuntime({ userDataDir: context.userDataDir, sectionId: id, version }); }
        catch (error) { context.logger?.warn?.(`The earlier ${pkg.label} copy ${version} was kept: ${error.message}`); }
      }
      return { ...result, updated: true };
    },
    listCustom: custom.list,
    setCustomEnabled(options) {
      const selected = custom.read(options.userDataDir, options.id, { full: true });
      const result = custom.setEnabled(options);
      if (options.enabled === true) for (const prior of custom.list(options.userDataDir)) {
        if (prior.id === selected.id || prior.enabled === false || !prior.ready) continue;
        if (prior.sourceKey && prior.sourceKey === selected.sourceKey || Object.keys(packages).some(id => provides(prior, id) && provides(selected, id)))
          custom.setEnabled({ userDataDir: options.userDataDir, id: prior.id, enabled: false });
      }
      return result;
    },
    uninstallRuntime({ userDataDir, sectionId, version } = {}) {
      if (require("./custom-plugins").validId(sectionId)) return custom.remove({ userDataDir, id: sectionId });
      packageFor(sectionId); removeVersion(userDataDir, sectionId, version); return true;
    }
  };
  return manager;
}
module.exports = { packages, required, provides, playbackStatus, status, createManager, manager: createManager() };
