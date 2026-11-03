const fs = require("node:fs");
const path = require("node:path");
const Exports = require("../export");
const OpenGMK = require("./opengmk");
const Native = require("../../shared/runtime/local-native");
const preparedInspections = new WeakMap();

async function prepareLaunch(entry, context, selection) {
  const dataPath = Exports.resolveDataPath(entry);
  const inspection = await OpenGMK.preflight(dataPath, selection, { signal: context.signal });
  if (inspection.parserAvailable) preparedInspections.set(context, { dataPath, version: selection.version,
    binarySha256: selection.install.binarySha256, executablePath: selection.install.executablePath,
    upstreamRevision: selection.install.upstreamRevision, inspection });
  return inspection;
}

function prepareClassicGame(entry, context) {
  const gamePath = fs.realpathSync(Exports.resolveDataPath(entry));
  const originalRoot = path.dirname(gamePath);
  const override = entry.saveDirOverride;
  if (override != null && override !== "") {
    if (typeof override !== "string" || !path.isAbsolute(override) || override.includes("\0")) throw new Error("Choose an absolute save directory.");
    fs.mkdirSync(override, { recursive: true });
  }
  return { gamePath, gameRoot: override || originalRoot, originalRoot, override: override || null };
}

async function launchClassic(entry, context, selection) {
  if (!selection.ready) throw new Error(selection.reason);
  const cached = preparedInspections.get(context);
  preparedInspections.delete(context);
  const dataPath = Exports.resolveDataPath(entry);
  const inspection = cached && cached.dataPath === dataPath && cached.version === selection.version &&
    cached.binarySha256 === selection.install.binarySha256 && cached.executablePath === selection.install.executablePath &&
    cached.upstreamRevision === selection.install.upstreamRevision && cached.inspection.sourceSha256 &&
    Native.hashFile(dataPath) === cached.inspection.sourceSha256 ? cached.inspection
    : await OpenGMK.preflight(dataPath, selection, { signal: context.signal });
  if (!inspection.parserAvailable) throw new Error("Install OpenGMK before playing Classic games.");
  const prepared = prepareClassicGame(entry, context);
  entry.defaultSaveDir = prepared.originalRoot;
  entry.moduleData = { ...entry.moduleData, classicAssetsVerified: true, extensionCount: inspection.extensionCount,
    classicExternalDefinitionCount: inspection.externalDefinitionCount, classicWritableRoot: prepared.override,
    classicUnsupportedLibraries: inspection.unsupportedLibraries,
    classicReadMode: "original-content-in-place", classicWriteMode: prepared.override ? "explicit-save-directory" : "original-content-in-place",
    lastRuntimeVersion: selection.version, lastRuntimeRevision: selection.install.upstreamRevision,
    lastRuntimeBackend: "appkit", lastRuntimeSha256: selection.install.binarySha256,
    classicSourceSha256: inspection.sourceSha256 };
  context.onEntryChange?.({ defaultSaveDir: entry.defaultSaveDir, moduleData: entry.moduleData });
  return Native.launchLocalRuntime({ runtimePath: selection.install.executablePath, runtimeVersion: selection.version,
    upstreamRevision: selection.install.upstreamRevision, expectedSha256: selection.install.binarySha256,
    args: [prepared.gamePath, "--strict", "--singlethread", "--realtime",
      ...(prepared.override ? ["--working-directory", prepared.override] : []),
      ...(context.gameArguments || []).map(argument => `--game-arg=${argument}`)], cwd: prepared.originalRoot, context });
}

module.exports = { prepareClassicGame, prepareLaunch, launchClassic };
