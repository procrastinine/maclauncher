const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manager = require("./runtime/native-manager");
const GameData = require("../game-data");
const AppBundle = require("../runtime/app-bundle");
const { runToolCommand } = require("../runtime/tool-command");
const { confirmToolInstall } = require("../runtime/tool-install");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { throwIfAborted } = require("../runtime/download-utils");

function resolveBinary(entry) {
  const candidate = entry.moduleData?.executablePath || entry.moduleData?.originalRunnerPath || entry.nativeAppPath || entry.gamePath;
  if (!path.isAbsolute(candidate || "")) throw new Error("A native game binary is required for inspection.");
  const file = fs.statSync(candidate).isDirectory() ? AppBundle.resolveAppBundleExecutablePath(candidate) : candidate;
  const fd = fs.openSync(file, "r"), bytes = Buffer.alloc(4);
  try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (bytes.toString("ascii", 0, 2) !== "MZ" && !bytes.equals(Buffer.from([127, 69, 76, 70])) &&
      ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE()))
    throw new Error("Native inspection supports DOS MZ, PE, ELF and Mach-O binaries. Plain scripts can be read directly.");
  return file;
}

function analysisInput(profile) {
  if (!profile) return { args: [], command: "" };
  if (profile.raw !== true || !/^[A-Za-z0-9_]+$/.test(profile.architecture || "") || ![8, 16, 32, 64].includes(profile.bits) ||
      !Number.isSafeInteger(profile.loadAddress) || profile.loadAddress < 0 || !Number.isSafeInteger(profile.entryAddress) || profile.entryAddress < profile.loadAddress ||
      typeof profile.language !== "string" || !/^[A-Za-z0-9_.:+ -]+$/.test(profile.language)) throw new Error("Invalid raw binary analysis profile.");
  return { args: ["-n", "-a", profile.architecture, "-b", String(profile.bits), "-m", String(profile.loadAddress), "-s", String(profile.entryAddress),
    "-e", "analysis.in=io.maps", "-e", "ghidra.lang=" + profile.language], command: "af @ " + profile.entryAddress + ";" };
}

