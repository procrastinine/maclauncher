const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../shared/runtime/local-native");
const Bundles = require("../shared/runtime/bundled-native");
const Rosetta = require("../shared/runtime/rosetta");
const GameData = require("../shared/game-data");
const { managers, profiles } = require("./decompiler-managers");
const { inspectInputs } = require("./decompiler-input");
const { getUiServices } = require("../shared/ui-services");
const execute = promisify(execFile);

async function runTool(executable, args, options, context) {
  await Rosetta.ensureForExecutable(executable, context);
  return execute(executable, args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 ** 2,
    ...(context.signal ? { signal: context.signal } : {}), ...options });
}

function outputRoot(entry, context) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.gameId || "") || !path.isAbsolute(context.userDataDir || "")) throw new Error("Import this game before exporting source.");
  const root = path.join(GameData.resolveGameModuleDir(context.userDataDir, entry.gameId, "alicesoft"), "source");
  Bundles.realDirectory(root, { create: true });
  return root;
}

function inventoryOutput(root) {
  const files = []; let bytes = 0;
  function walk(directory, depth = 0) {
    if (depth > 8) throw new Error("Decompiler output nesting exceeds its limit.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Decompiler output cannot contain symlinks.");
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) {
        if (!/\.(adv|cfg|hed|txt|hel)$/i.test(file) || files.length >= 8192 || (bytes += stat.size) > 64 * 1024 ** 2) throw new Error("Decompiler output exceeds its supported files or size.");
        files.push({ file: path.relative(root, file), bytes: stat.size, sha256: Native.hashFile(file) });
      } else throw new Error("Unsupported decompiler output file type.");
    }
  }
  walk(root);
  if (!files.some(file => /\.adv$/i.test(file.file))) throw new Error("The decompiler produced no scenario source.");
  return files;
}

async function decompile(entry, payload, context, { runProcess = runTool } = {}) {
  const input = inspectInputs(entry, context);
  const profile = profiles.find(row => row.repo === (input.generation === "system3" ? "sys3c" : "xsys35c")), manager = managers[profile.managerId];
  const selectedEntry = payload?.version ? { ...entry, runtimeData: { ...entry.runtimeData, [manager.id]: { version: manager.core.normalizeVersion(payload.version) } } } : entry;
  let selection = manager.resolveSelection(selectedEntry, context.settings, context.userDataDir);
  if (!selection.ready) {
    await manager.installRuntime({ ...context, version: selection.version });
    context.onRuntimeStateChange?.({ managerId: manager.id });
    selection = manager.resolveSelection(selectedEntry, context.settings, context.userDataDir);
  }
  if (!selection.ready) throw new Error(selection.reason || "The selected decompiler is unavailable.");
  const native = Native.resolveLocalRuntime({ runtimePath: selection.install.runtimePath, runtimeVersion: selection.version,
    upstreamRevision: selection.install.upstreamRevision, expectedSha256: selection.install.binarySha256 });
  const version = await runProcess(native.executablePath, ["--version"], { timeout: 15000 }, context);
  if (version.stdout.trim() !== `${profile.executable} ${selection.version}`) throw new Error("Native decompiler reports a different version from the selected tool.");
  const directory = fs.mkdtempSync(path.join(outputRoot(entry, context), "decompiled-"));
  try {
    const args = ["--encoding=utf8", `--outdir=${directory}`,
      ...(input.generation === "system35" ? ["--seq"] : input.gameId ? [`--game=${input.gameId}`] : []), ...input.files.map(file => file.file)];
    const result = await runProcess(native.executablePath, args, { cwd: directory }, context);
    context.signal?.throwIfAborted();
    for (const file of input.files) if (!fs.lstatSync(file.file).isFile() || fs.lstatSync(file.file).isSymbolicLink() || Native.hashFile(file.file) !== file.sha256) throw new Error("Original scenarios changed during export; no successful export was recorded.");
    const files = inventoryOutput(directory), scriptCount = files.filter(file => /\.adv$/i.test(file.file)).length;
    fs.writeFileSync(path.join(directory, "decompile.log"), result.stdout + result.stderr, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, representation: "decompiled-adv-source",
      generation: input.generation, gameVersion: input.detectedVersion, detectedGameId: input.gameId,
      tool: profile.executable, toolVersion: selection.version, upstreamRevision: selection.install.upstreamRevision,
      executableSha256: selection.install.binarySha256, source: selection.install.source,
      bundledManifestSha256: selection.install.bundledManifestSha256 || null,
      originalFiles: input.files, files, arguments: args, exportedAt: new Date().toISOString(), originalFilesChanged: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    context.signal?.throwIfAborted();
    entry.moduleData = { ...entry.moduleData, sourceExportDir: directory, sourceExportAt: Date.now() };
    context.onEntryChange?.({ moduleData: entry.moduleData });
    return { outputDir: directory, scriptCount, toolVersion: selection.version };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function revealExport(entry, _payload, context) {
  const directory = entry.moduleData?.sourceExportDir, root = outputRoot(entry, context);
  if (!directory || !path.isAbsolute(directory) || !directory.startsWith(root + path.sep) || !Bundles.realDirectory(directory)) throw new Error("No managed source export is available.");
  context.ui?.shell?.showItemInFolder?.(directory);
  return { outputDir: directory };
}

async function registerDecompiler(entry, payload, context) {
  const input = inspectInputs(entry, context);
  const profile = profiles.find(row => row.repo === (input.generation === "system3" ? "sys3c" : "xsys35c")), manager = managers[profile.managerId];
  const version = payload?.version ? manager.core.normalizeVersion(payload.version) : manager.resolveSelection(entry, context.settings, context.userDataDir).version;
  let runtimePath = payload?.runtimePath;
  if (!runtimePath) {
    const picked = await getUiServices(context).dialog.showOpenDialog({ title: `Select ${profile.executable} ${version}`, properties: ["openFile"] });
    if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
    runtimePath = picked.filePaths[0];
  }
  const native = Native.resolveLocalRuntime({ runtimePath, runtimeVersion: version, upstreamRevision: manager.core.catalog.find(pin => pin.version === version).upstreamRevision });
  const reported = await runTool(native.executablePath, ["--version"], { timeout: 15000 }, context);
  if (reported.stdout.trim() !== `${profile.executable} ${version}`) throw new Error("Selected native tool reports a different decompiler version.");
  const installed = manager.core.registerLocal({ userDataDir: context.userDataDir, version, runtimePath });
  context.onRuntimeStateChange?.({ managerId: manager.id });
  return { ready: true, toolVersion: installed.version };
}

module.exports = { decompile, revealExport, registerDecompiler, inventoryOutput };
