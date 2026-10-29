const fs = require("node:fs");
const path = require("node:path");
const Native = require("./local-native");
const Python = require("./python");
const Content = require("./runtime-content");
const { assertOwnDirectory } = require("../writable-input");
const { readZipEntries, readZipEntryBuffer } = require("./zip");
const { fetchUrlBuffer, downloadToFile, throwIfAborted } = require("./download-utils");
const { readRuntimeCatalog, writeRuntimeCatalog } = require("./runtime-catalog");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { runToolCommand } = require("./tool-command");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const Custom = require("./custom-runtime");
const { selectRuntimeVersion, managerDefaultVersion } = require("./version-choices");

const LIMITS = { entries: 2000, versions: 500, archive: 32 * 1024 ** 2, expanded: 64 * 1024 ** 2 };
const safeRelative = name => typeof name === "string" && name && !name.includes("\\") && !/[\x00-\x1f]/.test(name) &&
  !path.posix.isAbsolute(name) && name.split("/").every(part => part && part !== "." && part !== "..");

function createManagedPythonTool({ id, label, packageName, moduleName, scriptName, requiredFiles,
  discoverCatalog, pins = [], sourceUrl, sourceId, archiveLimits = {}, minimumVersion, order = 260 }) {
  if (!/^[a-z0-9-]+$/.test(id || "") || !label || Boolean(moduleName) === Boolean(scriptName) ||
    moduleName && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName) || scriptName && !safeRelative(scriptName))
    throw new Error("Managed Python tools need an identifier and one module or script entry point.");
  if (sourceId != null && !/^[a-z0-9-]+$/.test(sourceId)) throw new Error("Managed Python tool sources need a safe identifier.");
  if (!archiveLimits || typeof archiveLimits !== "object" || Array.isArray(archiveLimits) ||
    Object.entries(archiveLimits).some(([key, value]) => !["archive", "expanded", "entries"].includes(key) || !Number.isSafeInteger(value) || value < 1))
    throw new Error("Managed Python tool archive limits need positive byte and entry counts.");
  const limits = { ...LIMITS, ...archiveLimits };
  const manifestBytes = Math.ceil(limits.entries / LIMITS.entries) * 1024 ** 2;
  if (!Number.isSafeInteger(manifestBytes)) throw new Error("Managed Python tool entry count exceeds its metadata size limit.");
  const required = requiredFiles || [scriptName || moduleName.replace(/\./g, "/") + "/__main__.py"];
  if (!required.every(safeRelative)) throw new Error("Managed Python tool paths are invalid.");
  const source = sourceUrl || `https://pypi.org/project/${packageName}/`;
  const states = new Map(), pending = new Map(), verified = new Map();
  const compare = (a, b) => String(b).localeCompare(String(a), "en", { numeric: true });
  function normalizeVersion(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value || "")) throw new Error(`Invalid ${label} version.`);
    return value;
  }
  function directory(userDataDir) {
    if (!path.isAbsolute(userDataDir || "") || userDataDir.includes("\0")) throw new Error(`${label} requires the launcher's data directory.`);
    return path.join(userDataDir, "runtimes", id);
  }
  let installRoot = (userDataDir, version) => path.join(directory(userDataDir), normalizeVersion(version));
  const orderedRows = rows => rows.some(row => row.kind === "github-commit") ? rows.slice() : rows.slice().sort((a, b) => compare(a.version, b.version));
  function validRow(row) {
    try {
      const url = new URL(row.url);
      if (row.kind === "github-commit") {
        const repository = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(row.repository || "");
        return Boolean(repository && /^[a-f0-9]{40}$/.test(row.revision || "") && row.version === "git-" + row.revision &&
          row.url === `https://codeload.github.com/${row.repository}/zip/${row.revision}` &&
          row.archivePrefix === `${repository[2]}-${row.revision}/`);
      }
      return normalizeVersion(row.version) === row.version && (!minimumVersion || compare(row.version, minimumVersion) <= 0) && url.protocol === "https:" && !url.username && !url.password &&
        Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= limits.archive && /^[a-f0-9]{64}$/.test(row.sha256 || "") &&
        (!row.archivePrefix || safeRelative(row.archivePrefix.replace(/\/$/, "")));
    } catch { return false; }
  }
  const cached = userDataDir => readRuntimeCatalog({ userDataDir, managerId: id, sourceId, validateEntry: validRow });
  function normalizeSettings(settings) {
    try { return { defaultVersion: settings?.defaultVersion ? normalizeVersion(settings.defaultVersion) : null }; }
    catch { return { defaultVersion: null }; }
  }
  function resolve({ userDataDir, version, verification = "full" }) {
    try {
      const root = installRoot(userDataDir, version), file = path.join(root, "tool.json"), stat = fs.lstatSync(file);
      assertOwnDirectory(directory(userDataDir), path.join(root, "files"), { create: false });
      if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > manifestBytes) return null;
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const archiveValid = record.artifact?.kind === "github-commit"
        ? /^[a-f0-9]{64}$/.test(record.archiveSha256 || "") && Number.isSafeInteger(record.archiveBytes) && record.archiveBytes > 0 && record.archiveBytes <= limits.archive
        : record.archiveSha256 === record.artifact?.sha256;
      if (record.id !== id || record.version !== version || !validRow(record.artifact) || record.artifact.version !== version ||
        !archiveValid || !record.files || Object.keys(record.files).length > limits.entries ||
        required.some(relative => !record.files[relative])) return null;
      const identities = []; let expandedBytes = 0;
      for (const [relative, item] of Object.entries(record.files)) {
        if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
          item.bytes > limits.archive || item.bytes > limits.expanded - expandedBytes) return null;
        expandedBytes += item.bytes;
        const itemStat = fs.lstatSync(path.join(root, "files", relative));
        if (!itemStat.isFile() || itemStat.isSymbolicLink() || itemStat.size !== item.bytes) return null;
        identities.push([relative, itemStat.dev, itemStat.ino, itemStat.size, itemStat.mtimeMs, itemStat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verification !== "status" && verified.get(root) !== identity) {
        for (const [relative, item] of Object.entries(record.files)) if (Native.hashFile(path.join(root, "files", relative)) !== item.sha256) return null;
        if (verified.size >= 64) verified.delete(verified.keys().next().value);
        verified.set(root, identity);
      }
      return { ...record, root, installDir: root, filesRoot: path.join(root, "files"), ready: true, removable: true, sectionId: "default" };
    } catch { return null; }
  }
  function listInstalled(userDataDir) {
    try { return fs.readdirSync(directory(userDataDir)).filter(version => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(version))
      .slice(0, LIMITS.versions).map(version => resolve({ userDataDir, version, verification: "status" })).filter(Boolean)
      .sort((a, b) => a.artifact?.kind === "github-commit" && b.artifact?.kind === "github-commit"
        ? String(b.artifact.publishedAt || b.installedAt).localeCompare(String(a.artifact.publishedAt || a.installedAt))
        : compare(a.version, b.version)); } catch { return []; }
  }
  function getState({ userDataDir, settings } = {}) {
    const record = cached(userDataDir), installed = listInstalled(userDataDir), cfg = normalizeSettings(settings);
    const rows = orderedRows(record?.entries || []), versions = rows.map(row => row.version);
    const base = { supportsDefault: true, defaultVersion: cfg.defaultVersion || managerDefaultVersion({ listed: versions, installed: installed.map(row => row.version) }), defaultSource: cfg.defaultVersion ? "saved" : "manager", installed, installing: null, variants: [],
      catalog: { ...(states.get(userDataDir) || { status: record ? "success" : "idle", fetchedAt: record?.fetchedAt || null, error: null }),
        source, sourceUrl: source, versions, installable: versions.length > 0, installableVersions: versions,
        includedVersions: [], buildableVersions: [], supportsLatestOnly: false,
        versionLabels: Object.fromEntries(rows.filter(row => typeof row.versionLabel === "string").map(row => [row.version, row.versionLabel])),
        latestAvailableVersion: versions[0] || null, latestInstalledVersion: installed[0]?.version || null,
        versionRequirements: Object.fromEntries(versions.map(version => [version, { requiresDownload: !installed.some(row => row.version === version),
          requiresBuild: false, available: installed.some(row => row.version === version), installLabel: "Install" }])) } };
    return { ...base, sections: [{ id: "default", label, ...base }] };
  }
  async function pypiCatalog({ signal }, dependencies) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(packageName || "")) throw new Error(`${label} has no package source.`);
    const result = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(`https://pypi.org/pypi/${packageName}/json`, { signal, maxBytes: 8 * 1024 ** 2 });
    if (result.status !== 200) throw new Error(`${label} package lookup failed (HTTP ${result.status}).`);
    const data = JSON.parse(result.body.toString("utf8")), rows = [];
    for (const [version, assets] of Object.entries(data.releases || {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(assets)) continue;
      const filename = packageName.replace(/-/g, "_") + `-${version}-py3-none-any.whl`;
      const matches = assets.filter(asset => asset.filename === filename && !asset.yanked);
      if (matches.length !== 1) continue;
      const asset = matches[0], url = new URL(asset.url);
      const row = { version, url: asset.url, bytes: asset.size, sha256: asset.digests?.sha256,
        sourceUrl: `https://pypi.org/project/${packageName}/${version}/` };
      if (url.hostname === "files.pythonhosted.org" && validRow(row)) rows.push(row);
    }
    return rows;
  }
  async function refreshCatalog(context = {}, dependencies = {}) {
    directory(context.userDataDir);
    if (pending.has(context.userDataDir)) return pending.get(context.userDataDir);
    const previous = cached(context.userDataDir);
    states.set(context.userDataDir, { status: "loading", fetchedAt: previous?.fetchedAt || null, error: null });
    const task = (async () => {
      try {
        const entries = await (dependencies.discoverCatalog || discoverCatalog || pypiCatalog)(context, dependencies);
        if (!Array.isArray(entries) || !entries.length || entries.length > LIMITS.versions || !entries.every(validRow))
          throw new Error(`No valid ${label} downloads were found.`);
        throwIfAborted(context.signal);
        const record = writeRuntimeCatalog({ userDataDir: context.userDataDir, managerId: id, sourceId, source,
          entries: orderedRows(entries) });
        states.set(context.userDataDir, { status: "success", fetchedAt: record.fetchedAt, error: null });
        return getState(context).catalog;
      } catch (error) {
        states.set(context.userDataDir, { status: "error", fetchedAt: previous?.fetchedAt || null, error: String(error.message || error) });
        throw error;
      } finally { pending.delete(context.userDataDir); }
    })();
    pending.set(context.userDataDir, task); return task;
  }
  function extract(archive, destination, artifact) {
    const zip = readZipEntries(archive), prefix = artifact.archivePrefix ? artifact.archivePrefix.replace(/\/?$/, "/") : "";
    if (!zip?.entries?.length || zip.entries.length > limits.entries || zip.entries.length !== zip.info.entries) throw new Error(`${label} archive is invalid.`);
    const files = {}, seen = new Set(); let bytes = 0;
    for (const item of zip.entries) {
      const name = item.name.replace(/\/$/, "");
      if (!safeRelative(name) || seen.has(name) || item.uncompressedSize > limits.archive || (bytes += item.uncompressedSize) > limits.expanded)
        throw new Error(`${label} archive contains an unsafe or oversized file.`);
      seen.add(name);
      if (item.name.endsWith("/") || prefix && !item.name.startsWith(prefix)) continue;
      const relative = item.name.slice(prefix.length);
      if (!safeRelative(relative)) throw new Error(`${label} archive path is invalid.`);
      // Explicit required files can include an upstream production CLI command
      // whose filename matches a test convention, such as a round-trip compiler.
      if (Content.excludedReason(relative) && !required.includes(relative) || relative.split("/").some(part => [".git", "__pycache__"].includes(part))) continue;
      const data = readZipEntryBuffer(archive, item.name);
      if (!data || data.length !== item.uncompressedSize) throw new Error(`${label} archive extraction failed.`);
      const file = path.join(destination, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
      files[relative] = { bytes: data.length, sha256: Native.hashFile(file) };
    }
    if (required.some(relative => !files[relative])) throw new Error(`${label} package is missing its application files.`);
    return files;
  }
  async function installRuntime(context = {}, dependencies = {}) {
    const settings = context.settings?.runtimes?.[id] || context.settings;
    let version = selectRuntimeVersion({ manual: context.version,
      defaultVersion: getState({ userDataDir: context.userDataDir, settings }).defaultVersion }).version;
    const installed = version && resolve({ userDataDir: context.userDataDir, version }); if (installed) return installed;
    return withRuntimeMutation({ managerId: id, sectionId: "default", ...(version ? { version } : {}) }, async () => {
      const existing = version && resolve({ userDataDir: context.userDataDir, version }); if (existing) return existing;
      await confirmToolInstall(context, { managerId: id, label, version, requiresDownload: true, installOptions: { sectionId: "default" } });
      let artifact = cached(context.userDataDir)?.entries.find(row => row.version === version) || pins.find(row => row.version === version);
      if (!artifact) {
        await refreshCatalog(context, dependencies);
        version ||= getState(context).catalog.versions[0];
        artifact = cached(context.userDataDir)?.entries.find(row => row.version === version);
      }
      if (!version) throw new Error(`No ${label} versions are available to download.`);
      if (!validRow(artifact)) throw new Error(`Refresh ${label} versions before installing this version.`);
      version = normalizeVersion(version);
      return runDownloadTask(context.downloads, { managerId: id, sectionId: "default", version, label, kind: "tool",
        dedupeKey: `${id}:${context.userDataDir}:${version}` }, async task => {
        const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal;
        const target = installRoot(context.userDataDir, version); assertOwnDirectory(context.userDataDir, directory(context.userDataDir));
        const temporary = fs.mkdtempSync(path.join(directory(context.userDataDir), ".install-")); let backup;
        try {
          const archive = path.join(temporary, "package.zip"), filesRoot = path.join(temporary, "files"); fs.mkdirSync(filesRoot);
          if (artifact.kind === "github-commit") {
            const response = await (dependencies.fetchUrlBuffer || fetchUrlBuffer)(artifact.url, { signal, maxBytes: limits.archive });
            throwIfAborted(signal);
            if (response.status !== 200 || !Buffer.isBuffer(response.body) || !response.body.length || response.body.length > limits.archive)
              throw new Error(`${label} source download is invalid or exceeds its size limit.`);
            fs.writeFileSync(archive, response.body);
          } else await (dependencies.downloadToFile || downloadToFile)(artifact.url, archive, { signal, onProgress: task.onProgress });
          throwIfAborted(signal);
          const archiveBytes = fs.statSync(archive).size, archiveSha256 = Native.hashFile(archive);
          if (artifact.kind !== "github-commit" && (archiveBytes !== artifact.bytes || archiveSha256 !== artifact.sha256))
            throw new Error(`${label} download checksum does not match the selected version.`);
          const files = extract(archive, filesRoot, artifact), record = { id, version, artifact, archiveSha256,
            ...(artifact.kind === "github-commit" ? { archiveBytes } : {}),
            installedAt: new Date().toISOString(), files };
          const metadata = JSON.stringify(record, null, 2);
          if (Buffer.byteLength(metadata) > manifestBytes) throw new Error(`${label} file inventory exceeds its metadata size limit.`);
          fs.writeFileSync(path.join(temporary, "tool.json"), metadata); fs.rmSync(archive);
          throwIfAborted(signal);
          if (fs.existsSync(target)) { backup = target + ".previous-" + Date.now(); fs.renameSync(target, backup); }
          fs.renameSync(temporary, target);
          const result = resolve({ userDataDir: context.userDataDir, version });
          if (!result) throw new Error(`Installed ${label} failed its integrity check.`);
          if (backup) fs.rmSync(backup, { recursive: true, force: true });
          context.onRuntimeStateChange?.(); return result;
        } catch (error) {
          if (backup) { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
          throw error;
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      });
    }, { userDataDir: context.userDataDir });
  }
  async function ensureTool(context, payload = {}, dependencies = {}) {
    return installRuntime({ ...context, version: payload?.version || manager.normalizeSettings(context.settings?.runtimes?.[id]).defaultVersion }, dependencies);
  }
  async function run(context, args, options = {}, dependencies = {}) {
    const installed = options.installed || await ensureTool(context, options, dependencies);
    const python = Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
    if (!python) throw new Error("The launcher's included Python is unavailable.");
    const bootstrap = scriptName
      ? "import sys,runpy;root=sys.argv.pop(1);sys.path.insert(0,root);runpy.run_path(root+'/'+sys.argv.pop(1),run_name='__main__')"
      : "import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module(sys.argv.pop(1),run_name='__main__',alter_sys=True)";
    return withRuntimeUse([{ managerId: id, sectionId: "default", version: installed.version, sourcePath: installed.root }], async use => {
      if (!resolve({ userDataDir: context.userDataDir, version: installed.version })) throw new Error(`${label} files changed before execution.`);
      await (dependencies.runToolCommand || runToolCommand)(python, ["-I", "-B", "-c", bootstrap, installed.filesRoot, scriptName || moduleName, ...args],
        { ...options, env: options.env || { ...process.env }, signal: context.signal,
          onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]) });
      return installed;
    }, { userDataDir: context.userDataDir });
  }
  const manager = { id, label, delivery: { included: "none", catalog: "remote", sourceBuild: false }, distributionRequired: false,
    ui: { groupId: "tools", tabLabel: "Tools", sectionLabel: label, order: 200, memberOrder: order, management: "managed" },
    normalizeSettings, getState, refreshCatalog, installRuntime, ensureTool, run, resolve,
    uninstallRuntime: ({ userDataDir, version, installDir }) => {
      const target = installRoot(userDataDir, version);
      if (installDir && path.resolve(installDir) !== target) throw new Error(`The selected directory does not belong to ${label}.`);
      return withRuntimeMutation({ managerId: id, sectionId: "default", version, sourcePath: target },
        () => { assertOwnDirectory(directory(userDataDir), target, { create: false }); fs.rmSync(target, { recursive: true, force: true }); return true; }, { userDataDir });
    },
    applySettingsUpdate: (action, payload, settings) => action === "setDefault" ? normalizeSettings({ defaultVersion: payload?.version }) : normalizeSettings(settings),
    updateSettingsAfterInstall: (settings, installed) => normalizeSettings(settings).defaultVersion ? settings : { ...settings, defaultVersion: installed.version },
    updateSettingsAfterUninstall: (settings, _payload, { userDataDir }) => listInstalled(userDataDir).some(row => row.version === settings?.defaultVersion)
      ? settings : { ...settings, defaultVersion: listInstalled(userDataDir)[0]?.version || null },
    core: { normalizeVersion, getInstallDir: ({ userDataDir, version }) => installRoot(userDataDir, version), listInstalled, resolveInstalled: resolve,
      ensure: ensureTool, run, resolve, installRoot },
    __test: { validRow, extract } };
  Custom.configure(manager, { defaultsPath: () => ["defaultVersion"], providers: [{ core: manager.core,
    lists: { listInstalled: "default" }, resolves: { resolve: "default", resolveInstalled: "default" },
    versions: ["normalizeVersion"], directories: ["installRoot", "getInstallDir"] }], inspect(runtimePath) {
    const selectedDirectory = fs.statSync(runtimePath).isDirectory();
    let root = selectedDirectory ? runtimePath : path.dirname(runtimePath);
    if (!selectedDirectory && scriptName) {
      const selectedPath = path.resolve(runtimePath);
      let sourceRoot = selectedPath;
      for (const _part of scriptName.split("/")) sourceRoot = path.dirname(sourceRoot);
      if (path.join(sourceRoot, scriptName) === selectedPath) root = sourceRoot;
    }
    if (fs.existsSync(path.join(root, "tool.json")) && fs.existsSync(path.join(root, "files"))) root = path.join(root, "files");
    for (const relative of required) {
      const file = path.join(root, relative), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > limits.archive) throw new Error(`Select the complete ${label} tool directory, including ${relative}.`);
    }
    const executablePath = path.join(root, scriptName || moduleName.replace(/\./g, "/") + "/__main__.py");
    return { root, installDir: root, filesRoot: root, executablePath, ready: true };
  } });
  Custom.instrumentManagers([manager]);
  resolve = manager.core.resolve; listInstalled = manager.core.listInstalled; normalizeVersion = manager.core.normalizeVersion; installRoot = manager.core.installRoot;
  manager.resolve = resolve;
  installRuntime = manager.installRuntime;
  return manager;
}

module.exports = { createManagedPythonTool };
