const fs = require("node:fs");
const path = require("node:path");
const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const { readBytecode } = require("./bytecode");
const Native = require("../shared/runtime/local-native");
const manager = require("./runtime/manager");
const Graphics = require("./runtime/legacy-build");
const GameData = require("../shared/game-data");
const Download = require("./runtime/download");
const { systemVersionSync, versionAtLeast } = require("../shared/runtime/bundled-native");
const Primitives = require("./runtime/primitive-signatures");
const Profiles = require("./runtime/primitive-profiles");

function primitiveReason(comparison, version) {
  const mismatch = comparison.incompatible[0];
  if (mismatch) return `HashLink ${version} has an incompatible ${mismatch.library}@${mismatch.name} signature (${mismatch.expected} required; ${mismatch.actual} provided).`;
  const missing = comparison.missing[0];
  if (missing) return `HashLink ${version} does not provide the required ${missing.library}@${missing.name} primitive.`;
  const unknown = comparison.unknown[0];
  return unknown ? `The ${unknown.library}@${unknown.name} native signature cannot be verified for HashLink ${version}.` : null;
}
function pinPrimitives(pin, bytecode) {
  const profile = Profiles.forPin(pin);
  return profile && Array.isArray(bytecode.natives) ? Primitives.compareRequired(bytecode.natives, profile.libraries,
    { callbackMarker: profile.callbackMarker === "C" }) : null;
}

function compatibleAutomaticRuntimes(catalog, bytecode, { hostVersion, hostArchitecture = process.arch } = {}) {
  return catalog.filter(pin => !pin.deprecated && pin.architecture === "x86_64" &&
    (!pin.hostArchitectures || pin.hostArchitectures.includes(hostArchitecture)) &&
    pin.minimumMacOS && versionAtLeast(hostVersion, pin.minimumMacOS) && pin.supportedBytecodeVersions?.includes(bytecode.version) &&
    (bytecode.nativeAbi.sdlEventLoop === "unknown" || pin.nativeAbi?.sdlEventLoop === bytecode.nativeAbi.sdlEventLoop) &&
    pinPrimitives(pin, bytecode)?.ready);
}
function automaticSnapshot(catalog, bytecode, host) {
  return compatibleAutomaticRuntimes(catalog, bytecode, host).filter(pin => pin.asset && pin.sourceKind === "commit")
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))[0] || null;
}
function automaticRuntime(catalog, bytecode, host) {
  // Prefer complete public snapshots when all required primitives match. The
  // immutable source builds cover older native ABI families. Every candidate
  // requires its own exact primitive profile; a new commit cannot inherit one.
  return automaticSnapshot(catalog, bytecode, host) || compatibleAutomaticRuntimes(catalog, bytecode, host)
    .filter(pin => pin.localBuild && pin.macPackageVersion === pin.version)
    .sort((a, b) => {
      const left = String(a.upstreamVersion).split(".").map(Number), right = String(b.upstreamVersion).split(".").map(Number);
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (right[i] || 0) - (left[i] || 0); if (difference) return difference;
      }
      return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
    })[0] || null;
}