async function inspect(entry, payload, context, { moduleId = entry.engine || entry.moduleId, resolveInput = resolveBinary, analysisProfile, ...dependencies } = {}) {
  if (!/^[a-z0-9-]+$/.test(moduleId || "") || !/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || ""))
    throw new Error("Native inspection requires a game in the library.");
  const binary = await resolveInput(entry, context);
  const input = analysisInput(analysisProfile);
  const selectedManager = dependencies.manager || manager;
  let selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload?.toolVersion });
  if (!selected.ready) {
    await confirmToolInstall(context, { manager: selectedManager, version: selected.version || "latest", requiresDownload: true,
      detail: "Required to inspect native binaries and export Ghidra C pseudocode." });
    if (!selected.version) { await selectedManager.refreshCatalog({ ...context, force: true, latestOnly: true });
      selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir); }
    if (!selected.version) throw new Error("No native inspection download is available for this Mac.");
    await selectedManager.installRuntime({ ...context, version: selected.version });
    context.onRuntimeStateChange?.();
    selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir, { version: selected.version });
  }
  if (!selected.ready) throw new Error(selected.reason);
  const root = GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, moduleId);
  const parent = path.join(root, "native-inspection"); fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".export-")), outputRoot = path.join(parent, selected.version);
  try {
    const lib = path.join(selected.install.installDir, "lib"), plugin = path.join(lib, "rizin", "plugins", "core_ghidra.dylib");
    await (dependencies.withRuntimeUse || withRuntimeUse)([{ managerId: selectedManager.id, sectionId: "default", version: selected.version,
      sourcePath: selected.install.installDir }], async use => {
      const args = ["-NN", "-q", "-x", "-l", plugin, "-e", "scr.color=0", "-e", "scr.interactive=false",
        "-e", "bin.relocs.apply=true", "-e", "bin.pdb.autoload=false", "-e", "ghidra.sleighhome=" + path.join(lib, "rizin", "plugins", "rz_ghidra_sleigh"),
        ...input.args, "-c", input.command + "aa;ij > binary.json;iij > imports.json;isj > symbols.json;izj > strings.json;aflj > functions.json;pdg @@F > decompiled.c", binary];
      await (dependencies.runCommand || runToolCommand)(selected.install.executablePath, args, {
        cwd: temporary, logPath: path.join(temporary, "inspect.log"), signal: context.signal, timeout: 600000,
        onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]),
        env: { ...process.env, DYLD_LIBRARY_PATH: lib, RZ_PREFIX: selected.install.installDir,
          RZ_USER_PLUGINS: path.join(temporary, "plugins"), RZ_DATAHOME: temporary, XDG_CONFIG_HOME: temporary,
          XDG_CACHE_HOME: temporary, DEBUGINFOD_URLS: "", RZ_CURL: "0", RZ_LOGCOLORS: "0" } });
    }, { userDataDir: context.userDataDir });
    throwIfAborted(context.signal);
    const functions = JSON.parse(fs.readFileSync(path.join(temporary, "functions.json"), "utf8"));
    if (!Array.isArray(functions) || !fs.statSync(path.join(temporary, "decompiled.c")).isFile()) throw new Error("Native inspection did not export its function inventory and pseudocode.");
    const pseudocodeBytes = fs.statSync(path.join(temporary, "decompiled.c")).size;
    const result = { outputRoot, binary, toolVersion: selected.version, functionCount: functions.length, pseudocodeBytes,
      ...(analysisProfile ? { analysisProfile: { ...analysisProfile } } : {}),
      ...(!pseudocodeBytes ? { exportWarning: "No C pseudocode was recovered. Binary metadata and the tool log remain available." } : {}),
      sourceRevision: selected.install.upstreamRevision, archiveSha256: selected.install.archiveSha256,
      description: "Native C pseudocode and binary metadata; original language source is not reconstructed." };
    fs.writeFileSync(path.join(temporary, "inspection.json"), JSON.stringify(result, null, 2));
    const previous = path.join(parent, ".previous-" + crypto.randomUUID()), existed = fs.existsSync(outputRoot);
    if (existed) fs.renameSync(outputRoot, previous);
    try { fs.renameSync(temporary, outputRoot); } catch (error) { if (existed) fs.renameSync(previous, outputRoot); throw error; }
    if (existed) fs.rmSync(previous, { recursive: true, force: true });
    entry.moduleData = { ...entry.moduleData, nativeInspectionRoot: outputRoot }; context.onEntryChange?.({ moduleData: entry.moduleData });
    return result;
  } catch (error) {
    const log = path.join(temporary, "inspect.log");
    if (fs.existsSync(log)) { fs.copyFileSync(log, path.join(parent, "inspect.log")); error.message += " See " + path.join(parent, "inspect.log") + "."; }
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function withTools(module, options = {}) {
  const action = { id: "inspectNativeBinary", label: "Inspect binary", kind: "secondary", cancellable: true,
    hiddenWhen: options.hiddenWhen || [{ key: "moduleData.launchKind", equals: "script" }],
    resultFields: [{ key: "outputRoot", label: "Binary inspection", format: "path" }, { key: "functionCount", label: "Functions" }, { key: "toolVersion", label: "Rizin / Ghidra" }, { key: "exportWarning", label: "Pseudocode" }] };
  return { ...module, manifest: { ...module.manifest, ui: { ...module.manifest.ui, actions: [...(module.manifest.ui?.actions || []), action] } },
    actions: { ...module.actions, inspectNativeBinary: (entry, payload, context) => inspect(entry, payload || {}, context, { ...options, moduleId: module.id }) } };
}
module.exports = { inspect, withTools, resolveBinary };
