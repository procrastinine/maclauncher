const fs = require("node:fs");
const path = require("node:path");
const { createManagedPythonTool } = require("../shared/runtime/managed-python-tool");
const { assertOwnDirectory } = require("../shared/writable-input");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { getUiServices } = require("../shared/ui-services");
const Native = require("../shared/runtime/local-native");
const Launch = require("./launch");
const RealLive = require("./rldev-tools");

const manager = createManagedPythonTool({ id: "siglus-ssu", label: "Siglus SceneScript Utility",
  packageName: "siglus-ssu", moduleName: "siglus_ssu", minimumVersion: "0.5.0", order: 265,
  // test.py implements the upstream CLI's public round-trip compiler command;
  // it is application functionality rather than a fixture or test suite.
  requiredFiles: ["siglus_ssu/__main__.py", "siglus_ssu/const.py", "siglus_ssu/decompiler.py", "siglus_ssu/test.py"],
  sourceUrl: "https://github.com/Jirehlov/SiglusSceneScriptUtility" });

function inventory(directory) {
  const files = []; let bytes = 0;
  function walk(root, depth = 0) {
    if (depth > 12) throw new Error("Siglus source output nesting exceeds its limit.");
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Siglus source output cannot contain aliases.");
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) {
        if (files.length >= 100000 || (bytes += stat.size) > 512 * 1024 ** 2) throw new Error("Siglus source output exceeds its size limit.");
        files.push({ path: path.relative(directory, file), bytes: stat.size, sha256: Native.hashFile(file) });
      } else throw new Error("Siglus source output contains an unsupported file.");
    }
  }
  walk(directory); return files;
}

async function decompile(entry, payload = {}, context, dependencies = {}) {
  const info = Launch.inspectEntry(entry);
  if (info.engineKind === "reallive") return RealLive.decompile(entry, payload, context, info, inventory);
  if (info.engineKind !== "siglus") throw new Error("This decompiler requires a Siglus Scene.pck archive.");
  const source = info.scenarioPath, stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 3) throw new Error("Siglus source archive is not a supported regular file.");
  const profile = payload?.constProfile ?? 0;
  if (!Number.isInteger(profile) || profile < 0 || profile > 10) throw new Error("Choose a supported Siglus script profile.");
  throwIfAborted(context.signal);
  const selected = dependencies.manager || manager, tool = await selected.ensureTool(context, payload);
  const parent = path.join(Launch.moduleRoot(entry, context), "source"); assertOwnDirectory(context.userDataDir, parent);
  const directory = fs.mkdtempSync(path.join(parent, "decompiled-")), logPath = path.join(directory, "decompile.log");
  const sourceSha256 = Native.hashFile(source);
  const args = ["--const-profile", String(profile), "-x", "--decompile", source, directory];
  await selected.run(context, args, { installed: tool, cwd: directory, logPath,
    env: { ...process.env, XDG_CACHE_HOME: path.join(directory, "cache") } });
  throwIfAborted(context.signal);
  if (Native.hashFile(source) !== sourceSha256) throw new Error("The original Siglus archive changed during export.");
  const files = inventory(directory), scriptCount = files.filter(file => /\.ss$/i.test(file.path)).length;
  if (!scriptCount) throw new Error(`The Siglus decompiler produced no reconstructed scripts. See ${logPath}.`);
  const result = { outputDir: directory, scriptCount, toolVersion: tool.version,
    representation: "reconstructed-siglus-source", originalPath: source, originalSha256: sourceSha256,
    toolArchiveSha256: tool.archiveSha256, constProfile: profile, files };
  fs.writeFileSync(path.join(directory, "export.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  entry.moduleData = { ...entry.moduleData, sourceExportDir: directory }; context.onEntryChange?.({ moduleData: entry.moduleData });
  context.ui?.shell?.showItemInFolder?.(directory);
  return result;
}

function revealSource(entry, _payload, context) {
  const root = path.join(Launch.moduleRoot(entry, context), "source"), directory = entry.moduleData?.sourceExportDir;
  if (!directory || !path.isAbsolute(directory) || !directory.startsWith(root + path.sep)) throw new Error("Decompile this game's scripts first.");
  assertOwnDirectory(context.userDataDir, directory, { create: false });
  if (!fs.statSync(path.join(directory, "export.json")).isFile()) throw new Error("The Siglus source export is unavailable.");
  getUiServices(context).shell.showItemInFolder(directory); return { outputDir: directory };
}

module.exports = { manager, realLiveManager: RealLive.manager, decompile, revealSource, __test: { inventory } };
