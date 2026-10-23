const { compareVersions } = require("../version");

// VM format is the primary selector. GEN8's stored engine tuple is not a
// reliable release ID. Rows describe candidates; tested formats are separate
// evidence and never assert that every game using that format works.
const GENERATIONS = Object.freeze([
  Object.freeze({ id: "studio-1.4", minimum: "1.4", maximumExclusive: "2", formatCandidates: Object.freeze([16]),
    recommendedVersion: "1.4.9999", status: "legacy-native-candidate" }),
  Object.freeze({ id: "studio-2-early", minimum: "2", maximumExclusive: "2.2", formatCandidates: Object.freeze([]),
    recommendedVersion: null, status: "format-unverified" }),
  Object.freeze({ id: "studio-2", minimum: "2.2", maximumExclusive: null, formatCandidates: Object.freeze([17]),
    recommendedVersion: "2026.0.0.23", status: "structural-format-candidate" })
]);
const OBSERVATIONS = Object.freeze({
  "1.4.9999": Object.freeze({ testedWadVersions: Object.freeze([16]), binarySha256: "dd8395d9dcdb5eb6e58641a730b22640d1909e72a55a48c3450cf6d0231040fa",
    architectures: Object.freeze(["x86_64"]), result: "original-game-native-menu-and-keyboard-input", renderingStable: false,
    workaround: "software-gl-v3-universal", steamApiVersion: "0.5.0",
    gameLimitations: Object.freeze(["Legacy software rendering remains unstable; prefer Butterscotch when frames are corrupted or the runner fails",
      "Offline Steam API supports legacy interfaces; online services are unavailable",
      "Audio, fullscreen, saves and full-game compatibility may vary"]) }),
  "2.2.5.378": Object.freeze({ testedWadVersions: Object.freeze([16]), binarySha256: "054debab706e5fd42ce73df6c4739ce86c31804e00e039b9e78c16dfaffc265a",
    architectures: Object.freeze(["x86_64"]), result: "backward-compatible-fixture-room-rendered", workaround: "software-opengl",
    gameLimitations: Object.freeze(["Steam exports require native Steam platform dependencies and a working client"]) }),
  "2024.13.1.242": Object.freeze({ testedWadVersions: Object.freeze([17]), binarySha256: "4871c81c7425b18cb8aa0650c82019f75dde504ca2d1d7e61d14aa5f1e874ffe",
    architectures: Object.freeze(["arm64", "x86_64"]), result: "game-window-rendered", workaround: "software-opengl" }),
  "2026.0.0.23": Object.freeze({ testedWadVersions: Object.freeze([17]), result: "fixture-main-loop-rendered",
    rejectedLayouts: Object.freeze(["legacy-name-only-or-null-path"]), workaround: "software-opengl" })
});

function capabilityForVersion(version) {
  const valid = /^(?:1\.4\.\d{1,5}|\d{1,4}\.\d{1,5}\.\d{1,5}\.\d{1,6})$/.test(version || "");
  const generation = valid ? GENERATIONS.find(row => compareVersions(version, row.minimum) >= 0 &&
    (!row.maximumExclusive || compareVersions(version, row.maximumExclusive) < 0)) : null;
  const generationCandidates = generation?.id === "studio-1.4" && compareVersions(version, "1.4.1767") < 0 ? [] : [...(generation?.formatCandidates || [])];
  const formatCandidates = [...new Set([...generationCandidates, ...(OBSERVATIONS[version]?.testedWadVersions || [])])];
  return { version, generation: generation?.id || null, status: generation?.status || "format-unverified", formatCandidates,
    testedWadVersions: [...(OBSERVATIONS[version]?.testedWadVersions || [])], observation: OBSERVATIONS[version] || null };
}

function compatibility(inspection, version) {
  const capability = capabilityForVersion(version), wad = inspection?.wadVersion;
  if (!capability.generation) return { compatible: false, capability, reason: `Official runtime '${version}' is not a supported engine generation.` };
  if (inspection?.executionKind && inspection.executionKind !== "studio-vm") return { compatible: false, capability, reason: "Official VM execution requires VM bytecode." };
  if (wad != null && !capability.formatCandidates.includes(wad)) return { compatible: false, capability,
    reason: `Official ${version} has no compatible WAD ${wad} support. ${wad === 16 ? "Use the matching Studio 1.4.9999 Mac runner." : wad === 17 ? "Use a compatible Studio 2.2+ runner." : "No matching official Mac runner is available; Butterscotch supports this bytecode generation."}` };
  if (["legacy-32", "mixed"].includes(inspection?.spriteSequenceLayout) && compareVersions(version, "2024.13") >= 0) return { compatible: false, capability,
    reason: `Official ${version} requires sequence Width/Height fields missing from this game's embedded sprite sequences. Use a runtime before 2024.13.` };
  if (inspection?.maximumOfficialRuntimeExclusive && compareVersions(version, inspection.maximumOfficialRuntimeExclusive) >= 0) return { compatible: false, capability,
    reason: `Official ${version} requires AGRP audio-group paths missing from this game. Use a runtime before ${inspection.maximumOfficialRuntimeExclusive}.` };
  if (inspection?.minimumEngineVersion && compareVersions(version, inspection.minimumEngineVersion) < 0) return { compatible: false, capability,
    reason: `Official ${version} predates this game's ${inspection.minimumEngineVersion}+ format.` };
  return { compatible: true, capability, reason: null };
}

function defaultCandidates(inspection) {
  if (inspection?.wadVersion === 16) return ["1.4.9999"];
  if (inspection?.wadVersion != null && inspection.wadVersion !== 17) return [];
  // Actual public feed builds, not inferred compiler identities. Prefer the
  // bounded older 2.3 family for its legacy sequence layout when the floor fits.
  const versions = inspection?.spriteSequenceLayout === "legacy-32"
    ? ["2.3.7.476", "2024.11.0.227"] : ["2026.0.0.23", "2024.13.1.242", "2024.11.0.227"];
  return versions.filter(version => compatibility(inspection, version).compatible);
}

module.exports = { GENERATIONS, OBSERVATIONS, capabilityForVersion, compatibility, defaultCandidates };
