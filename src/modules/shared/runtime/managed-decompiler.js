const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("./local-native");
const Custom = require("./custom-runtime");
const { selectRuntimeVersion } = require("./version-choices");
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

const TOOLS = Catalog.PINS;
const REQUIRED = ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll"];
const SAFE_RELATIVE = value => typeof value === "string" && value && !value.includes("\\") && !/[\x00-\x1f]/.test(value) &&
  !path.posix.isAbsolute(value) && value.split("/").every(part => part && part !== "." && part !== "..");
const verified = new Map();
function pinFor(version, userDataDir) { return Catalog.pinFor(version, userDataDir); }
function listInstalled(userDataDir, verification = "full") {
  if (!path.isAbsolute(userDataDir || "")) return [];
  const parent = path.join(userDataDir, "runtimes", "fna-tools", "ilspy");
  let names; try { names = fs.readdirSync(parent); } catch { return []; }
  return names.filter(name => Catalog.VERSION.test(name)).slice(0, Catalog.LIMITS.versions)
    .map(version => resolveTool({ userDataDir, version, verification })).filter(Boolean);
}
function selectedVersion(context, payload = {}) {
  const requested = selectRuntimeVersion({ manual: payload.version,
    defaultVersion: require("./ilspy-manager").getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.ilspy }).defaultVersion }).version;
  return requested ? Custom.isPath(requested) ? requested : Catalog.normalizeVersion(requested) : null;
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
function resolveTool({ userDataDir, version, verification = "full" }) {
  try {
    if (!version) return null;
    const pin = pinFor(version, userDataDir), root = installRoot(userDataDir, pin.version);
    const file = path.join(root, "tool.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const minimumRuntime = record.minimumRuntime || pin.minimumRuntime || pin.framework.slice(3) + ".0";
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
  return { framework: pin.framework, minimumRuntime: options.framework.version };
}
function supportedPin(pin) {
  if (pin.installReason) throw new Error(pin.installReason);
  if (!ToolHost.supported(pin.framework)) throw new Error("This ILSpy version requires an unsupported .NET tool host.");
}
async function ensureTool(context, version, dependencies = {}) {
  const requested = [version, Custom.defaultVersion(context.settings, "ilspy", "decompiler")]
    .find(value => typeof value === "string" && value.trim() && value.trim() !== "auto") || null;
  let selected = selectedVersion(context, { version: requested });
  let pin;
  try { if (selected) pin = pinFor(selected, context.userDataDir); } catch {}
  if (pin) supportedPin(pin);
  const existing = selected && resolveTool({ userDataDir: context.userDataDir, version: selected });
  if (existing) return existing;
  return withRuntimeMutation({ managerId: "ilspy", sectionId: "decompiler", ...(selected ? { version: selected } : {}) }, async () => {
    const completed = selected && resolveTool({ userDataDir: context.userDataDir, version: selected });
    if (completed) return completed;
    await confirmToolInstall(context, { managerId: "ilspy", label: "ILSpy", version: selected, requiresDownload: true,
      installOptions: { sectionId: "decompiler" }, detail: "Required for C# decompilation." });
    if (!pin) {
      await require("./ilspy-manager").refreshCatalog({ ...context, force: true }, dependencies.catalog || {});
      selected = selectedVersion(context, { version: requested });
      if (!selected) throw new Error("No ILSpy versions are available to download.");
      pin = pinFor(selected, context.userDataDir);
    }
    supportedPin(pin);
    const reason = require("./ilspy-manager").getState({ userDataDir: context.userDataDir }).catalog.versionRequirements[pin.version]?.installReason;
    if (reason) throw new Error(reason);
    return installTool(context, pin, dependencies);
  }, { userDataDir: context.userDataDir });
}
async function installTool(context, pin, dependencies) {
  const { version } = pin;
  throwIfAborted(context.signal);
  const completed = resolveTool({ userDataDir: context.userDataDir, version }); if (completed) return completed;
  return runDownloadTask(context.downloads, { label: "ILSpy", managerId: "ilspy", sectionId: "decompiler", version,
    kind: "tool", dedupeKey: "ilspy:" + context.userDataDir + ":" + version }, async task => {
    const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal, target = installRoot(context.userDataDir, version), parent = path.dirname(target);
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
        { framework: pin.framework, minimumRuntime: pin.minimumRuntime || pin.framework.slice(3) + ".0" };
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
  const rows = Manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.fna }).installed
    .filter(install => install.ready === true);
  const matching = [];
  for (const install of rows) {
    try {
      const root = path.dirname(install.executablePath);
      const profile = JSON.parse(fs.readFileSync(path.join(root, "fna-runtime.json"), "utf8"));
      if (!ToolHost.matchingVersion(requirement.framework, profile.dotnetVersion) ||
          !require("./bundled-native").versionAtLeast(profile.dotnetVersion, requirement.minimumRuntime)) continue;
      const selected = verification === "status" ? { version: install.version, install, ready: true,
        profile: { ...profile, root, minimumMacOS: install.minimumMacOS } }
        : Manager.resolveSelection({ runtimeData: { fna: { version: install.version } } }, context.settings, context.userDataDir);
      if (selected.ready) matching.push({ ...selected, runtimeIdentity: { managerId: "fna", version: selected.version,
        sourcePath: selected.install.installDir || selected.profile.root } });
    } catch {}
  }
  const selectedVersion = Manager.normalizeSettings(context.settings?.runtimes?.fna).defaultVersion;
  const selected = matching.find(host => host.version === selectedVersion) || matching[0];
  if (selected) return selected;
  return ToolHost.resolve({ userDataDir: context.userDataDir, framework: requirement.framework,
    minimumVersion: requirement.minimumRuntime, verification });
}
async function ensureHost(context, tool, dependencies = {}) {
  if (!tool?.framework || !tool.minimumRuntime) throw new Error("The selected tool must identify its .NET requirement.");
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
async function decompileAssembly({ entry, payload = {}, context, moduleId, assemblyPath, assemblyPaths, gameVersion }, dependencies = {}) {
  let version = selectedVersion(context, payload), pin;
  if (Custom.isPath(version)) pin = module.exports.resolveTool({ userDataDir: context.userDataDir, version });
  else if (version) { try { pin = pinFor(version, context.userDataDir); } catch {} }
  if (Custom.isPath(version) && !pin) throw new Error("The selected custom ILSpy tool is unavailable. Check its path in Runtimes.");
  if (pin) supportedPin(pin);
  if (!/^[a-z0-9-]+$/.test(moduleId || "") || !path.isAbsolute(assemblyPath || "") || assemblyPath.includes("\0")) throw new Error("Choose a valid managed assembly and module.");
  const info = inspectManagedAssembly(assemblyPath);
  const assemblies = assemblyPaths || [assemblyPath];
  if (!Array.isArray(assemblies) || !assemblies.length || assemblies.length > 500 ||
    new Set(assemblies.map(file => path.basename(file))).size !== assemblies.length ||
    assemblies.some(file => !path.isAbsolute(file) || path.dirname(file) !== path.dirname(assemblyPath)))
    throw new Error("Choose managed assemblies from one game directory.");
  if (!info.assemblyName) throw new Error("No managed assembly identity was found.");
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("Decompilation requires a persisted game id.");
  const tool = await (dependencies.ensureTool || module.exports.ensureTool)(context, version);
  version = tool.version;
  if (!version) throw new Error("The installed ILSpy tool did not identify its version.");
  const host = await (dependencies.ensureHost || ensureHost)(context, tool);
  const hostIdentityBefore = dependencies.ensureHost ? null : hostFileIdentity(host);
  const toolIdentity = { managerId: "ilspy", sectionId: "decompiler", version,
    ...(path.isAbsolute(tool.root || "") ? { sourcePath: tool.root } : {}) };
  const hostIdentity = host.runtimeIdentity || { managerId: "dotnet-tool-host", version: host.profile.dotnetVersion };
  return withRuntimeUse([toolIdentity, hostIdentity], async use => {
    throwIfAborted(context.signal);
    if (!dependencies.ensureTool && !module.exports.resolveTool({ userDataDir: context.userDataDir, version })) throw new Error("ILSpy changed before decompilation. Try again.");
    if (!dependencies.ensureHost && hostFileIdentity(host) !== hostIdentityBefore) throw new Error("The .NET tool host changed before decompilation. Try again.");
    const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "decompiled"); fs.mkdirSync(parent, { recursive: true });
    const outputKey = Custom.storageKey(version);
    const temporary = fs.mkdtempSync(path.join(parent, ".decompile-")), outputRoot = path.join(parent, outputKey), logPath = path.join(temporary, "decompile.log");
    const assemblyErrors = [];
    try {
      fs.writeFileSync(logPath, "ILSpy " + version + "\n");
      for (const file of assemblies) {
        const destination = assemblyPaths ? path.join(temporary, path.basename(file, ".dll")) : temporary;
        fs.mkdirSync(destination, { recursive: true });
        const args = ["exec", ...(tool.minimumRuntime && tool.minimumRuntime !== host.profile.dotnetVersion
          ? ["--fx-version", host.profile.dotnetVersion] : []), tool.entryPath,
          "--disable-updatecheck", "--project", "--outputdir", destination, "--referencepath", path.dirname(file), file];
        try { await (dependencies.runCommand || runToolCommand)(host.install.executablePath, args,
          { cwd: temporary, logPath, signal: context.signal, timeout: 300000,
            onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]),
            env: { ...process.env, DOTNET_ROOT: host.profile.root, DOTNET_ROOT_ARM64: host.profile.root, DOTNET_MULTILEVEL_LOOKUP: "0" } });
        } catch (error) {
          if (!assemblyPaths || !Number.isInteger(error.exitCode) || error.exitCode === 0 || context.signal?.aborted) throw error;
          assemblyErrors.push({ assembly: path.basename(file), exitCode: error.exitCode });
        }
      }
      throwIfAborted(context.signal);
      const result = { outputRoot, toolVersion: version, toolSourceRevision: tool.sourceRevision,
        toolArchiveSha256: tool.archiveSha256, ...(tool.archiveSha512 ? { toolArchiveSha512: tool.archiveSha512 } : {}),
        assemblyPath, assemblySha256: Native.hashFile(assemblyPath), gameVersion: gameVersion || info.assemblyVersion,
        ...(assemblyPaths ? { assemblies: assemblies.map(file => ({ path: file, sha256: Native.hashFile(file) })), assemblyErrors,
          ...(assemblyErrors.length ? { exportWarning: `Incomplete C# export for ${assemblyErrors.length} of ${assemblies.length} assemblies. See decompile.log; recovered DLLs remain available.` } : {}) } : {}),
        dotnetVersion: host.profile.dotnetVersion, toolFramework: tool.framework, createdAt: new Date().toISOString() };
      fs.writeFileSync(path.join(temporary, "decompile.json"), JSON.stringify(result, null, 2));
      if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, outputRoot + ".previous-" + Date.now());
      fs.renameSync(temporary, outputRoot);
      entry.moduleData = { ...entry.moduleData, decompiledRoot: outputRoot, decompilerVersion: version };
      context.onEntryChange?.({ moduleData: entry.moduleData }); return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }, { userDataDir: context.userDataDir });
}
function inspectCustomTool(runtimePath, { verification = "full" } = {}) {
  let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  if (root.toLowerCase().endsWith(".app")) root = path.join(root, "Contents", "MacOS");
  if (fs.existsSync(path.join(root, "files", "ilspycmd.dll"))) root = path.join(root, "files");
  for (const name of REQUIRED) {
    const stat = fs.statSync(path.join(root, name));
    if (!stat.isFile() || stat.size === 0 || stat.size > 32 * 1024 * 1024) throw new Error(`The ILSpy runtime requires ${name}.`);
  }
  const entryPath = path.join(root, "ilspycmd.dll"), tool = inspectManagedAssembly(entryPath);
  const engine = inspectManagedAssembly(path.join(root, "ICSharpCode.Decompiler.dll"));
  const configPath = path.join(root, "ilspycmd.runtimeconfig.json");
  if (fs.statSync(configPath).size > 256 * 1024) throw new Error("ILSpy runtime configuration exceeds its limit.");
  const options = JSON.parse(fs.readFileSync(configPath, "utf8")).runtimeOptions;
  if (tool.assemblyName !== "ilspycmd" || engine.assemblyName !== "ICSharpCode.Decompiler" ||
    tool.assemblyVersion !== engine.assemblyVersion || !ToolHost.supported(options?.tfm) ||
    options.framework?.name !== "Microsoft.NETCore.App" || !/^\d+\.\d+\.\d+$/.test(options.framework?.version || "") ||
    !ToolHost.matchingVersion(options.tfm, options.framework.version) ||
    tool.targetFramework !== ".NETCoreApp,Version=v" + options.tfm.replace(/^net/, ""))
    throw new Error("The selected ILSpy runtime has incompatible assemblies or .NET configuration.");
  const depsPath = path.join(root, "ilspycmd.deps.json");
  if (fs.statSync(depsPath).size > 2 * 1024 * 1024) throw new Error("ILSpy dependency metadata exceeds its limit.");
  const deps = JSON.parse(fs.readFileSync(depsPath, "utf8"));
  if (!deps.runtimeTarget?.name || !deps.targets?.[deps.runtimeTarget.name] || !deps.libraries ||
    !Object.keys(deps.libraries).some(name => name.startsWith("ICSharpCode.Decompiler/")))
    throw new Error("The selected ILSpy runtime has incomplete dependency metadata.");
  const target = deps.targets[deps.runtimeTarget.name], libraries = Object.entries(target);
  if (libraries.length > 500) throw new Error("ILSpy dependency metadata exceeds its limit.");
  let assets = 0;
  for (const [library, entry] of libraries) {
    if (deps.libraries[library]?.type === "reference" && library.startsWith("Microsoft.NETCore.App/")) continue;
    for (const [kind, values] of Object.entries(entry)) {
      if (!["runtime", "native", "runtimeTargets"].includes(kind)) continue;
      for (const [relative, description] of Object.entries(values || {})) {
        if (++assets > 2000 || !SAFE_RELATIVE(relative)) throw new Error("ILSpy dependency metadata contains an invalid asset path.");
        if (path.basename(relative) === "_._") continue;
        if (kind === "runtimeTargets" && description.rid && !["any", "unix", "osx", "unix-" + process.arch,
          "osx-" + (process.arch === "x64" ? "x64" : "arm64")].includes(description.rid)) continue;
        const candidates = [path.join(root, relative), path.join(root, path.basename(relative))];
        if (!candidates.some(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }))
          throw new Error(`The ILSpy runtime is missing dependency ${relative}.`);
      }
    }
  }
  const files = verification === "full" ? inventory(root) : undefined;
  return { ready: true, root, installDir: root, entryPath, executablePath: entryPath,
    runtimeVersion: tool.assemblyVersion, sourceRevision: "custom", framework: options.tfm,
    minimumRuntime: options.framework.version, files };
}
function revealSource({ entry, context, moduleId }) {
  if (!/^[a-z0-9-]+$/.test(moduleId || "")) throw new Error("Invalid managed source module.");
  const root = entry.moduleData?.decompiledRoot;
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId), "decompiled");
  if (!root || !path.resolve(root).startsWith(parent + path.sep) || !fs.existsSync(path.join(root, "decompile.json"))) throw new Error("Decompile this game first.");
  context.ui?.shell?.showItemInFolder?.(root); return { outputRoot: root };
}
module.exports = { TOOLS, selectedVersion, installRoot, resolveTool, listInstalled, ensureTool, resolveHost, ensureHost, inspectCustomTool,
  decompileAssembly, revealSource, __test: { pinFor, extractPackage, inventory, supportedPin } };
