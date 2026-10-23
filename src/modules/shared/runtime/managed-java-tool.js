const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Releases = require("./github-releases");
const Native = require("./local-native");
const JavaHost = require("./java-tool-host");
const { readZipEntries, readZipEntryBuffer } = require("./zip");
const { inspectJar } = require("../../java/detect");
const { downloadToFile, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { runToolCommand } = require("./tool-command");

const LIMITS = { versions: 500, entries: 2000, archive: 128 * 1024 * 1024, expanded: 256 * 1024 * 1024 };
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");

function createManagedJavaTool(config) {
  const { id, label, owner, repo, jarName: configuredJarName, pins = [], order = 250 } = config;
  function applicationJar(version) {
    const relative = typeof configuredJarName === "function" ? configuredJarName(normalizeVersion(version)) : configuredJarName;
    if (!safeRelative(relative) || !/\.jar$/i.test(relative)) throw new Error(`${label} Java application path is invalid.`);
    return relative;
  }
  const source = `https://github.com/${owner}/${repo}/releases`;
  const states = new Map(), pending = new Map(), verified = new Map();
  function normalizeVersion(value) {
    const version = String(value || "").replace(/^v(?=\d)/, "");
    if (!/^[0-9][0-9A-Za-z._-]{0,79}$/.test(version)) throw new Error(`Invalid ${label} version.`);
    return version;
  }
  function directory(userDataDir) {
    if (!path.isAbsolute(userDataDir || "")) throw new Error(`${label} requires the launcher's data directory.`);
    return path.join(userDataDir, "runtimes", id);
  }
  const installRoot = (userDataDir, version) => path.join(directory(userDataDir), normalizeVersion(version));
  const compare = (a, b) => String(b).localeCompare(String(a), "en", { numeric: true });
  function validRow(row) {
    try {
      if (normalizeVersion(row.version) !== row.version || !row.tag || typeof row.tag !== "string") return false;
      const url = new URL(row.url), expected = `/${owner}/${repo}/releases/download/${row.tag}/`;
      const selected = config.releaseArtifact({ tag_name: row.tag,
        assets: [{ name: path.posix.basename(url.pathname), browser_download_url: row.url, size: row.bytes }] });
      if (!selected || selected.version !== row.version) return false;
      return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(expected) &&
        !url.search && !url.hash && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= LIMITS.archive &&
        (!row.sha256 || /^[a-f0-9]{64}$/.test(row.sha256));
    } catch { return false; }
  }
  function cached(userDataDir) {
    try {
      const file = path.join(directory(userDataDir), "catalog.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.repo !== `${owner}/${repo}` || !Array.isArray(record.entries) || record.entries.length > LIMITS.versions ||
        record.entries.some(row => !validRow(row))) return null;
      return record;
    } catch { return null; }
  }
  function rowFor(userDataDir, version) {
    version = normalizeVersion(version);
    const row = cached(userDataDir)?.entries.find(row => row.version === version) || pins.find(row => row.version === version);
    if (!row || !validRow(row)) throw new Error(`Refresh the ${label} version list before installing this version.`);
    return row;
  }
  function resolve({ userDataDir, version, verification = "full" }) {
    try {
      const jarName = applicationJar(version);
      const root = installRoot(userDataDir, version), metaPath = path.join(root, "tool.json"), stat = fs.lstatSync(metaPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
      const record = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (record.id !== id || record.version !== normalizeVersion(version) || !validRow(record.artifact) ||
        record.artifact.version !== record.version || !/^[a-f0-9]{64}$/.test(record.archiveSha256) ||
        (record.artifact.sha256 && record.archiveSha256 !== record.artifact.sha256) ||
        !record.files || Object.keys(record.files).length > LIMITS.entries || !record.files[jarName]) return null;
      const identities = [];
      for (const [relative, item] of Object.entries(record.files)) {
        if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(item.sha256)) return null;
        const stat = fs.lstatSync(path.join(root, "files", relative));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) return null;
        identities.push([relative, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verification !== "status" && verified.get(root) !== identity) {
        for (const [relative, item] of Object.entries(record.files))
          if (Native.hashFile(path.join(root, "files", relative)) !== item.sha256) return null;
        if (verified.size >= 64) verified.delete(verified.keys().next().value);
        verified.set(root, identity);
      }
      return { ...record, root, installDir: root, jarPath: path.join(root, "files", jarName),
        executablePath: path.join(root, "files", jarName), ready: true, removable: true, sectionId: "default" };
    } catch { return null; }
  }
  function listInstalled(userDataDir) {
    try { return fs.readdirSync(directory(userDataDir)).filter(name => /^[0-9][0-9A-Za-z._-]{0,79}$/.test(name))
      .slice(0, LIMITS.versions).map(version => resolve({ userDataDir, version, verification: "status" }))
      .filter(Boolean).sort((a, b) => compare(a.version, b.version)); } catch { return []; }
  }
  function normalizeSettings(settings) {
    let defaultVersion = null;
    try { if (settings?.defaultVersion) defaultVersion = normalizeVersion(settings.defaultVersion); } catch {}
    return { defaultVersion };
  }
  function getState({ userDataDir, settings } = {}) {
    const record = cached(userDataDir), installed = listInstalled(userDataDir), cfg = normalizeSettings(settings);
    const rows = new Map((record?.entries || []).map(row => [row.version, row]));
    for (const item of installed) if (!rows.has(item.version)) rows.set(item.version, item.artifact);
    const versions = [...rows.keys()].sort(compare), previous = states.get(userDataDir) || {
      status: record ? "success" : "idle", fetchedAt: record?.fetchedAt || null, error: null };
    const base = { supportsDefault: true, defaultVersion: cfg.defaultVersion, installed, installing: null, variants: [],
      catalog: { ...previous, source, sourceUrl: source, mode: "all", versions, installable: versions.length > 0,
        installableVersions: versions, includedVersions: [], buildableVersions: [], supportsLatestOnly: false,
        recommendedVersion: versions[0] || null, latestAvailableVersion: versions[0] || null,
        latestInstalledVersion: installed[0]?.version || null,
        updateAvailable: Boolean(cfg.defaultVersion && versions[0] && compare(cfg.defaultVersion, versions[0]) > 0),
        versionRequirements: Object.fromEntries(versions.map(version => [version, { requiresDownload: !installed.some(row => row.version === version),
          requiresBuild: false, available: installed.some(row => row.version === version), included: false, installLabel: "Install" }])) } };
    return { ...base, sections: [{ id: "default", label, ...base }] };
  }
  async function refreshCatalog({ userDataDir, force = false, signal, logger } = {}, dependencies = {}) {
    directory(userDataDir);
    const previous = cached(userDataDir);
    if (!force && previous && Date.now() - previous.fetchedAt < 6 * 60 * 60 * 1000) return getState({ userDataDir }).catalog;
    if (pending.has(userDataDir)) return pending.get(userDataDir);
    states.set(userDataDir, { status: "loading", fetchedAt: previous?.fetchedAt || null, error: null });
    const task = (async () => {
      try {
        const releases = await (dependencies.fetchReleases || Releases.fetchGithubReleases)({ owner, repo, logger, signal,
          includePrerelease: false, maxPages: 5 });
        const rows = new Map();
        for (const release of releases) {
          if (release.draft || release.prerelease) continue;
          const selected = config.releaseArtifact(release);
          if (!selected) continue;
          const { asset, version } = selected;
          const row = { version: normalizeVersion(version), tag: release.tag_name, url: asset.browser_download_url,
            bytes: asset.size, sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest || "") ? asset.digest.slice(7) : null,
            sourceUrl: release.html_url || `${source}/tag/${release.tag_name}` };
          if (validRow(row) && !rows.has(row.version)) rows.set(row.version, row);
          if (rows.size >= LIMITS.versions) break;
        }
        if (!rows.size) throw new Error(`No compatible ${label} downloads were found.`);
        throwIfAborted(signal);
        const root = directory(userDataDir); fs.mkdirSync(root, { recursive: true });
        const record = { repo: `${owner}/${repo}`, fetchedAt: Date.now(), entries: [...rows.values()].sort((a, b) => compare(a.version, b.version)) };
        const temporary = path.join(root, `.catalog-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(temporary, JSON.stringify(record, null, 2)); fs.renameSync(temporary, path.join(root, "catalog.json"));
        states.set(userDataDir, { status: "success", fetchedAt: record.fetchedAt, error: null });
        return getState({ userDataDir }).catalog;
      } catch (error) {
        states.set(userDataDir, { status: "error", fetchedAt: previous?.fetchedAt || null, error: String(error.message || error) });
        throw error;
      } finally { pending.delete(userDataDir); }
    })();
    pending.set(userDataDir, task); return task;
  }
  function extract(archive, destination, version) {
    const jarName = applicationJar(version);
    const zip = readZipEntries(archive);
    if (!zip?.entries?.length || zip.entries.length > LIMITS.entries || zip.entries.length !== zip.info.entries)
      throw new Error(`${label} archive is invalid.`);
    const names = new Set(); let bytes = 0;
    for (const item of zip.entries) {
      const relative = item.name.replace(/\/$/, "");
      if (!safeRelative(relative) || names.has(relative) || item.uncompressedSize > LIMITS.archive ||
        (bytes += item.uncompressedSize) > LIMITS.expanded) throw new Error(`${label} archive contains an unsafe or oversized entry.`);
      names.add(relative);
      if (item.name.endsWith("/") || (!/\.(?:jar|swc|txt|md|properties)$/i.test(relative) &&
        !/^(?:LICENSE|NOTICE|COPYING|AUTHORS)(?:[._-].*)?$/i.test(path.posix.basename(relative)))) continue;
      const buffer = readZipEntryBuffer(archive, item.name);
      if (!buffer || buffer.length !== item.uncompressedSize) throw new Error(`${label} archive extraction failed.`);
      const file = path.join(destination, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buffer);
    }
    if (!fs.existsSync(path.join(destination, jarName))) throw new Error(`${label} archive is missing its Java application.`);
  }
  function validateDependencies(files, version) {
    const jarName = applicationJar(version), mainJar = path.join(files, jarName);
    const manifest = readZipEntryBuffer(mainJar, "META-INF/MANIFEST.MF");
    if (!manifest || manifest.length > 1024 * 1024) throw new Error(`${label} Java manifest is missing or oversized.`);
    const unfolded = manifest.toString("utf8").replace(/\r?\n /g, "");
    const classPath = /^Class-Path:\s*(.*)$/im.exec(unfolded)?.[1]?.trim();
    for (const relative of classPath ? classPath.split(/\s+/) : []) {
      if (!safeRelative(relative)) throw new Error(`${label} contains an unsupported Java dependency path.`);
      const dependency = path.join(files, path.dirname(jarName), relative);
      let stat;
      try { stat = fs.lstatSync(dependency); } catch { throw new Error(`${label} Java dependencies are incomplete.`); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} Java dependencies are incomplete.`);
    }
  }
  async function latestVersion(context, dependencies) {
    if (!cached(context.userDataDir)) {
      try { await refreshCatalog(context, dependencies); }
      catch (error) {
        const fallback = pins.filter(validRow).sort((a, b) => compare(a.version, b.version))[0];
        if (!fallback) throw error;
        return fallback.version;
      }
    }
    return getState(context).catalog.versions[0];
  }
  async function installRuntime(context = {}, dependencies = {}) {
    let version = context.version || normalizeSettings(context.settings?.runtimes?.[id] || context.settings).defaultVersion;
    if (!version) version = await latestVersion(context, dependencies);
    version = normalizeVersion(version);
    const jarName = applicationJar(version);
    const existing = resolve({ userDataDir: context.userDataDir, version });
    if (existing) return existing;
    let artifact;
    try { artifact = rowFor(context.userDataDir, version); }
    catch { await refreshCatalog({ ...context, force: true }, dependencies); artifact = rowFor(context.userDataDir, version); }
    return withRuntimeMutation({ managerId: id, sectionId: "default", version }, async () => {
      const installed = resolve({ userDataDir: context.userDataDir, version }); if (installed) return installed;
      await confirmToolInstall(context, { managerId: id, label, version, requiresDownload: true,
        installOptions: { sectionId: "default" }, detail: `Required to use ${label} for this game.` });
      return runDownloadTask(context.downloads, { managerId: id, sectionId: "default", version, label, kind: "tool",
        dedupeKey: `${id}:${context.userDataDir}:${version}` }, async task => {
        const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal, target = installRoot(context.userDataDir, version);
        fs.mkdirSync(directory(context.userDataDir), { recursive: true });
        const temporary = fs.mkdtempSync(path.join(directory(context.userDataDir), ".install-"));
        let backup;
        try {
          const archive = path.join(temporary, "download.zip"), files = path.join(temporary, "files"); fs.mkdirSync(files);
          await (dependencies.downloadToFile || downloadToFile)(artifact.url, archive, { signal, onProgress: task.onProgress });
          throwIfAborted(signal);
          const stat = fs.statSync(archive), archiveSha256 = Native.hashFile(archive);
          if (stat.size !== artifact.bytes || stat.size > LIMITS.archive || (artifact.sha256 && artifact.sha256 !== archiveSha256))
            throw new Error(`${label} download does not match the selected version.`);
          (dependencies.extract || extract)(archive, files, version);
          const inventory = {};
          function walk(root, prefix = "") {
            for (const item of fs.readdirSync(root, { withFileTypes: true })) {
              const relative = prefix + item.name, file = path.join(root, item.name);
              if (!safeRelative(relative) || item.isSymbolicLink()) throw new Error(`${label} package contains an unsafe file.`);
              if (item.isDirectory()) walk(file, relative + "/");
              else if (item.isFile()) inventory[relative] = { bytes: fs.statSync(file).size, sha256: Native.hashFile(file) };
            }
          }
          walk(files);
          validateDependencies(files, version);
          if (config.mainClass && !readZipEntryBuffer(path.join(files, jarName), config.mainClass.replace(/\./g, "/") + ".class"))
            throw new Error(`${label} Java entry point is missing.`);
          const jar = (dependencies.inspectJar || inspectJar)(path.join(files, jarName));
          if (!inventory[jarName] || !jar.mainClass) throw new Error(`${label} Java application is incomplete.`);
          const record = { id, version, artifact, archiveSha256, requiredJava: Math.max(17, jar.requiredJava || 17),
            installedAt: new Date().toISOString(), files: inventory };
          fs.writeFileSync(path.join(temporary, "tool.json"), JSON.stringify(record, null, 2)); fs.rmSync(archive);
          throwIfAborted(signal);
          if (fs.existsSync(target)) { backup = target + ".previous-" + Date.now(); fs.renameSync(target, backup); }
          fs.renameSync(temporary, target);
          const result = resolve({ userDataDir: context.userDataDir, version });
          if (!result) throw new Error(`${label} installation failed its integrity check.`);
          if (backup) fs.rmSync(backup, { recursive: true, force: true });
          context.onRuntimeStateChange?.(); return result;
        } catch (error) {
          if (backup) { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
          throw error;
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      });
    }, { userDataDir: context.userDataDir });
  }
  async function ensure(context, payload = {}, dependencies = {}) {
    const cfg = normalizeSettings(context.settings?.runtimes?.[id]);
    let version = payload.version || cfg.defaultVersion || listInstalled(context.userDataDir)[0]?.version;
    if (!version) version = await latestVersion(context, dependencies);
    const tool = await installRuntime({ ...context, version }, dependencies);
    const host = await (dependencies.ensureHost || JavaHost.ensure)(context, tool.requiredJava);
    return { tool, host };
  }
  async function run(context, payload, options, dependencies = {}) {
    const { tool, host } = await ensure(context, payload, dependencies);
    return withRuntimeUse([{ managerId: id, version: tool.version, sectionId: "default", sourcePath: tool.root }, host.runtimeIdentity], async use => {
      throwIfAborted(context.signal);
      if (!resolve({ userDataDir: context.userDataDir, version: tool.version })) throw new Error(`${label} changed before launch. Try again.`);
      const privateRoot = path.join(directory(context.userDataDir), "preferences"); fs.mkdirSync(privateRoot, { recursive: true });
      const args = [`-Djava.util.prefs.userRoot=${privateRoot}`, `-Duser.home=${privateRoot}`,
        ...(options.javaArgs || []), ...(config.mainClass ? ["-cp", tool.jarPath, config.mainClass] : ["-jar", tool.jarPath]), ...options.args];
      const onSpawn = child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]);
      if (options.gui) {
        const child = (dependencies.spawn || spawn)(host.javaPath, args, { cwd: options.cwd,
          env: process.env, detached: process.platform !== "win32", stdio: "ignore" });
        await new Promise((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
        try { await onSpawn(child); await use.retainUntilClosed(child); }
        catch (error) { child.kill(); throw error; }
        child.unref(); return { toolVersion: tool.version, pid: child.pid };
      }
      try { await (dependencies.runCommand || runToolCommand)(host.javaPath, args, { ...options, signal: context.signal, onSpawn }); }
      catch (error) { error.toolVersion = tool.version; error.toolArchiveSha256 = tool.archiveSha256; throw error; }
      return { toolVersion: tool.version, archiveSha256: tool.archiveSha256 };
    }, { userDataDir: context.userDataDir });
  }
  return { id, label, distributionRequired: false, delivery: { included: "none", catalog: "remote", sourceBuild: false },
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: label, order, memberOrder: order, management: "managed" },
    normalizeVersion, normalizeSettings, getState, refreshCatalog, installRuntime,
    uninstallRuntime: async ({ userDataDir, version, installDir } = {}) => {
      const target = installRoot(userDataDir, version);
      if (installDir && path.resolve(installDir) !== target) throw new Error(`The selected directory does not belong to ${label}.`);
      return withRuntimeMutation({ managerId: id, version: normalizeVersion(version), sectionId: "default", sourcePath: target },
        () => { fs.rmSync(target, { recursive: true, force: true }); return true; }, { userDataDir });
    },
    applySettingsUpdate: (action, payload, settings) => action === "setDefault"
      ? { defaultVersion: payload?.version ? normalizeVersion(payload.version) : null } : normalizeSettings(settings),
    updateSettingsAfterInstall: normalizeSettings,
    updateSettingsAfterUninstall: (settings, payload) => normalizeSettings(settings).defaultVersion === payload.version
      ? { defaultVersion: null } : normalizeSettings(settings),
    core: { ensure, run, resolve, listInstalled, installRoot, rowFor, extract }, __test: { validRow, cached, LIMITS } };
}

module.exports = { createManagedJavaTool };
