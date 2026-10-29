const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { downloadToFile, throwIfAborted } = require("../shared/runtime/download-utils");
const { runDownloadTask } = require("../shared/runtime/download-manager");
const { buildRuntimeDownloadMeta } = require("../shared/runtime/runtime-downloads");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("../shared/runtime/runtime-catalog");
const { readMachOLoadCommands } = require("../shared/runtime/macho-load-commands");
const { removeManagedRuntimeQuarantine } = require("../shared/runtime/managed-quarantine");
const Rosetta = require("../shared/runtime/rosetta");
const Sources = require("./plugin-sources");
const execute = promisify(execFile);
const MANAGER_ID = "mpv-plugins";
const UOSC_REVISION = "d124c2c930d69446448022851373e00ae592390d";
const THUMBFAST_REVISION = "0f711de3138c9bd6718209d819ac54022c23ded2";
const packages = Object.freeze({
  uosc: Object.freeze({ id: "uosc", label: "uosc controls", version: "5.13.0", upstreamRevision: UOSC_REVISION,
    sourceUrl: "https://github.com/tomasklaen/uosc/releases", scriptRelative: "scripts/uosc",
    assets: [
      { filename: "uosc.zip", url: "https://github.com/tomasklaen/uosc/releases/download/5.13.0/uosc.zip", sha256: "4be9da3289285300fa374496c3f1bfd7bb20ac08e890d25bd5a06b28eebe4882", bytes: 8163987 },
      { filename: "script-opts/uosc.conf", url: "https://github.com/tomasklaen/uosc/releases/download/5.13.0/uosc.conf", sha256: "d956aea5d2e90f7690ede41c6a23f855d045f3aa9b05932df27d8045fa3b3396", bytes: 13866 },
      { filename: "LICENSE.LGPL", url: `https://raw.githubusercontent.com/tomasklaen/uosc/${UOSC_REVISION}/LICENSE.LGPL`, sha256: "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551", bytes: 26530 }
    ] }),
  thumbfast: Object.freeze({ id: "thumbfast", label: "Timeline previews", version: THUMBFAST_REVISION, versionLabel: "2026-06-28 snapshot", upstreamRevision: THUMBFAST_REVISION,
    sourceUrl: "https://github.com/po5/thumbfast", scriptRelative: "thumbfast.lua",
    assets: [
      { filename: "thumbfast.lua", url: `https://raw.githubusercontent.com/po5/thumbfast/${THUMBFAST_REVISION}/thumbfast.lua`, sha256: "a3d08e71eae8b892f6cd39f9593ea219768e709312d176bca883841b156448bf", bytes: 32495 },
      { filename: "LICENSE", url: `https://raw.githubusercontent.com/po5/thumbfast/${THUMBFAST_REVISION}/LICENSE`, sha256: "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04", bytes: 16726 }
    ] })
});
for (const pin of Object.values(packages)) {
  pin.assets.forEach(Object.freeze);
  Object.freeze(pin.assets);
}
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
function pinFor(id, version) {
  const pin = packages[id];
  if (!pin || version != null && version !== pin.version) throw new Error("The selected mpv plugin version is unavailable.");
  return pin;
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
function installDirectory(userDataDir, pin) {
  const directory = path.join(storageRoot(userDataDir), pin.id, pin.version);
  for (const current of [path.dirname(directory), directory]) {
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("mpv plugin folders must be local directories."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return directory;
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
const verificationCache = new Map();
function stamp(stat) { return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); }
function status(userDataDir, id, { verification = "status" } = {}) {
  const pin = pinFor(id), installDir = installDirectory(userDataDir, pin), manifest = path.join(installDir, "plugin.json");
  try {
    const metadata = fs.lstatSync(manifest, { bigint: true });
    if (!metadata.isFile() || metadata.size > 128n * 1024n) return null;
    const record = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (record.schema !== 1 || record.id !== id || record.version !== pin.version || record.upstreamRevision !== pin.upstreamRevision ||
      JSON.stringify(record.assets) !== JSON.stringify(pin.assets) || !Array.isArray(record.files) || !record.files.length || record.files.length > 512) return null;
    const observed = [stamp(metadata)];
    for (const file of record.files) {
      if (typeof file.path !== "string" || file.path === "plugin.json" || file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(file.sha256)) return null;
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
    const scriptPath = path.join(installDir, pin.scriptRelative);
    if (!fs.existsSync(scriptPath)) return null;
    return { id, version: pin.version, versionLabel: pin.versionLabel || pin.version,
      installDir, scriptPath, source: "managed", ready: true, removable: true, installedAt: record.installedAt,
      upstreamRevision: pin.upstreamRevision, sourceUrl: pin.sourceUrl,
      ...(id === "uosc" ? { fontsDirectory: path.join(installDir, "fonts"), configFile: path.join(installDir, "script-opts/uosc.conf"),
        helperPath: path.join(installDir, "scripts/uosc/bin/ziggy-darwin") } : {}) };
  } catch { return null; }
}
function createManager(dependencies = {}) {
  const download = dependencies.downloadToFile || downloadToFile, run = dependencies.execute || execute;
  const custom = require("./custom-plugins").create({ storageRoot, inventory, hash, ...dependencies,
    installRuntime: options => manager.installRuntime(options) });
  const active = new Map(), discovery = new Map();
  async function install({ sectionId, version, userDataDir, signal, downloads, onProgress, ...context } = {}) {
    const pin = pinFor(sectionId, version), directory = installDirectory(userDataDir, pin), existing = status(userDataDir, pin.id, { verification: "full" });
    if (existing) return existing;
    const key = directory;
    if (active.has(key)) return active.get(key);
    const operation = runDownloadTask(downloads, buildRuntimeDownloadMeta({ managerId: MANAGER_ID, sectionId: pin.id, version: pin.version, label: pin.label, kind: "mpv-plugin" }), async task => {
      const combined = signal && task.signal ? AbortSignal.any([signal, task.signal]) : signal || task.signal;
      throwIfAborted(combined);
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      const stage = fs.mkdtempSync(path.join(path.dirname(directory), ".install-")), unpacked = path.join(stage, "payload");
      fs.mkdirSync(unpacked);
      try {
        for (const asset of pin.assets) {
          throwIfAborted(combined);
          const target = path.join(asset.filename.endsWith(".zip") ? stage : unpacked, asset.filename);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          await download(asset.url, target, { signal: combined, onProgress: task.onProgress, headers: { "User-Agent": "MacLauncher" } });
          if (fs.statSync(target).size !== asset.bytes || hash(target) !== asset.sha256) throw new Error(`The ${pin.label} download failed its checksum check.`);
          if (asset.filename.endsWith(".zip")) {
            await run("/usr/bin/ditto", ["-x", "-k", target, unpacked], { ...(combined ? { signal: combined } : {}), timeout: 60000, maxBuffer: 128 * 1024 });
          }
        }
        if (pin.id === "uosc") {
          for (const file of ["ziggy-linux", "ziggy-windows.exe"]) fs.rmSync(path.join(unpacked, "scripts/uosc/bin", file));
          const binary = path.join(unpacked, "scripts/uosc/bin/ziggy-darwin"), info = readMachOLoadCommands(binary);
          if (!info.architectures.includes("x86_64") || info.slices.some(slice => slice.platform !== 1 || slice.dependencies.some(dep => !dep.path.startsWith("/usr/lib/") && !dep.path.startsWith("/System/Library/")))) throw new Error("The uosc helper has unsupported native dependencies.");
          fs.chmodSync(binary, 0o755);
          await (dependencies.ensureForExecutable || Rosetta.ensureForExecutable)(binary, { ...context, signal: combined, onProgress: task.onProgress });
        }
        const files = inventory(unpacked);
        fs.writeFileSync(path.join(unpacked, "plugin.json"), JSON.stringify({ schema: 1, id: pin.id, version: pin.version, upstreamRevision: pin.upstreamRevision, assets: pin.assets, installedAt: new Date().toISOString(), files }, null, 2) + "\n");
        throwIfAborted(combined);
        await (dependencies.removeManagedRuntimeQuarantine || removeManagedRuntimeQuarantine)({ installDir: unpacked }, { userDataDir, signal: combined });
        const retired = path.join(stage, "retired");
        if (fs.existsSync(directory)) fs.renameSync(directory, retired);
        try { fs.renameSync(unpacked, directory); }
        catch (error) { if (fs.existsSync(retired)) fs.renameSync(retired, directory); throw error; }
        verificationCache.delete(directory);
        const result = status(userDataDir, pin.id, { verification: "full" });
        if (!result) throw new Error("The installed mpv plugin could not be verified.");
        return result;
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }, { onProgress });
    active.set(key, operation);
    try { return await operation; } finally { active.delete(key); }
  }
  async function refreshCatalog({ userDataDir, sectionId, signal, logger } = {}) {
    const pins = sectionId ? [pinFor(sectionId)] : Object.values(packages);
    for (const pin of pins) {
      discovery.set(pin.id, { status: "loading", error: null });
      try {
        const latest = await Sources.resolveKnownSource(pin.id === "uosc" ? Sources.UOSC_SOURCE : Sources.THUMBFAST_SOURCE, { signal, logger }, dependencies);
        const record = writeRuntimeCatalog({ userDataDir, managerId: MANAGER_ID, sourceId: pin.id, source: pin.sourceUrl,
          entries: [{ version: pin.version, upstreamRevision: pin.upstreamRevision }],
          sourceStates: { latest: { versionLabel: latest.versionLabel, upstreamRevision: latest.upstreamRevision, sourceUrl: latest.sourceUrl } } });
        discovery.set(pin.id, { status: "success", error: null, fetchedAt: record.fetchedAt });
      } catch (error) {
        discovery.set(pin.id, { status: "error", error: error.message }); throw error;
      }
    }
    return manager.getState({ userDataDir });
  }
  const manager = {
    id: MANAGER_ID, label: "mpv plugins", normalizeSettings: () => ({}),
    delivery: Object.freeze({ included: "none", catalog: "remote", sourceBuild: false }),
    getState({ userDataDir } = {}) {
      const customInstalls = custom.list(userDataDir);
      const sections = Object.values(packages).map(pin => {
        const cached = userDataDir && readRuntimeCatalog({ userDataDir, managerId: MANAGER_ID, sourceId: pin.id, validateEntry: entry => entry.version === pin.version && entry.upstreamRevision === pin.upstreamRevision });
        const installed = userDataDir ? status(userDataDir, pin.id) : null;
        const supplied = customInstalls.find(plugin => plugin.ready && plugin.enabled !== false && provides(plugin, pin.id));
        const present = userDataDir && fs.existsSync(installDirectory(userDataDir, pin));
        const versionLabel = pin.versionLabel || pin.version;
        return { id: pin.id, label: pin.label, supportsDefault: false,
          plugin: { settingKey: pin.id === "uosc" ? "uosc" : "timelinePreviews", version: pin.version, versionLabel, sourceUrl: pin.sourceUrl,
            updatable: true,
            latestVersionLabel: cached?.sourceStates?.latest?.versionLabel,
            updateAvailable: Boolean(cached?.sourceStates?.latest?.upstreamRevision && cached.sourceStates.latest.upstreamRevision !== (supplied || installed || pin).upstreamRevision),
            description: pin.id === "uosc" ? "Playback controls, track menus and a seekable timeline. The included Intel helper uses Rosetta on Apple Silicon."
              : "Thumbnail previews when hovering over the timeline. Works with uosc and other thumbfast-compatible controls." },
          installed: supplied ? [{ ...supplied, version: pin.version, providedVersion: supplied.version, providedVersionLabel: supplied.versionLabel, removable: false, suppliedBy: supplied.label }, ...(installed ? [installed] : [])] : installed ? [installed] : present ? [{ version: pin.version, versionLabel, installDir: installDirectory(userDataDir, pin), ready: false, status: "damaged", removable: true, reason: "The installed plugin is incomplete or changed. Install it again to repair it." }] : [],
          versionLabels: { [pin.version]: versionLabel }, variants: [],
          catalog: { status: cached ? "success" : "idle", fetchedAt: cached?.fetchedAt || null, error: null, ...discovery.get(pin.id), source: pin.sourceUrl, sourceUrl: pin.sourceUrl,
            versions: cached ? [pin.version] : [], versionLabels: { [pin.version]: versionLabel },
            installable: Boolean(cached), installableVersions: cached ? [pin.version] : [], supportsLatestOnly: false,
            versionRequirements: { [pin.version]: { requiresDownload: !installed, available: Boolean(installed), installLabel: "Install" } } } };
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
      const pin = pinFor(id), supplied = custom.list(context.userDataDir, { full: true }).find(plugin => plugin.ready && plugin.enabled !== false && provides(plugin, id));
      const previous = supplied || status(context.userDataDir, id, { verification: "full" });
      if (!previous?.ready) throw new Error("The plugin must be installed before it can be updated.");
      return manager.installRuntime({ ...context, source: id === "uosc" ? Sources.UOSC_SOURCE : Sources.THUMBFAST_SOURCE,
        label: id, enabled: true, previous });
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
      const pin = pinFor(sectionId, version), directory = installDirectory(userDataDir, pin);
      fs.rmSync(directory, { recursive: true, force: true }); verificationCache.delete(directory); return true;
    }
  };
  return manager;
}
module.exports = { packages, required, provides, playbackStatus, status, createManager, manager: createManager() };
