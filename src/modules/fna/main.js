const fs = require("node:fs");
const { cloneOrCopySync } = require("../shared/copy-file");
const path = require("node:path");
const NativeFocus = require("../shared/runtime/native-focus");
const crypto = require("node:crypto");
const manifest = require("./manifest.json");
const { detectGame, inspectGameAssembly } = require("./detect");
const { retargetIlAssembly } = require("./managed-assembly");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const Native = require("../shared/runtime/local-native");
const AppBundle = require("../shared/runtime/app-bundle");
const { applyGraphicsEnvironment } = require("./runtime/graphics");
const Decompiler = require("./decompiler");
const Steam = require("./steam");
const SourceInventory = require("./source-inventory");
const { hasFineChangeTime } = require("../shared/file-time");

function inspectEntry(entry) {
  const info = inspectGameAssembly(entry.moduleData?.assemblyPath || entry.gamePath);
  if (!info) throw new Error("Game no longer contains a reachable FNA/XNA managed entry point.");
  return info;
}
function preflight(entry, context = {}) {
  const info = inspectEntry(entry), options = context.runtimeSettings || {};
  if (!info.ilOnly || info.nativeEntryPoint) throw new Error("Mixed-mode Windows assemblies require a native compatibility port.");
  if (info.hasNativeManagedCode) throw new Error("This assembly includes architecture-specific managed native code. Use a portable IL build.");
  if (info.windowsApis?.length) throw new Error("This game needs a native compatibility port for " + info.windowsApis.join(", ") + ".");
  if (info.dependencyInspection?.complete === false) {
    const issue = info.dependencyInspection.issues[0];
    throw new Error("Cannot inspect managed dependency " + (issue?.reference || "data") + ": " + (issue?.reason || "unsupported format"));
  }
  const nativeDependency = info.managedDependencies?.find(dependency => !dependency.ilOnly || dependency.nativeEntryPoint || dependency.hasNativeManagedCode);
  if (nativeDependency) throw new Error("Managed dependency " + nativeDependency.assemblyName + " requires a native compatibility port.");
  if (info.requires32Bit) throw new Error("This game requires a 32-bit CLR host. The selected FNA host is 64-bit.");
  const narrowDependency = info.managedDependencies?.find(dependency => dependency.requires32Bit);
  if (narrowDependency) throw new Error("Managed dependency " + narrowDependency.assemblyName + " declares a 32-bit CLR host.");
  if (info.peMachine === 0x8664 && options.retargetIlArchitecture === false && (context.hostArchitecture || require("../shared/runtime/architecture").selectedArchitecture()) !== "x64") throw new Error("This game's portable IL is pinned to x64. Enable architecture conversion to use the ARM64 host.");
  const netTarget = /^\.NETCoreApp,Version=v(\d+)/.exec(info.targetFramework || "");
  if (netTarget && Number(netTarget[1]) > 8) throw new Error("This game requires a newer .NET host than the selected .NET 8 runtime.");
  if (info.unsupportedXnaServices.length) throw new Error("FNA does not implement these XNA services: " + info.unsupportedXnaServices.join(", ") + ".");
  if (info.engineKind === "xna" && options.useRuntimeFramework === false) throw new Error("XNA 4 requires the selected FNA framework.");
  if (options.useRuntimeFramework === false && Number(String(info.detectedVersion).split(".")[0]) < 25) throw new Error("This game uses an older SDL 2 FNA backend. Enable the selected FNA framework.");
  return info;
}
// Recorded inspection results that the FNA host can run. Other results, such
// as Windows Forms, a 32-bit CLR or mixed-mode code, stop preflight, so those
// games use a Windows runtime instead. A record without a result keeps FNA.
const FNA_COMPATIBILITY = new Set(["managed-fna", "requires-xna-adapter"]);
const fnaCanRun = entry => !entry?.moduleData?.compatibility || FNA_COMPATIBILITY.has(entry.moduleData.compatibility);
function runtimeStatus(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  try {
    const info = preflight(entry, {...context, hostArchitecture: selected.profile?.architecture});
    if (!selected.ready) return selected;
    return { ...selected, gameVersion: info.gameVersion, gameFrameworkVersion: info.detectedVersion,
      frameworkVersion: selected.profile.frameworkVersion, dotnetVersion: selected.profile.dotnetVersion };
  } catch (error) { return { ...selected, ready: false, reason: error.message }; }
}
function moduleRoot(entry, context) {
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId) || !context.userDataDir) throw new Error("FNA requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "fna");
}
function prepareGame(entry, context) {
  context.signal?.throwIfAborted();
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  const architecture = selected.profile?.architecture || require("../shared/runtime/architecture").selectedArchitecture();
  const info = preflight(entry, {...context, hostArchitecture: architecture});
  if (!selected.ready) throw new Error(selected.reason);
  const originalAssembly = path.resolve(info.assemblyPath), originalFile = fs.realpathSync(originalAssembly);
  const gameRoot = path.dirname(originalAssembly), runtimeRoot = selected.profile.root;
  const converted = context.runtimeSettings?.useRuntimeFramework !== false;
  const result = {gameRoot, assemblyPath: originalAssembly, originalAssembly, assemblyRoot: null, info,
    hostPath: selected.profile.hostPath || path.join(runtimeRoot, "MacLauncherFnaHost.dll"), runtimeRoot, selected,
    frameworkVersion: converted ? selected.profile.frameworkVersion : info.detectedVersion, converted};
  // Only CPU-pinned reachable assemblies need derived bytes. Data, config,
  // assets and ordinary portable assemblies stay at their original paths.
  const candidates = [info, ...(info.managedDependencies || []).filter(item => !item.resourceName)];
  const inputs = architecture === "arm64" ? [...new Set(candidates.filter(item => item.peMachine === 0x8664 && item.peFormat === "PE32+")
    .map(item => fs.realpathSync(item.assemblyPath)))] : [];
  if (!inputs.length) return result;
  if (context.runtimeSettings?.retargetIlArchitecture === false) throw new Error("Portable x64 assemblies need architecture conversion for the ARM64 host.");
  const root = moduleRoot(entry, context);
  let ancestor = path.resolve(root);const suffix = [];
  while (!fs.existsSync(ancestor)) {suffix.unshift(path.basename(ancestor));ancestor = path.dirname(ancestor);}
  const resolvedRoot = path.join(fs.realpathSync(ancestor), ...suffix), originalRoot = fs.realpathSync(gameRoot);
  if (resolvedRoot === originalRoot || resolvedRoot.startsWith(originalRoot + path.sep)) throw new Error("Derived assemblies must be separate from the original game.");
  const policy = crypto.createHash("sha256").update(JSON.stringify([originalFile, architecture])).digest("hex").slice(0, 24);
  const directory = path.join(root, "assemblies", policy), marker = path.join(directory, "prepared.json");
  const Writable = require("../shared/writable-input");
  Writable.assertOwnDirectory(context.userDataDir, directory, {create: false});
  let previous;
  try {const stat = fs.lstatSync(marker);if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024) previous = JSON.parse(fs.readFileSync(marker, "utf8"));} catch {}
  const snapshot = SourceInventory.inspectTransforms(inputs, {previous: previous?.inputs, signal: context.signal});
  const key = snapshot.digest;
  if (previous?.key === key && /^[a-f0-9-]+$/.test(previous.directory || "") && Array.isArray(previous.outputs)) {
    const prepared = path.join(directory, previous.directory);
    try {
      const stat = fs.lstatSync(prepared);
      if (!stat.isDirectory() || stat.isSymbolicLink() || previous.outputs.length !== inputs.length) throw Error("Invalid assembly cache.");
      const seen = new Set();
      for (const record of previous.outputs) {
        if (seen.has(record.name) || !inputs.some(file => path.basename(file) === record.name) || !/^[a-f0-9]{64}$/.test(record.sha256 || "")) throw Error("Invalid assembly cache.");
        seen.add(record.name);
        const file = path.join(prepared, record.name), observed = fs.lstatSync(file, {bigint: true});
        if (!observed.isFile() || observed.isSymbolicLink() ||
            (SourceInventory.identity(observed) !== record.identity || !hasFineChangeTime(observed)) &&
            SourceInventory.hashRegularFile(file, SourceInventory.identity(observed), context.signal) !== record.sha256) throw Error("Changed assembly cache.");
      }
      snapshot.assertUnchanged();
      return {...result, assemblyRoot: prepared, assemblyPath: inputs.includes(originalFile) ? path.join(prepared, path.basename(originalFile)) : originalAssembly};
    } catch {context.signal?.throwIfAborted();}
  }
  Writable.assertOwnDirectory(context.userDataDir, directory);
  const temporary = fs.mkdtempSync(path.join(directory, ".prepare-"));
  try {
    const outputs = [];
    for (const [file, record] of snapshot.files) {
      context.signal?.throwIfAborted();
      const destination = path.join(temporary, path.basename(file));cloneOrCopySync(file, destination);
      let stat = fs.lstatSync(destination, {bigint: true});
      if (SourceInventory.hashRegularFile(destination, SourceInventory.identity(stat), context.signal) !== record.sha256) throw SourceInventory.changedError();
      retargetIlAssembly(destination, architecture);
      stat = fs.lstatSync(destination, {bigint: true});
      outputs.push({name: path.basename(file), identity: SourceInventory.identity(stat),
        sha256: SourceInventory.hashRegularFile(destination, SourceInventory.identity(stat), context.signal)});
    }
    snapshot.assertUnchanged();
    // Existing generations, including modified caches and all legacy game
    // overlays, are retained. This cache never hosts the game's working data.
    const name = fs.existsSync(path.join(directory, key)) ? key + "-" + crypto.randomUUID() : key;
    const prepared = path.join(directory, name);
    const receipt = {key, directory: name, inputs: [...snapshot.files.values()], outputs};
    const pending = path.join(temporary, "prepared.json");fs.writeFileSync(pending, JSON.stringify(receipt));
    snapshot.assertUnchanged();
    fs.renameSync(temporary, prepared);
    fs.renameSync(path.join(prepared, "prepared.json"), marker);
    return {...result, assemblyRoot: prepared, assemblyPath: inputs.includes(originalFile) ? path.join(prepared, path.basename(originalFile)) : originalAssembly};
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  mergeEntry: (existing, entry) => ({ ...entry, runtimeId: existing?.runtimeId || entry.runtimeId || "fna" }),
  normalizeRuntimeId: value => value === "native" ? "native" : "fna",
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId !== "fna") return null;
    preflight(entry, context);
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    const requirement = manager.getState({ userDataDir: context.userDataDir, settings: context.settings }).catalog.versionRequirements?.[selected.version];
    return selected.ready ? null : { managerId: manager.id, version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), requiresDownload: requirement?.requiresDownload !== false,
      installOptions: {...selected.installOptions, ...(selected.architecture ? {architecture: selected.architecture} : {})} };
  },
  filterRuntimeSupport: (entry, supported) => fnaCanRun(entry) ? supported : supported.filter(id => id !== "fna"),
  canLaunchRuntime: (runtimeId, entry) => runtimeId === "native" ? Boolean(entry.nativeAppPath) : runtimeId !== "fna" || fnaCanRun(entry),
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId === "native") {
      if (!entry.nativeAppPath) throw new Error("This game does not include an author's macOS app.");
      const executable = AppBundle.resolveAppBundleExecutablePath(entry.nativeAppPath);
      const architectures = Native.readMachOArchitectures(executable);
      if (!architectures.some(architecture => require("../shared/runtime/host-capabilities").architectureSupport(architecture).supported)) throw new Error("The author's Mac app does not support this CPU architecture.");
      return NativeFocus.spawnForegroundNativeGame({ context, executablePath: executable, args: context.gameArguments || [], options: { cwd: path.dirname(executable), env: { ...process.env } },
        needsRosetta: require("../shared/runtime/architecture").imageRequiresRosetta(architectures) });
    }
    if (runtimeId !== "fna") return null;
    const launch = prepareGame(entry, context), settings = context.runtimeSettings || {};
    const args = Array.isArray(settings.appArgs) ? settings.appArgs : [];
    if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid FNA game arguments.");
    const env = { ...process.env, MACLAUNCHER_GAME_NAME: entry.name || "", MACLAUNCHER_GAME_ICON: entry.iconPath || "", DOTNET_ROOT: launch.runtimeRoot, DOTNET_MULTILEVEL_LOOKUP: "0", FNA_PLATFORM_BACKEND: "SDL3",
      MACLAUNCHER_FNA_GAME_ROOT: launch.gameRoot, MACLAUNCHER_FNA_ASSEMBLY_ROOT: launch.assemblyRoot || "",
      MACLAUNCHER_FNA_USE_RUNTIME_FRAMEWORK: launch.converted ? "1" : "0" };
    applyGraphicsEnvironment(env, settings);
    const steam = await Steam.prepareLaunch({ info: launch.info, context, gameRoot: launch.gameRoot, baseEnvironment: env,
      arch: launch.selected.profile.architecture || "arm64", ownedDirectory: path.join(moduleRoot(entry, context), "steam-api") });
    return NativeFocus.spawnForegroundNativeGame({ context, executablePath: launch.selected.install.executablePath,
      args: ["exec", launch.hostPath, launch.assemblyPath, launch.runtimeRoot, ...args, ...(context.gameArguments || [])], options: { cwd: launch.gameRoot, env: steam?.environment || env } });
  },
  // Older overlays may contain the only copy of private game writes.
  cleanupGameData: () => false,
  actions: { inspectGame: (entry, _payload, context) => {
      const info = inspectEntry(entry); entry.moduleData = { ...entry.moduleData, ...info }; context.onEntryChange?.(entry); return info;
    }, runtimeStatus: (entry, _payload, context) => runtimeStatus(entry, context),
    prepareGame: (entry, _payload, context) => prepareGame(entry, context),
    decompile: (entry, payload, context) => Decompiler.decompile(entry, payload, context),
    revealDecompiled: (entry, _payload, context) => Decompiler.reveal(entry, context) },
  __test: { preflight, runtimeStatus, prepareGame, inspectEntry }
};
