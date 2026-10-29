const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../../shared/game-data");
const manager = require("./cpp2il-manager");
const Decompiler = require("../../shared/runtime/managed-decompiler");
const { confirmToolInstall } = require("../../shared/runtime/tool-install");
const { runToolCommand } = require("../../shared/runtime/tool-command");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const pending = new Map();

async function ensureTool(entry, payload, context, selectedManager) {
  const explicit = payload.cpp2ilVersion || entry.runtimeData?.cpp2il?.version || context.settings?.runtimes?.cpp2il?.defaultVersion;
  let selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir, { version: payload.cpp2ilVersion });
  if (selected.ready) return selected.install;
  await confirmToolInstall(context, { manager: selectedManager, version: selected.version || "latest", requiresDownload: true,
    detail: "Required to recover managed assemblies from Unity IL2CPP code." });
  const available = selectedManager.getState({ userDataDir: context.userDataDir }).catalog.installableVersions || [];
  if (!explicit && !available.includes(selected.version)) {
    await selectedManager.refreshCatalog({ ...context, force: true, latestOnly: true });
    selected = selectedManager.resolveSelection(entry, context.settings, context.userDataDir);
  }
  if (!selected.version) throw new Error("No compatible upstream Cpp2IL download is available.");
  const install = await selectedManager.installRuntime({ ...context, version: selected.version });
  context.onRuntimeStateChange?.({ managerId: selectedManager.id });
  return install;
}

function inputFiles(entry, info) {
  const metadata = path.join(info.dataRoot, "il2cpp_data", "Metadata", "global-metadata.dat");
  const root = entry.nativeAppPath ? path.join(entry.nativeAppPath, "Contents", "Frameworks") : path.dirname(info.dataRoot);
  const binary = ["GameAssembly.dll", "GameAssembly.so", "GameAssembly.dylib"].map(name => path.join(root, name))
    .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (!binary || !fs.statSync(metadata).isFile()) throw new Error("IL2CPP decompilation requires the original GameAssembly and global-metadata.dat files.");
  return { binary, metadata };
}

async function decompileOnce(entry, info, payload, context, dependencies) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || ""))
    throw new Error("IL2CPP decompilation requires a game in the library.");
  const inputs = inputFiles(entry, info), toolManager = dependencies.manager || manager;
  const install = await ensureTool(entry, payload, context, toolManager);
  const parent = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "unity"), "il2cpp");
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".recover-"));
  const recoveredRoot = path.join(parent, install.version), backup = path.join(parent, ".previous-" + crypto.randomUUID());
  try {
    await (dependencies.withRuntimeUse || withRuntimeUse)([{ managerId: toolManager.id, sectionId: "default", version: install.version,
      sourcePath: install.installDir }], async use => {
      const args = ["--force-binary-path", inputs.binary, "--force-metadata-path", inputs.metadata,
        "--force-unity-version", info.detectedVersion, "--output-as", "dll_il_recovery", "--output-to", path.join(temporary, "assemblies")];
      await (dependencies.runCommand || runToolCommand)(install.executablePath, args, {
        cwd: temporary, logPath: path.join(temporary, "recovery.log"), signal: context.signal,
        onSpawn: child => Promise.all([use.bind(child.pid), context.onToolProcessSpawn?.(child)]),
        env: { ...process.env, DOTNET_BUNDLE_EXTRACT_BASE_DIR: path.join(parent, "dotnet-cache"),
          DOTNET_CLI_TELEMETRY_OPTOUT: "1", NO_COLOR: "1", TMPDIR: temporary } });
    }, { userDataDir: context.userDataDir });
    throwIfAborted(context.signal);
    const names = fs.readdirSync(path.join(temporary, "assemblies"), { withFileTypes: true })
      .filter(item => item.isFile() && /^[A-Za-z0-9_.-]+\.dll$/.test(item.name)).map(item => item.name).sort();
    if (!names.length || names.length > 500) throw new Error("Cpp2IL did not produce a supported managed assembly export.");
    fs.writeFileSync(path.join(temporary, "recovery.json"), JSON.stringify({ toolVersion: install.version,
      upstreamRevision: install.upstreamRevision, archiveSha256: install.archiveSha256,
      unityVersion: info.detectedVersion, ...inputs, assemblies: names,
      description: "Recovered assemblies can contain incomplete method bodies and are for inspection." }, null, 2));
    const previous = fs.existsSync(recoveredRoot);
    if (previous) fs.renameSync(recoveredRoot, backup);
    try { fs.renameSync(temporary, recoveredRoot); }
    catch (error) { if (previous) fs.renameSync(backup, recoveredRoot); throw error; }
    if (previous) fs.rmSync(backup, { recursive: true, force: true });
    const assemblyRoot = path.join(recoveredRoot, "assemblies");
    // Engine/framework DLLs remain available as references; upstream recovery
    // fills their method bodies with placeholders rather than recovering code.
    const assemblyPaths = names.filter(name => !/^(?:mscorlib|netstandard|System(?:\..*)?|UnityEngine(?:\..*)?|Unity\..*)\.dll$/i.test(name))
      .map(name => path.join(assemblyRoot, name));
    if (!assemblyPaths.length) throw new Error("Cpp2IL did not recover any game assemblies. See " + recoveredRoot + ".");
    const result = await (dependencies.decompileAssembly || Decompiler.decompileAssembly)({ entry, payload, context, moduleId: "unity",
      assemblyPath: assemblyPaths[0], assemblyPaths, gameVersion: info.detectedVersion });
    return { ...result, cpp2ilVersion: install.version, assemblyRoot };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function decompile(entry, info, payload = {}, context, dependencies = {}) {
  const key = context.userDataDir + ":" + entry.gameId;
  if (pending.has(key)) return pending.get(key);
  const work = decompileOnce(entry, info, payload, context, dependencies).finally(() => pending.delete(key));
  pending.set(key, work); return work;
}
module.exports = { decompile, __test: { inputFiles, ensureTool } };
