const fs = require("node:fs");
const path = require("node:path");
const NativeFocus = require("../shared/runtime/native-focus");
const crypto = require("node:crypto");
const manifest = require("./manifest.json");
const { detectGame, inspectGameAssembly } = require("./detect");
const { retargetIlAssembly, inspectManagedAssembly } = require("./managed-assembly");
const manager = require("./runtime/manager");
const GameData = require("../shared/game-data");
const Native = require("../shared/runtime/local-native");
const AppBundle = require("../shared/runtime/app-bundle");
const { applyGraphicsEnvironment } = require("./runtime/graphics");
const Decompiler = require("./decompiler");
const Steam = require("./steam");
const SourceInventory = require("./source-inventory");

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
  if (info.peMachine === 0x8664 && options.retargetIlArchitecture === false) throw new Error("This game's portable IL is pinned to x64. Enable architecture conversion to use the ARM64 host.");
  const netTarget = /^\.NETCoreApp,Version=v(\d+)/.exec(info.targetFramework || "");
  if (netTarget && Number(netTarget[1]) > 8) throw new Error("This game requires a newer .NET host than the selected .NET 8 runtime.");
  if (info.unsupportedXnaServices.length) throw new Error("FNA does not implement these XNA services: " + info.unsupportedXnaServices.join(", ") + ".");
  if (info.engineKind === "xna" && options.useRuntimeFramework === false) throw new Error("XNA 4 requires the selected FNA framework.");
  if (options.useRuntimeFramework === false && Number(String(info.detectedVersion).split(".")[0]) < 25) throw new Error("This game uses an older SDL 2 FNA backend. Enable the selected FNA framework.");
  return info;
}
function runtimeStatus(entry, context) {
  const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
  try {
    const info = preflight(entry, context);
    if (!selected.ready) return selected;
    return { ...selected, gameVersion: info.gameVersion, gameFrameworkVersion: info.detectedVersion,
      frameworkVersion: selected.profile.frameworkVersion, dotnetVersion: selected.profile.dotnetVersion };
  } catch (error) { return { ...selected, ready: false, reason: error.message }; }
}
const { ASSET_DIRECTORY } = SourceInventory;
function moduleRoot(entry, context) {
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId) || !context.userDataDir) throw new Error("FNA requires a persisted game id and launcher data directory.");
  return GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "fna");
}
function copyGame(source, destination, budget = { files: 0, bytes: 0 }, depth = 0, options = {}) {
  if (depth > 32) throw new Error("FNA game directory nesting exceeds supported bounds.");
  fs.mkdirSync(destination, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.name === ".git" || item.name === ".DS_Store") continue;
    const from = path.join(source, item.name), to = path.join(destination, item.name);
    if (item.isSymbolicLink()) throw new Error("Private FNA staging requires regular files and directories; symbolic links need an unpacked copy.");
    if (item.isDirectory()) {
      if (depth === 0 && ASSET_DIRECTORY.test(item.name)) fs.symlinkSync(from, to, "dir");
      else copyGame(from, to, budget, depth + 1, options);
    }
    else if (item.isFile()) {
      const size = fs.statSync(from).size;
      if (++budget.files > 50000 || (budget.bytes += size) > 4 * 1024 * 1024 * 1024) throw new Error("FNA game copy exceeds supported bounds.");
      const mutable = options.sourceFiles ? options.sourceFiles.get(from)?.copied === true : SourceInventory.shouldCopy(from, item.name, options);
      if (mutable) fs.copyFileSync(from, to);
      else fs.symlinkSync(from, to, "file");
    }
  }
}
const sourceInventory = (source, options) => SourceInventory.inspectSources(source, options).digest;
function prepareGame(entry, context) {
  const selected = runtimeStatus(entry, context);
  if (!selected.ready) throw new Error(selected.reason);
  const info = inspectEntry(entry), assemblyPath = fs.realpathSync(info.assemblyPath), source = path.dirname(assemblyPath), root = moduleRoot(entry, context);
  const converted = context.runtimeSettings?.useRuntimeFramework !== false;
  const retargeted = context.runtimeSettings?.retargetIlArchitecture !== false;
  const gameRoot = path.join(root, "overlays", selected.version + (converted ? ".converted" : ".original") + (retargeted ? ".arm64-il" : ""));
  const realSource = fs.realpathSync(source);
  let ancestor = path.resolve(root), suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  const resolvedRoot = path.join(fs.realpathSync(ancestor), ...suffix);
  if (resolvedRoot === realSource || resolvedRoot.startsWith(realSource + path.sep)) throw new Error("The game source must be separate from its launcher data directory.");
  const policyKey = crypto.createHash("sha256").update(JSON.stringify([assemblyPath, converted, retargeted])).digest("hex");
  const inventory = SourceInventory.inspectSources(source, { assemblyPath, converted, retargeted, signal: context.signal,
    cacheFile: path.join(root, "source-inventories", policyKey + ".json") });
  const fingerprint = { schemaVersion: 2, source, sourceInventory: inventory.digest, assemblySha256: inventory.files.get(assemblyPath).sha256, runtimeVersion: selected.version,
    frameworkSha256: selected.profile.files["FNA.dll"], hostSha256: selected.profile.files["MacLauncherFnaHost.dll"], converted, retargeted };
  const marker = path.join(gameRoot, ".maclauncher-fna.json");
  let prior;
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) prior = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {}
  if (JSON.stringify(prior) !== JSON.stringify(fingerprint)) {
    fs.mkdirSync(path.dirname(gameRoot), { recursive: true });
    const temporary = fs.mkdtempSync(path.join(path.dirname(gameRoot), ".prepare-"));
    try {
      copyGame(source, temporary, undefined, 0, { assemblyPath, converted, retargeted, sourceFiles: inventory.files });
      const runtimeRoot = selected.profile.root;
      if (converted) fs.copyFileSync(path.join(runtimeRoot, "FNA.dll"), path.join(temporary, "FNA.dll"));
      if (converted && info.engineKind === "xna") {
        const facades = path.join(runtimeRoot, "abi");
        for (const name of fs.readdirSync(facades).filter(name => /^Microsoft\.Xna\.Framework(?:\.[A-Za-z.]+)?\.dll$/.test(name))) {
          fs.copyFileSync(path.join(facades, name), path.join(temporary, name));
        }
      }
      if (retargeted) {
        // Only game-local pure IL assemblies qualify. ReadyToRun, mixed-mode
        // and unmanaged Windows DLLs are never rewritten or represented as ports.
        const visit = directory => {
          for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name);
            if (item.isDirectory()) { visit(file); continue; }
            if (!item.isFile() || !/\.(exe|dll)$/i.test(item.name)) continue;
            let metadata; try { metadata = inspectManagedAssembly(file); } catch { continue; }
            if (metadata.peMachine === 0x8664 && metadata.ilOnly && !metadata.requires32Bit && !metadata.nativeEntryPoint && !metadata.hasNativeManagedCode) retargetIlAssembly(file);
          }
        };
        visit(temporary);
      }
      for (const name of ["MacLauncherFnaHost.dll", "MacLauncherFnaHost.runtimeconfig.json"]) fs.copyFileSync(path.join(runtimeRoot, name), path.join(temporary, name));
      SourceInventory.assertUnchanged(inventory);
      fs.writeFileSync(path.join(temporary, ".maclauncher-fna.json"), JSON.stringify(fingerprint));
      if (fs.existsSync(gameRoot)) {
        const retained = path.join(root, "previous-overlays"); fs.mkdirSync(retained, { recursive: true });
        fs.renameSync(gameRoot, path.join(retained, selected.version + "-" + Date.now()));
      }
      fs.renameSync(temporary, gameRoot);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  SourceInventory.assertUnchanged(inventory);
  return { gameRoot, assemblyPath: path.join(gameRoot, path.basename(info.assemblyPath)), info,
    hostPath: path.join(gameRoot, "MacLauncherFnaHost.dll"), runtimeRoot: selected.profile.root,
    frameworkVersion: converted ? selected.profile.frameworkVersion : info.detectedVersion, selected };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  mergeEntry: (existing, entry) => ({ ...entry, runtimeId: existing?.runtimeId || entry.runtimeId || "fna" }),
  normalizeRuntimeId: value => value === "native" ? "native" : "fna",
  ensureRuntime: async (entry, context) => {
    if (context.runtimeId !== "fna") return null;
    preflight(entry, context);
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    const requirement = manager.getState({ userDataDir: context.userDataDir, settings: context.settings }).catalog.versionRequirements?.[selected.version];
    return selected.ready ? null : { managerId: manager.id, version: selected.version, requiresDownload: requirement?.requiresDownload !== false, installOptions: {} };
  },
  canLaunchRuntime: (runtimeId, entry) => runtimeId !== "native" || Boolean(entry.nativeAppPath),
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId === "native") {
      if (!entry.nativeAppPath) throw new Error("This game does not include an author's macOS app.");
      const executable = AppBundle.resolveAppBundleExecutablePath(entry.nativeAppPath);
      const architectures = Native.readMachOArchitectures(executable);
      if (!architectures.includes(process.arch === "x64" ? "x86_64" : process.arch) && !architectures.includes("x86_64")) throw new Error("The author's Mac app does not support this CPU architecture.");
      return NativeFocus.spawnForegroundNativeGame({ context, executablePath: executable, args: context.gameArguments || [], options: { cwd: path.dirname(executable), env: { ...process.env } },
        needsRosetta: process.arch === "arm64" && !architectures.includes("arm64") });
    }
    if (runtimeId !== "fna") return null;
    const launch = prepareGame(entry, context), settings = context.runtimeSettings || {};
    const args = Array.isArray(settings.appArgs) ? settings.appArgs : [];
    if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid FNA game arguments.");
    const env = { ...process.env, DOTNET_ROOT: launch.runtimeRoot, DOTNET_MULTILEVEL_LOOKUP: "0", FNA_PLATFORM_BACKEND: "SDL3" };
    applyGraphicsEnvironment(env, settings);
    const steam = await Steam.prepareLaunch({ info: launch.info, context, gameRoot: launch.gameRoot, baseEnvironment: env,
      arch: launch.selected.profile.architecture || "arm64" });
    return NativeFocus.spawnForegroundNativeGame({ context, executablePath: launch.selected.install.executablePath,
      args: ["exec", launch.hostPath, launch.assemblyPath, launch.runtimeRoot, ...args, ...(context.gameArguments || [])], options: { cwd: launch.gameRoot, env: steam?.environment || env } });
  },
  cleanupGameData: (entry, context) => { fs.rmSync(moduleRoot(entry, context), { recursive: true, force: true }); return true; },
  actions: { inspectGame: (entry, _payload, context) => {
      const info = inspectEntry(entry); entry.moduleData = { ...entry.moduleData, ...info }; context.onEntryChange?.(entry); return info;
    }, runtimeStatus: (entry, _payload, context) => runtimeStatus(entry, context),
    prepareGame: (entry, _payload, context) => prepareGame(entry, context),
    decompile: (entry, payload, context) => Decompiler.decompile(entry, payload, context),
    revealDecompiled: (entry, _payload, context) => Decompiler.reveal(entry, context) },
  __test: { preflight, runtimeStatus, copyGame, sourceInventory, prepareGame, inspectEntry }
};
