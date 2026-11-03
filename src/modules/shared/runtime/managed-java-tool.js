const fs = require("node:fs");
const { hasFineChangeTime } = require("../file-time");
const { createVerifiedIdentityCache } = require("./verified-identity");
const { cloneOrCopySync } = require("../copy-file");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Upstream = require("./upstream");
const Native = require("./local-native");
const JavaHost = require("./java-tool-host");
const { readZipEntries, readZipEntryBuffer } = require("./zip");
const { inspectJar } = require("../../java/detect");
const { throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { runToolCommand } = require("./tool-command");
const Custom = require("./custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion, savedDefaultVersion } = require("./version-choices");

const LIMITS = { versions: 500, entries: 2000, archive: 1024 * 1024 * 1024, expanded: 2 * 1024 * 1024 * 1024 };
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");
// Files beside a Java tool's portable download: graphical or runtime-bundled
// builds, other systems, installers, sources and libraries.
const OTHER_FILES = /(?:^|[^a-z0-9])(?:gui|jre|jdk|win|win32|win64|windows|linux|mac|macos|macosx|osx|darwin|setup|installer|src|source|sources|javadoc|debug|symbols|lib)(?=[^a-z]|$)/i;
// A release's portable download: the publisher's current file name wins, then
// the shortest file of the tool's own name in a supported format.
function releaseAsset(release, { names = [], pattern, extensions = [".zip"] }) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find(asset => names.includes(asset?.name)) || assets.filter(asset => {
    const name = String(asset?.name || "");
    return pattern.test(name) && extensions.some(extension => name.toLowerCase().endsWith(extension)) && !OTHER_FILES.test(name);
  }).sort((a, b) => a.name.length - b.name.length)[0] || null;
}

// A Java tool listed by an upstream source: each release's first file is its
// portable download, a JAR or an archive holding one.
function createManagedJavaTool(config) {
  const { id, label, upstream, jarName: configuredJarName, order = 250 } = config;
  function applicationJar(version) {
    const relative = typeof configuredJarName === "function" ? configuredJarName(normalizeVersion(version)) : configuredJarName;
    if (!safeRelative(relative) || !/\.jar$/i.test(relative)) throw new Error(`${label} Java application path is invalid.`);
    return relative;
  }
  const source = config.sourceUrl || `https://github.com/${upstream.repository}/releases`;
  const repositoryId = upstream.repository || source;
  const states = new Map(), pending = new Map(), verified = createVerifiedIdentityCache({ maximum: 64 });
  function normalizeVersion(value) {
    const version = String(value || "").replace(/^v(?=\d)/, "");
    if (!/^[0-9][0-9A-Za-z._-]{0,79}$/.test(version)) throw new Error(`Invalid ${label} version.`);
    return version;
  }
  function directory(userDataDir) {
    if (!path.isAbsolute(userDataDir || "")) throw new Error(`${label} requires the launcher's data directory.`);
    return path.join(userDataDir, "runtimes", id);
  }
  let installRoot = (userDataDir, version) => path.join(directory(userDataDir), normalizeVersion(version));
  const compare = (a, b) => String(b).localeCompare(String(a), "en", { numeric: true });
  // Cached rows keep the shape earlier versions wrote; the size and digests
  // are the publisher's when it listed them.
  function validRow(row) {
    try {
      const url = new URL(row.url);
      return normalizeVersion(row.version) === row.version && url.protocol === "https:" && !url.username && !url.password &&
        (row.bytes == null || Number.isSafeInteger(row.bytes) && row.bytes > 0) && (!row.sha256 || /^[a-f0-9]{64}$/.test(row.sha256));
    } catch { return false; }
  }
  const listedFile = row => Upstream.listedFile({ url: row.url, bytes: row.bytes ?? undefined, sha256: row.sha256,
    digest: row.digest || (row.md5 ? { algorithm: "md5", value: row.md5 } : undefined) });
  function cached(userDataDir) {
    try {
      const file = path.join(directory(userDataDir), "catalog.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
      // Rows this launcher cannot read are left out; the others stay listed.
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.repo !== repositoryId || !Array.isArray(record.entries)) return null;
      return { ...record, entries: record.entries.filter(validRow).slice(0, LIMITS.versions) };
    } catch { return null; }
  }
  function rowFor(userDataDir, version) {
    version = normalizeVersion(version);
    const row = cached(userDataDir)?.entries.find(row => row.version === version);
    if (!row || !validRow(row)) throw new Error(`Refresh the ${label} version list before installing this version.`);
    return row;
  }
  function resolve({ userDataDir, version, verification = "full" }) {
    try {
      const root = installRoot(userDataDir, version), metaPath = path.join(root, "tool.json"), stat = fs.lstatSync(metaPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
      const record = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const jarName = record.jarRelative === undefined ? applicationJar(version) : record.jarRelative;
      if (!safeRelative(jarName) || !/\.jar$/i.test(jarName)) return null;
      if (record.id !== id || record.version !== normalizeVersion(version) || !validRow(record.artifact) ||
        record.artifact.version !== record.version || !/^[a-f0-9]{64}$/.test(record.archiveSha256) ||
        (record.artifact.sha256 && record.archiveSha256 !== record.artifact.sha256) ||
        !record.files || Object.keys(record.files).length > LIMITS.entries || !record.files[jarName]) return null;
      const identities = [];
      let fine = hasFineChangeTime(stat);
      for (const [relative, item] of Object.entries(record.files)) {
        if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(item.sha256)) return null;
        const stat = fs.lstatSync(path.join(root, "files", relative));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) return null;
        fine = fine && hasFineChangeTime(stat);
        identities.push([relative, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verification !== "status" && !verified.verify(root, { identity: () => fine ? identity : null, verify: () => {
        for (const [relative, item] of Object.entries(record.files))
          if (Native.hashFile(path.join(root, "files", relative)) !== item.sha256) return false;
        return true;
      } })) return null;
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
    const versions = [...rows.keys()].sort(compare), previous = states.get(userDataDir) || {
      status: record ? "success" : "idle", fetchedAt: record?.fetchedAt || null, error: null };
    const saved = savedDefaultVersion(cfg.defaultVersion, { listed: versions, installed: installed.map(row => row.version) });
    const base = { supportsDefault: true, defaultVersion: saved || managerDefaultVersion({ listed: versions, installed: installed.map(row => row.version) }), defaultSource: saved ? "saved" : "manager", installed, installing: null, variants: [],
      catalog: { ...previous, source, sourceUrl: source, mode: "all", versions, installable: versions.length > 0,
        installableVersions: versions, includedVersions: [], buildableVersions: [], supportsLatestOnly: false,
         latestAvailableVersion: versions[0] || null,
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
        // Rows this launcher cannot read are left out.
        const rows = new Map();
        for (const row of await upstream.discover({ signal, logger })) {
          const [listed] = row.files;
          if (!listed || rows.has(row.version)) continue;
          const entry = { version: row.version, url: listed.url, ...(listed.bytes ? { bytes: listed.bytes } : {}),
            ...(listed.digest?.algorithm === "sha256" ? { sha256: listed.digest.value } : listed.digest ? { digest: listed.digest } : {}),
            sourceUrl: row.sourceUrl || source };
          if (validRow(entry)) rows.set(entry.version, entry);
          if (rows.size >= LIMITS.versions) break;
        }
        if (!rows.size) throw new Error(`No compatible ${label} downloads were found.`);
        throwIfAborted(signal);
        const root = directory(userDataDir); fs.mkdirSync(root, { recursive: true });
        const record = { repo: repositoryId, fetchedAt: Date.now(), entries: [...rows.values()].sort((a, b) => compare(a.version, b.version)) };
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
  // A publisher may move or rename its application JAR: the known path wins,
  // then the same file name in a folder, then the JAR holding the entry point.
  function locateJar(files, version) {
    const known = applicationJar(version), jars = [];
    if (fs.existsSync(path.join(files, known))) return known;
    (function walk(directory, prefix, depth) {
      if (depth > 4) return;
      for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 512)) {
        if (item.name === "__MACOSX" || item.name.startsWith(".")) continue;
        if (item.isDirectory()) walk(path.join(directory, item.name), prefix + item.name + "/", depth + 1);
        else if (item.isFile() && /\.jar$/i.test(item.name)) jars.push(prefix + item.name);
      }
    })(files, "", 0);
    jars.sort((a, b) => a.split("/").length - b.split("/").length);
    const entryPoint = relative => { try {
      return config.mainClass ? Boolean(readZipEntryBuffer(path.join(files, relative), config.mainClass.replace(/\./g, "/") + ".class"))
        : Boolean(inspectJar(path.join(files, relative)).mainClass);
    } catch { return false; } };
    return jars.find(relative => path.posix.basename(relative) === path.posix.basename(known)) || jars.find(entryPoint) || null;
  }
  function extract(archive, destination, version) {
    const jarName = applicationJar(version);
    if (config.standaloneJar === true) {
      const target = path.join(destination, jarName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      cloneOrCopySync(archive, target);
      return jarName;
    }
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
    const located = locateJar(destination, version);
    if (!located) throw new Error(`${label} archive is missing its Java application.`);
    return located;
  }
  function validateDependencies(files, version, customJarName) {
    const jarName = customJarName || applicationJar(version), mainJar = path.join(files, jarName);
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
    if (!cached(context.userDataDir)) await refreshCatalog(context, dependencies);
    const version = getState(context).defaultVersion;
    if (!version) throw new Error(`No ${label} versions are available to download.`);
    return version;
  }
  async function installRuntime(context = {}, dependencies = {}) {
    const settings = context.settings?.runtimes?.[id] || context.settings;
    let version = selectRuntimeVersion({ manual: context.version,
      defaultVersion: getState({ userDataDir: context.userDataDir, settings }).defaultVersion }).version;
    const existing = version && resolve({ userDataDir: context.userDataDir, version });
    if (existing) return existing;
    await confirmToolInstall(context, { managerId: id, label, version, requiresDownload: true,
      installOptions: { sectionId: "default" }, detail: `Required to use ${label} for this game.` });
    if (!version) version = await latestVersion(context, dependencies);
    version = normalizeVersion(version);
    let artifact;
    try { artifact = rowFor(context.userDataDir, version); }
    catch { await refreshCatalog({ ...context, force: true }, dependencies); artifact = rowFor(context.userDataDir, version); }
    return withRuntimeMutation({ managerId: id, sectionId: "default", version }, async () => {
      const installed = resolve({ userDataDir: context.userDataDir, version }); if (installed) return installed;
      return runDownloadTask(context.downloads, { managerId: id, sectionId: "default", version, label, kind: "tool",
        dedupeKey: `${id}:${context.userDataDir}:${version}` }, async task => {
        const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal, target = installRoot(context.userDataDir, version);
        fs.mkdirSync(directory(context.userDataDir), { recursive: true });
        const temporary = fs.mkdtempSync(path.join(directory(context.userDataDir), ".install-"));
        let backup;
        try {
          const archive = path.join(temporary, "download.zip"), files = path.join(temporary, "files"); fs.mkdirSync(files);
          const listed = listedFile(artifact);
          if (!listed) throw new Error(`Refresh the ${label} version list before installing this version.`);
          const { sha256: archiveSha256 } = await Upstream.download(listed, archive, { signal, onProgress: task.onProgress });
          throwIfAborted(signal);
          const jarName = (dependencies.extract || extract)(archive, files, version) || applicationJar(version);
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
          validateDependencies(files, version, jarName);
          if (config.mainClass && !readZipEntryBuffer(path.join(files, jarName), config.mainClass.replace(/\./g, "/") + ".class"))
            throw new Error(`${label} Java entry point is missing.`);
          const jar = (dependencies.inspectJar || inspectJar)(path.join(files, jarName));
          if (!inventory[jarName] || !jar.mainClass) throw new Error(`${label} Java application is incomplete.`);
          const record = { id, version, artifact, archiveSha256, requiredJava: Math.max(17, jar.requiredJava || 17),
            ...(jarName === applicationJar(version) ? {} : { jarRelative: jarName }), installedAt: new Date().toISOString(), files: inventory };
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
    // A registered tool path is passed on; a saved version applies as the
    // default, so one that left the list gives way to the manager's default.
    const cfg = manager.normalizeSettings(context.settings?.runtimes?.[id]);
    const version = payload.version || (Custom.isPath(cfg.defaultVersion) ? cfg.defaultVersion : null);
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
  const manager = { id, label, upstream, distributionRequired: false, delivery: { included: "none", catalog: "remote", sourceBuild: false },
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: label, order, memberOrder: order, management: "managed" },
    normalizeVersion, normalizeSettings, getState, refreshCatalog, installRuntime,
    trashFirst: true,
    uninstallRuntime: async ({ userDataDir, version, installDir } = {}) => {
      const target = installRoot(userDataDir, version);
      if (installDir && path.resolve(installDir) !== target) throw new Error(`The selected directory does not belong to ${label}.`);
      return withRuntimeMutation({ managerId: id, version: normalizeVersion(version), sectionId: "default", sourcePath: target },
        () => { fs.rmSync(target, { recursive: true, force: true }); return true; }, { userDataDir });
    },
    applySettingsUpdate: (action, payload, settings) => action === "setDefault"
      ? { defaultVersion: payload?.version ? normalizeVersion(payload.version) : null } : normalizeSettings(settings),
    updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion ? settings : { ...settings, defaultVersion: installed.version },
    updateSettingsAfterUninstall: (settings, payload) => normalizeSettings(settings).defaultVersion === payload.version
      ? { defaultVersion: null } : normalizeSettings(settings),
    core: { ensure, run, resolve, listInstalled, installRoot, rowFor, extract, locateJar, normalizeVersion }, __test: { validRow, cached, LIMITS } };
  Custom.configure(manager, { defaultsPath: () => ["defaultVersion"],
    providers: [{ core: manager.core, lists: { listInstalled: "default" }, resolves: { resolve: "default" },
      versions: ["normalizeVersion"], directories: ["installRoot"] }], inspect(runtimePath) {
    let jarPath = runtimePath;
    if (fs.statSync(runtimePath).isDirectory()) {
      const candidates = [runtimePath, path.join(runtimePath, "lib"), path.join(runtimePath, "files"), path.join(runtimePath, "files", "lib")]
        .flatMap(root => { try { return fs.readdirSync(root).slice(0, 256).filter(name => /\.jar$/i.test(name)).map(name => path.join(root, name)); } catch { return []; } });
      const matching = candidates.filter(file => config.mainClass ? Boolean(readZipEntryBuffer(file, config.mainClass.replace(/\./g, "/") + ".class")) : inspectJar(file).mainClass);
      if (matching.length !== 1) throw new Error(`Select the ${label} application JAR or its complete tool directory.`);
      jarPath = matching[0];
    }
    const stat = fs.statSync(jarPath);
    if (!stat.isFile() || stat.size > LIMITS.archive || !/\.jar$/i.test(jarPath)) throw new Error(`Select the ${label} application JAR or its complete tool directory.`);
    const jar = inspectJar(jarPath), root = path.dirname(jarPath);
    if (config.mainClass ? !readZipEntryBuffer(jarPath, config.mainClass.replace(/\./g, "/") + ".class") : !jar.mainClass)
      throw new Error(`The selected JAR does not contain the ${label} application entry point.`);
    validateDependencies(root, null, path.basename(jarPath));
    return { root, installDir: root, jarPath, executablePath: jarPath, ready: true, requiredJava: Math.max(17, jar.requiredJava || 17) };
  } });
  Custom.instrumentManagers([manager]);
  resolve = manager.core.resolve; listInstalled = manager.core.listInstalled; installRoot = manager.core.installRoot; normalizeVersion = manager.core.normalizeVersion;
  manager.normalizeVersion = normalizeVersion;
  installRuntime = manager.installRuntime;
  return manager;
}

module.exports = { createManagedJavaTool, releaseAsset };