function prepareLaunch(entry, context) {
  if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId) || !context.userDataDir) throw new Error("HashLink requires a persisted game id and launcher data directory.");
  const root = path.dirname(entry.moduleData.bytecodePath);
  const directory = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id);
  if (directory.startsWith(root + path.sep)) throw new Error("HashLink staging must be outside the imported game directory.");
  const wrapper = path.join(directory, "game"), recordPath = path.join(directory, "game-source.json");
  const bytecodeSha256 = Native.hashFile(entry.moduleData.bytecodePath);
  let record; try { record = JSON.parse(fs.readFileSync(recordPath, "utf8")); } catch {}
  if (record && (record.root !== root || record.bytecodeSha256 !== bytecodeSha256)) throw new Error("Imported HashLink bytecode changed. Preserve any game saves before explicitly clearing its managed game data.");
  if (!record || !fs.existsSync(wrapper)) {
    fs.mkdirSync(directory, { recursive: true });
    const stage = fs.mkdtempSync(path.join(directory, ".stage-"));
    function copy(source, destination, depth = 0) {
      if (depth > 32) throw new Error("HashLink game directory is too deeply nested.");
      fs.mkdirSync(destination, { recursive: true });
      for (const item of fs.readdirSync(source, { withFileTypes: true })) {
        if (item.name.startsWith(".")) continue;
        const from = path.join(source, item.name), to = path.join(destination, item.name);
        if (item.isDirectory()) copy(from, to, depth + 1);
        else if (item.isFile()) {
          // The selected VM reads bytecode directly from the original file in
          // binary read mode. Foreign executables/modules are never game assets
          // and must not shadow the selected macOS native modules in cwd.
          if (from === entry.moduleData.bytecodePath || /\.(?:exe|dll|hdll|dylib)$/i.test(item.name)) continue;
          // Read large, known resource files from their original locations.
          // Configuration and unknown writable sidecars remain private.
          if (/\.(?:png|jpg|jpeg|bmp|gif|ogg|wav|mp3|flac|ttf|otf|pak|pck|bsp|mesh|fbx|obj|swf|dds|ktx)$/i.test(item.name)) fs.symlinkSync(from, to);
          else fs.copyFileSync(from, to);
        }
        // Ignore symlinks rather than following imported paths outside the game.
      }
    }
    try {
      copy(root, stage);
      fs.rmSync(wrapper, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.renameSync(stage, wrapper);
      fs.writeFileSync(recordPath, JSON.stringify({ root, bytecodeSha256, layoutVersion: 2 }));
    } finally { fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  if (record && record.layoutVersion !== 2) {
    // Migrate the old overlay without replacing it: relative player saves and
    // configuration edits must survive removal of unnecessary runtime copies.
    const priorBytecode = path.join(wrapper, path.basename(entry.moduleData.bytecodePath));
    if (fs.existsSync(priorBytecode)) {
      if (Native.hashFile(priorBytecode) !== bytecodeSha256) throw new Error("Managed HashLink bytecode changed; preserve it before clearing the obsolete copy.");
      fs.rmSync(priorBytecode);
    }
    function removeForeignBinaries(source, destination, depth = 0) {
      if (depth > 32) throw new Error("HashLink game directory is too deeply nested.");
      for (const item of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, item.name), to = path.join(destination, item.name);
        if (item.isDirectory() && fs.existsSync(to) && fs.lstatSync(to).isDirectory()) removeForeignBinaries(from, to, depth + 1);
        else if (item.isFile() && /\.(?:exe|dll|hdll|dylib)$/i.test(item.name) && fs.existsSync(to) && Native.hashFile(to) === Native.hashFile(from)) fs.rmSync(to);
      }
    }
    removeForeignBinaries(root, wrapper);
    fs.writeFileSync(recordPath, JSON.stringify({ root, bytecodeSha256, layoutVersion: 2 }));
  }
  return { directory, wrapper, bytecodePath: entry.moduleData.bytecodePath };
}

function inspectDependencies(entry, context) {
  const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
  if (!selection.ready) return { ...selection, missingLibraries: [], incompatibleLibraries: [] };
  Download.verifyInstalled(selection.install);
  if (!selection.install.architectures.includes("x86_64")) throw new Error("HashLink bytecode requires the Intel VM. An ARM HashLink/C executable does not provide the bytecode JIT.");
  const bytecode = readBytecode(entry.moduleData.bytecodePath);
  const pin = selection.install.catalogEntry || manager.core.catalog.find(item => item.version === selection.version);
  if (!pin?.supportedBytecodeVersions?.includes(bytecode.version)) throw new Error(`Selected HashLink runtime cannot read bytecode version ${bytecode.version}.`);
  const sourceMetadata = manager.core.catalog.find(item => item.upstreamRevision === selection.install.upstreamRevision);
  const requiredSdlAbi = bytecode.nativeAbi?.sdlEventLoop, runtimeSdlAbi = pin.nativeAbi?.sdlEventLoop || sourceMetadata?.nativeAbi?.sdlEventLoop;
  if ([requiredSdlAbi, runtimeSdlAbi].every(value => value && value !== "unknown") && requiredSdlAbi !== runtimeSdlAbi) {
    throw new Error(`HashLink native ABI mismatch: this game requires SDL ${requiredSdlAbi}, but runtime ${selection.version} uses ${runtimeSdlAbi}. Bytecode format alone does not determine compatibility; choose matching runtime and modules.`);
  }
  const runtimeDirectory = path.dirname(selection.install.executablePath);
  const custom = context.runtimeSettings?.nativeModuleDir?.trim();
  if (custom && !path.isAbsolute(custom)) throw new Error("HashLink native module directory must be an absolute path.");
  const directories = [...new Set([custom, runtimeDirectory, path.dirname(entry.moduleData.bytecodePath)].filter(Boolean))];
  const expectedArchitecture = "x86_64";
  const missingLibraries = [], incompatibleLibraries = [], nativeModules = [];
  for (const imported of bytecode.nativeLibraries) {
    const library = imported.replace(/^\?/, "");
    if (["std", "builtin"].includes(library)) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(library)) throw new Error(`Unsupported HashLink native library name '${library}'.`);
    const filePath = directories.flatMap(directory => [path.join(directory, `${library}64.hdll`), path.join(directory, `${library}.hdll`)])
      .find(candidate => fs.existsSync(candidate));
    if (!filePath) {
      if (!imported.startsWith("?")) missingLibraries.push(library);
      continue;
    }
    try {
      const architectures = Native.readMachOArchitectures(filePath, { allowLibrary: true });
      if (!architectures.includes(expectedArchitecture)) throw new Error("CPU mismatch");
      nativeModules.push({ library, filePath, architectures });
    } catch {
      incompatibleLibraries.push(library);
    }
  }
  const reason = incompatibleLibraries.length ? `Native modules are not compatible with this Mac runtime: ${incompatibleLibraries.join(", ")}.`
    : missingLibraries.length ? `Missing macOS native modules: ${missingLibraries.join(", ")}.` : null;
  let primitiveCompatibility = null;
  if (!reason) {
    const libraries = {};
    for (const native of nativeModules) libraries[native.library] = Primitives.readSignatures(native.filePath);
    if (bytecode.nativeLibraries.some(library => library.replace(/^\?/, "") === "std")) {
      const core = [path.join(runtimeDirectory, "libhl.dylib"), path.join(runtimeDirectory, "..", "lib", "libhl.dylib")].find(file => fs.existsSync(file));
      if (core) libraries.std = Primitives.readSignatures(core);
    }
    if (bytecode.nativeLibraries.some(library => library.replace(/^\?/, "") === "builtin")) libraries.builtin = Primitives.readSignatures(selection.install.executablePath);
    primitiveCompatibility = Primitives.compareRequired(bytecode.natives, libraries, { callbackMarker: pin.nativeAbi?.callbackMarker === "C" });
  }
  return { ...selection, ready: !reason && primitiveCompatibility?.ready, reason: reason || primitiveReason(primitiveCompatibility, selection.version),
    primitiveCompatibility,
    missingLibraries, incompatibleLibraries, nativeModules, directories, bytecodeVersion: bytecode.version,
    versionSource: "HLB header (bytecode format)", nativeAbi: bytecode.nativeAbi,
    compatibility: "format-supported; matching-native-modules-required" };
}

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [manager],
  normalizeRuntimeId: () => "hashlink",
  ensureRuntime: (entry, context) => {
    const bytecode = readBytecode(entry.moduleData.bytecodePath);
    const explicit = entry.runtimeData?.hashlink?.version, configured = context.settings?.runtimes?.hashlink?.defaultVersion;
    if (!explicit && !configured && process.platform === "darwin") {
      const pin = automaticRuntime(manager.core.listCatalog({ userDataDir: context.userDataDir }), bytecode, { hostVersion: systemVersionSync() });
      if (pin && pin.version !== manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" }).version) {
        entry.runtimeData = { ...entry.runtimeData, hashlink: { ...entry.runtimeData?.hashlink, version: pin.version } };
        context.onEntryChange?.(entry);
      }
    }
    const selection = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (selection.ready && !selection.install.architectures.includes("x86_64")) throw new Error("HashLink bytecode requires the Intel VM. An ARM HashLink/C executable does not provide the bytecode JIT.");
    const pin = selection.install?.catalogEntry || manager.core.catalog.find(item => item.version === selection.version);
    if (!selection.ready && selection.version === Graphics.UPSTREAM_VERSION) throw new Error(pin.installReason);
    if (!pin?.supportedBytecodeVersions?.includes(bytecode.version)) throw new Error(`Selected HashLink runtime cannot read bytecode version ${bytecode.version}.`);
    const abi = pin.nativeAbi?.sdlEventLoop;
    if (abi && abi !== "unknown" && bytecode.nativeAbi.sdlEventLoop !== "unknown" && abi !== bytecode.nativeAbi.sdlEventLoop) {
      throw new Error(`HashLink ${selection.version} has an incompatible SDL primitive ABI; this game needs ${bytecode.nativeAbi.sdlEventLoop}. Choose a matching runtime before installing.`);
    }
    if (!selection.ready && selection.version === "1.16" && bytecode.nativeLibraries.some(library => !library.startsWith("?") && !["std", "builtin", "ui"].includes(library))) {
      throw new Error("HashLink 1.16 includes std/ui only. This game needs a compatible runtime with matching Mac native modules.");
    }
    const primitives = pinPrimitives(pin, bytecode);
    if (primitives && !primitives.ready) throw new Error(primitiveReason(primitives, selection.version));
    // An explicitly chosen newer public archive can be downloaded with normal
    // consent. Installation inspects its real primitive getters, and launch
    // compares all imports before executing it. Automatic cannot choose it
    // until an exact pre-download profile is present.
    if (!selection.ready && !primitives && !((explicit || configured) && pin?.asset)) {
      throw new Error(`The native primitive profile for HashLink ${selection.version} is unavailable. Import a matching Mac runtime.`);
    }
    return selection.ready ? null : { managerId: "hashlink", version: selection.version, installOptions: {} };
  },
  launchRuntime: async (runtimeId, entry, context) => {
    if (runtimeId !== "hashlink") return null;
    const status = inspectDependencies(entry, context);
    if (!status.install) throw new Error(status.reason);
    if (!status.ready) {
      if (status.primitiveCompatibility && !status.primitiveCompatibility.ready) throw new Error(status.reason);
      throw new Error(`HashLink requires compatible macOS native modules. Missing: ${status.missingLibraries.join(", ") || "none"}; incompatible: ${status.incompatibleLibraries.join(", ") || "none"}. Windows .hdll files cannot be used.`);
    }
    const launch = prepareLaunch(entry, context);
    const args = [launch.bytecodePath, ...(context.runtimeSettings?.appArgs || []), ...(context.gameArguments || [])];
    if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid HashLink application arguments.");
    const env = { ...process.env, DYLD_LIBRARY_PATH: status.directories.join(path.delimiter) };
    // Thin Intel Mach-O binaries enter Rosetta through exec itself. A protected
    // /usr/bin/arch wrapper strips DYLD_* needed for HashLink native modules.
    const forceIntelSlice = process.arch === "arm64" && status.install.architectures.includes("arm64");
    return context.spawnDetachedChecked(status.install.executablePath, args,
      { cwd: launch.wrapper, env }, forceIntelSlice);
  },
  cleanupGameData: (entry, context) => {
    if (!entry.gameId || !/^[A-Za-z0-9_-]+$/.test(entry.gameId)) throw new Error("HashLink requires a persisted game id.");
    fs.rmSync(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, manifest.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  },
  actions: {
    buildRuntime: async (entry, payload, context) => {
      const version = payload?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version;
      const installed = await require("./runtime/build").buildRuntime({ userDataDir: context.userDataDir, version,
        sourcePath: payload?.sourcePath || context.runtimeSettings?.sourcePath,
        sdlSourcePath: payload?.sdlSourcePath || context.runtimeSettings?.sdlSourcePath, logger: context.logger });
      entry.runtimeData = { ...entry.runtimeData, hashlink: { ...entry.runtimeData?.hashlink, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    },
    registerRuntime: (entry, payload, context) => {
      const installed = manager.core.registerLocal({ userDataDir: context.userDataDir,
        version: payload?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version,
        runtimePath: payload?.runtimePath || context.runtimeSettings?.runtimePath });
      entry.runtimeData = { ...entry.runtimeData, hashlink: { ...entry.runtimeData?.hashlink, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    },
    runtimeStatus: (entry, _payload, context) => {
      try { return inspectDependencies(entry, context); }
      catch (error) { return { version: manager.resolveSelection(entry, context.settings, context.userDataDir).version, ready: false, reason: error.message }; }
    },
    installRuntime: async (entry, payload, context) => {
      const installed = await manager.installRuntime({ userDataDir: context.userDataDir,
        version: payload?.version || manager.resolveSelection(entry, context.settings, context.userDataDir).version,
        downloads: context.downloads, logger: context.logger });
      if (payload?.version) entry.runtimeData = { ...entry.runtimeData, hashlink: { ...entry.runtimeData?.hashlink, version: installed.version } };
      context.onRuntimeStateChange?.();
      return installed;
    },
    inspectBytecode: entry => readBytecode(entry.moduleData.bytecodePath)
  },
  __test: { inspectDependencies, prepareLaunch, automaticSnapshot, automaticRuntime }
};
