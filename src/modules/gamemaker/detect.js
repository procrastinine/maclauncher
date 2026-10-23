const fs = require("node:fs");
const path = require("node:path");
const { inspectStudio, inspectClassic } = require("./inspect");
const { BUTTERSCOTCH_BUILDS } = require("./runtime/catalog");
const { BUILD: OFFICIAL_BUILD } = require("./runtime/official-installer");
const OfficialCompatibility = require("./runtime/official-compatibility");
const { BUILD: OPEN_GMK_BUILD } = require("./runtime/opengmk");

const DATA_FILES = ["data.win", "game.unx", "game.ios", "game.droid"];

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function detectGame(context) {
  const inputPath = context?.inputPath;
  if (typeof inputPath !== "string" || !inputPath) return null;
  const isDirectory = context?.stat?.isDirectory?.() === true;
  const isAppBundle = isDirectory && inputPath.toLowerCase().endsWith(".app");
  const root = isDirectory ? inputPath : path.dirname(inputPath);
  const folders = isAppBundle ? [path.join(root, "Contents", "Resources")]
    : [root, path.join(root, "assets")];
  const candidates = context?.stat?.isFile?.() === true && path.extname(inputPath).toLowerCase() !== ".exe"
    ? [inputPath] : folders.flatMap(folder => DATA_FILES.map(name => path.join(folder, name)));
  const matches = [];
  for (const dataPath of [...new Set(candidates)]) {
    if (!isFile(dataPath)) continue;
    try { matches.push({ dataPath: path.resolve(dataPath), inspection: inspectStudio(dataPath) }); } catch {}
  }
  // Multiple independent archives make a folder import ambiguous. Direct imports remain available.
  if (matches.length > 1) return null;
  let match = matches[0];
  if (!match && !isDirectory && path.extname(inputPath).toLowerCase() === ".exe") {
    try {
      const inspection = inspectClassic(inputPath);
      if (inspection) match = { dataPath: path.resolve(inputPath), inspection };
    } catch {}
  }
  if (!match) return null;
  const { dataPath, inspection } = match;
  const contentRootDir = path.dirname(dataPath);
  return {
    engine: "gamemaker", gameType: "engine", gamePath: isAppBundle ? path.resolve(inputPath) : dataPath,
    contentRootDir, ...(isAppBundle ? { nativeAppPath: path.resolve(inputPath) } : {}),
    name: inspection.displayName || inspection.name || path.basename(isDirectory ? inputPath : inputPath, path.extname(inputPath)),
    moduleData: {
      dataPath, sourceKind: isAppBundle ? "app-bundle" : inspection.executionKind === "classic" ? "classic-executable" : "studio-data",
      engineTrack: inspection.executionKind === "classic" ? "Classic (OpenGMK)" : "Studio (official / Butterscotch)",
      executionKind: inspection.executionKind, wadVersion: inspection.wadVersion ?? null,
      rawVersion: inspection.rawVersion || inspection.classicVersion,
      rawVersionReliable: inspection.rawVersionReliable ?? true,
      gen8VersionTuple: inspection.gen8VersionTuple || null,
      detectedVersion: inspection.detectedVersion, detectedVersionSource: inspection.detectedVersionSource,
      detectedVersionConfidence: inspection.detectedVersionConfidence, exactEngineVersion: inspection.exactEngineVersion,
      minimumEngineVersion: inspection.minimumEngineVersion || null, versionEvidence: inspection.versionEvidence,
      maximumOfficialRuntimeExclusive: inspection.maximumOfficialRuntimeExclusive || null, audioGroupLayout: inspection.audioGroupLayout || null,
      spriteSequenceLayout: inspection.spriteSequenceLayout || null,
      steamEnabled: inspection.steamEnabled ?? null, steamAppId: inspection.steamAppId ?? null,
      steamFunctions: inspection.steamFunctions ?? null, steamRequired: inspection.steamRequired ?? null,
      functionClassifications: inspection.functionClassifications ?? null,
      candidateRuntimeBuilds: [
        ...(inspection.executionKind === "classic" ? [{ runtimeId: "opengmk", managerId: "opengmk", version: OPEN_GMK_BUILD.version,
          upstreamRevision: OPEN_GMK_BUILD.upstreamRevision, backend: OPEN_GMK_BUILD.backend,
          compatibility: "format-candidate" }] : []),
        ...(inspection.butterscotchCandidate ? BUTTERSCOTCH_BUILDS.map(build => ({ runtimeId: "butterscotch", managerId: "butterscotch", version: build.version,
          upstreamRevision: build.upstreamRevision, backend: build.backend, compatibility: "format-candidate" })) : []),
        ...(inspection.executionKind === "studio-vm" && inspection.inventory?.EXTN === 0
          ? OfficialCompatibility.defaultCandidates(inspection).map(version => ({ runtimeId: "official-studio", managerId: "gamemaker-official", version,
            upstreamRevision: `vendor-runtime:${version}`, backend: OFFICIAL_BUILD.backend,
            capability: OfficialCompatibility.capabilityForVersion(version), compatibility: "format-candidate" })) : [])
      ],
      compatibility: inspection.compatibility, codeCount: inspection.codeCount ?? null,
      extensionCount: inspection.inventory?.EXTN ?? null,
      butterscotchCandidate: inspection.butterscotchCandidate,
      supportReason: inspection.reasons.join(" ") || "Runs GameMaker VM data with a compatible interpreter."
    }
  };
}

module.exports = { DATA_FILES, detectGame };
