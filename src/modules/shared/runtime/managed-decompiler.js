const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("./local-native");
const GameData = require("../game-data");
const Catalog = require("./ilspy-catalog");
const ToolHost = require("./dotnet-tool-host");
const { readZipEntries, readZipEntryBuffer } = require("./zip");
const { downloadToFile, throwIfAborted } = require("./download-utils");
const { runDownloadTask } = require("./download-manager");
const { confirmToolInstall } = require("./tool-install");
const { withRuntimeMutation, withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { runToolCommand } = require("./tool-command");
const { inspectManagedAssembly } = require("./managed-assembly");
const Manager = require("../../fna/runtime/manager");
const Build = require("../../fna/runtime/build");

// The default reuses FNA's exact .NET 8 host; newer tools have independent hosts.
const TOOLS = Catalog.PINS, DEFAULT_VERSION = "9.1.0.7988";
const REQUIRED = ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"];
const SAFE_RELATIVE = value => typeof value === "string" && value && !value.includes("\\") && !/[\x00-\x1f]/.test(value) &&
  !path.posix.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== "..");
const verified = new Map();
function pinFor(version = DEFAULT_VERSION, userDataDir) { return Catalog.pinFor(version, userDataDir); }
function selectedVersion(context, payload = {}) {
  return pinFor(payload.version || context.settings?.runtimes?.ilspy?.defaultVersion || DEFAULT_VERSION, context.userDataDir).version;
}
function installRoot(userDataDir, version) {
  if (!path.isAbsolute(userDataDir || "") || userDataDir.includes("\0")) throw new Error("ILSpy requires the launcher's data directory.");
  return path.join(userDataDir, "runtimes", "fna-tools", "ilspy", Catalog.normalizeVersion(version));
}
function inventory(root) {
  const files = {}; let bytes = 0;
  function walk(directory, relative = "", depth = 0) {
    if (depth > 8) throw new Error("ILSpy package nesting exceeds its limit.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? relative + "/" + item.name : item.name, file = path.join(directory, item.name);
      if (!SAFE_RELATIVE(name) || item.isSymbolicLink()) throw new Error("ILSpy package contains an unsafe path.");
      if (item.isDirectory()) walk(file, name, depth + 1);
      else if (item.isFile()) {
        const size = fs.statSync(file).size;
        if (Object.keys(files).length >= 500 || size > 32 * 1024 * 1024 || (bytes += size) > 64 * 1024 * 1024)
          throw new Error("ILSpy package exceeds its inventory limit.");
        files[name] = Native.hashFile(file);
      }
    }
  }
  walk(root); return files;
}
function resolveTool({ userDataDir, version = DEFAULT_VERSION, verification = "full" }) {
  const pin = pinFor(version, userDataDir), root = installRoot(userDataDir, pin.version);
  try {
    const file = path.join(root, "tool.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const minimumRuntime = record.minimumRuntime || (pin.version === DEFAULT_VERSION ? Build.DOTNET_VERSION : pin.minimumRuntime || pin.framework.slice(3) + ".0");
    if (record.version !== pin.version || (pin.sha256 && record.archiveSha256 !== pin.sha256) ||
      (pin.sha512 && record.archiveSha512 !== pin.sha512) || record.sourceRevision !== pin.sourceRevision ||
      (record.framework && record.framework !== pin.framework) || !ToolHost.matchingVersion(pin.framework, minimumRuntime) ||
      !record.files || Object.keys(record.files).length > 500 || REQUIRED.some(name => !record.files[name])) return null;
    const identities = [];
    for (const [relative, checksum] of Object.entries(record.files)) {
      if (!SAFE_RELATIVE(relative) || !/^[a-f0-9]{64}$/.test(checksum)) return null;
      const item = fs.lstatSync(path.join(root, "files", relative));
      if (!item.isFile() || item.isSymbolicLink() || (record.fileSizes && item.size !== record.fileSizes[relative])) return null;
      identities.push([relative, item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs]);
    }
    const identity = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
    if (verification !== "status" && verified.get(root) !== identity) {
      for (const [relative, checksum] of Object.entries(record.files))
        if (Native.hashFile(path.join(root, "files", relative)) !== checksum) return null;
      if (verified.size >= 64) verified.delete(verified.keys().next().value);
      verified.set(root, identity);
    }
    return { ...record, framework: pin.framework, minimumRuntime,
      root, entryPath: path.join(root, "files", "ilspycmd.dll") };
  } catch { return null; }
}
function extractPackage(archive, destination, pin) {
  const entries = readZipEntries(archive)?.entries, prefix = "tools/" + pin.framework + "/any/";
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error("ILSpy package inventory is invalid.");
  const names = new Set(); let bytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if (!SAFE_RELATIVE(entry.name) || names.has(entry.name) || entry.uncompressedSize > 32 * 1024 * 1024 ||
      (bytes += entry.uncompressedSize) > 64 * 1024 * 1024) throw new Error("ILSpy package exceeds its extraction bounds.");
    names.add(entry.name);
    if (!entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    if (!SAFE_RELATIVE(relative)) throw new Error("ILSpy package contains an unsafe tool path.");
    const data = readZipEntryBuffer(archive, entry.name);
    if (!data || data.length !== entry.uncompressedSize) throw new Error("ILSpy package extraction failed.");
    const file = path.join(destination, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
  }
  const tool = inspectManagedAssembly(path.join(destination, "ilspycmd.dll"));
  const engine = inspectManagedAssembly(path.join(destination, "ICSharpCode.Decompiler.dll"));
  const assemblyVersion = pin.version.split("-")[0], frameworkVersion = pin.framework.slice(3);
  if (tool.assemblyName !== "ilspycmd" || tool.assemblyVersion !== assemblyVersion ||
    tool.targetFramework !== ".NETCoreApp,Version=v" + frameworkVersion ||
    engine.assemblyName !== "ICSharpCode.Decompiler" || engine.assemblyVersion !== assemblyVersion)
    throw new Error("ILSpy package versions do not match the selected tool.");
  const configPath = path.join(destination, "ilspycmd.runtimeconfig.json"), config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const options = config.runtimeOptions;
  if (options?.tfm !== pin.framework || options.framework?.name !== "Microsoft.NETCore.App" ||
    !/^\d+\.\d+\.\d+$/.test(options.framework.version || "") ||
    options.framework.version.split(".").slice(0, 2).join(".") !== frameworkVersion)
    throw new Error("ILSpy package requires a different .NET framework.");
  if (pin.version === DEFAULT_VERSION) {
    options.framework.version = Build.DOTNET_VERSION; options.rollForward = "Disable";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  return { framework: pin.framework, minimumRuntime: options.framework.version };
}
function supportedPin(pin) {
  if (pin.installReason) throw new Error(pin.installReason);
  if (!ToolHost.supported(pin.framework)) throw new Error("This ILSpy version requires an unsupported .NET tool host.");
}
async function ensureTool(context, version = DEFAULT_VERSION, dependencies = {}) {
  const pin = pinFor(version, context.userDataDir); supportedPin(pin);
  const existing = resolveTool({ userDataDir: context.userDataDir, version: pin.version });
  if (existing) return existing;
  return withRuntimeMutation({ managerId: "ilspy", sectionId: "decompiler", version: pin.version },
    () => installTool(context, pin, dependencies), { userDataDir: context.userDataDir });
}
async function installTool(context, pin, dependencies) {
  const { version } = pin;
  throwIfAborted(context.signal);
  const completed = resolveTool({ userDataDir: context.userDataDir, version }); if (completed) return completed;
  await confirmToolInstall(context, { managerId: "ilspy", label: "ILSpy", version, requiresDownload: true,
    installOptions: { sectionId: "decompiler" }, detail: "Required for C# decompilation." });
  return runDownloadTask(context.downloads, { label: "ILSpy", managerId: "ilspy", sectionId: "decompiler", version,
    kind: "tool", dedupeKey: "ilspy:" + context.userDataDir + ":" + version }, async task => {
    const signal = task.signal || context.signal, target = installRoot(context.userDataDir, version), parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true }); const temporary = fs.mkdtempSync(path.join(parent, ".ilspy-"));
    try {
      const archive = path.join(temporary, "ilspy.nupkg"), files = path.join(temporary, "files"); fs.mkdirSync(files);
      await (dependencies.downloadToFile || downloadToFile)(pin.url, archive, { signal, onProgress: task.onProgress });
      throwIfAborted(signal);
      if (fs.statSync(archive).size > Catalog.LIMITS.packageBytes || (pin.bytes && fs.statSync(archive).size !== pin.bytes))
        throw new Error("ILSpy package checksum does not match the selected version.");
      const archiveSha256 = Native.hashFile(archive), archiveSha512 = pin.sha512
        ? crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("hex") : null;
      if ((pin.sha256 && archiveSha256 !== pin.sha256) || (pin.sha512 && archiveSha512 !== pin.sha512))
        throw new Error("ILSpy package checksum does not match the selected version.");
      const requirement = (dependencies.extractPackage || extractPackage)(archive, files, pin) ||
        { framework: pin.framework, minimumRuntime: version === DEFAULT_VERSION ? Build.DOTNET_VERSION : pin.minimumRuntime || pin.framework.slice(3) + ".0" };
      const records = inventory(files);
      if (REQUIRED.some(name => !records[name])) throw new Error("ILSpy package is incomplete.");
      fs.writeFileSync(path.join(temporary, "tool.json"), JSON.stringify({ version, archiveSha256, ...(archiveSha512 ? { archiveSha512 } : {}),
        sourceRevision: pin.sourceRevision, sourceUrl: pin.sourceUrl, catalogEntry: pin, ...requirement,
        installedAt: new Date().toISOString(), files: records,
        fileSizes: Object.fromEntries(Object.keys(records).map(name => [name, fs.statSync(path.join(files, name)).size])) }, null, 2));
      fs.rmSync(archive); throwIfAborted(signal);
      if (fs.existsSync(target)) fs.renameSync(target, target + ".previous-" + Date.now());
      fs.renameSync(temporary, target);
      const installed = resolveTool({ userDataDir: context.userDataDir, version });
      if (!installed) throw new Error("Installed ILSpy failed its integrity check.");
      context.onRuntimeStateChange?.(); return installed;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}
function resolveHost(context, requirement, verification = "full") {
  if (requirement.framework === "net8.0" && require("./bundled-native").versionAtLeast(Build.DOTNET_VERSION, requirement.minimumRuntime)) {
    let selected;
    if (verification === "status") {
      const install = Manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.fna })
        .installed.find(item => item.version === Build.PROFILE && item.ready === true);
      // The manager's display cache validates cold/changed profiles; execution
      // still uses strict selection without repeating payload work for each row.
      selected = { version: Build.PROFILE, install, ready: Boolean(install),
        ...(install ? { profile: { root: path.dirname(install.executablePath), dotnetVersion: Build.DOTNET_VERSION,
          minimumMacOS: install.minimumMacOS } } : {}) };
    } else selected = Manager.resolveSelection({ runtimeData: { fna: { version: Build.PROFILE } } }, context.settings, context.userDataDir);
    if (selected.ready) return { ...selected, runtimeIdentity: { managerId: "fna", version: selected.version,
      ...(selected.install.installDir || selected.profile.root ? { sourcePath: selected.install.installDir || selected.profile.root } : {}) } };
  }
  return ToolHost.resolve({ userDataDir: context.userDataDir, framework: requirement.framework,
    minimumVersion: requirement.minimumRuntime, verification });
}
async function ensureHost(context, tool = { framework: "net8.0", minimumRuntime: Build.DOTNET_VERSION }, dependencies = {}) {
  const selected = resolveHost(context, tool); if (selected) return selected;
  return ToolHost.ensure(context, { framework: tool.framework, minimumVersion: tool.minimumRuntime }, dependencies);
}
function hostFileIdentity(host) {
  const files = Object.keys(host.record?.files || host.profile.files || {});
  if (files.length > 2000 || files.some(name => !SAFE_RELATIVE(name))) throw new Error("The .NET tool host inventory is invalid.");
  return JSON.stringify([host.install.executablePath, ...files.map(name => path.join(host.profile.root, name))].map(file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The .NET tool host changed before decompilation.");
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs];
  }));
}
async function decompileAssembly({ entry, payload = {}, context, moduleId, assemblyPath, gameVersion }, dependencies = {}) {
  const version = selectedVersion(context, payload), pin = pinFor(version, context.userDataDir); supportedPin(pin);
  if (!/^[a-z0-9-]+$/.test(moduleId || "") || !path.isAbsolute(assemblyPath || "") || assemblyPath.includes("\0")) throw new Error("Choose a valid managed assembly and module.");
  const info = inspectManagedAssembly(assemblyPath);
  if (!info.assemblyName) throw new Error("No managed assembly identity was found.");
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("Decompilation requires a persisted game id.");
  const tool = await (dependencies.ensureTool || ensureTool)(context, version);
  const host = await (dependencies.ensureHost || ensureHost)(context, tool);
  const hostIdentityBefore = dependencies.ensureHost ? null : hostFileIdentity(host);
  const toolIdentity = { managerId: "ilspy", sectionId: "decompiler", version,
    ...(path.isAbsolute(tool.root || "") ? { sourcePath: tool.root } : {}) };
  const hostIdentity = host.runtimeIdentity || { managerId: "fna", version: Build.PROFILE };
  return withRuntimeUse([toolIdentity, hostIdentity], async use => {
    throwIfAborted(context.signal);
    if (!dependencies.ensureTool && !resolveTool({ userDataDir: context.userDataDir, version })) throw new Error("ILSpy changed before decompilation. Try again.");
    if (!dependencies.ensureHost && hostFileIdentity(host) !== hostIdentityBefore) throw new Error("The .NET tool host changed before decompilation. Try again.");
    const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "decompiled"); fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, ".decompile-")), outputRoot = path.join(parent, version), logPath = path.join(temporary, "decompile.log");
    try {
      fs.writeFileSync(logPath, "ILSpy " + version + "\n");
      const args = ["exec", ...(tool.minimumRuntime && tool.minimumRuntime !== host.profile.dotnetVersion
        ? ["--fx-version", host.profile.dotnetVersion] : []), tool.entryPath,
        "--disable-updatecheck", "--project", "--outputdir", temporary, "--referencepath", path.dirname(assemblyPath), assemblyPath];
      await (dependencies.runCommand || runToolCommand)(host.install.executablePath, args,
        { cwd: temporary, logPath, signal: context.signal, timeout: 300000,
          onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]),
          env: { ...process.env, DOTNET_ROOT: host.profile.root, DOTNET_ROOT_ARM64: host.profile.root, DOTNET_MULTILEVEL_LOOKUP: "0" } });
      throwIfAborted(context.signal);
      const result = { outputRoot, toolVersion: version, toolSourceRevision: tool.sourceRevision,
        toolArchiveSha256: tool.archiveSha256, ...(tool.archiveSha512 ? { toolArchiveSha512: tool.archiveSha512 } : {}),
        assemblyPath, assemblySha256: Native.hashFile(assemblyPath), gameVersion: gameVersion || info.assemblyVersion,
        dotnetVersion: host.profile.dotnetVersion, toolFramework: tool.framework, createdAt: new Date().toISOString() };
      fs.writeFileSync(path.join(temporary, "decompile.json"), JSON.stringify(result, null, 2));
      if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, outputRoot + ".previous-" + Date.now());
      fs.renameSync(temporary, outputRoot);
      entry.moduleData = { ...entry.moduleData, decompiledRoot: outputRoot, decompilerVersion: version };
      context.onEntryChange?.({ moduleData: entry.moduleData }); return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
}
function revealSource({ entry, context, moduleId }) {
  if (!/^[a-z0-9-]+$/.test(moduleId || "")) throw new Error("Invalid managed source module.");
  const root = entry.moduleData?.decompiledRoot;
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "decompiled");
  if (!root || !path.resolve(root).startsWith(parent + path.sep) || !fs.existsSync(path.join(root, "decompile.json"))) throw new Error("Decompile this game first.");
  context.ui?.shell?.showItemInFolder?.(root); return { outputRoot: root };
}
module.exports = { TOOLS, DEFAULT_VERSION, selectedVersion, installRoot, resolveTool, ensureTool, resolveHost, ensureHost,
  decompileAssembly, revealSource, __test: { pinFor, extractPackage, inventory, supportedPin } };
