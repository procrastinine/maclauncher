const { compareVersions } = require("../version");

// VM bytecode and resource layouts define runtime compatibility. GEN8's stored
// engine tuple does not identify an exact release.
const GENERATIONS = Object.freeze([
  Object.freeze({ id: "studio-1.4", minimum: "1.4", maximumExclusive: "2", formatCandidates: Object.freeze([16]) }),
  Object.freeze({ id: "studio-2-early", minimum: "2", maximumExclusive: "2.2", formatCandidates: Object.freeze([]) }),
  Object.freeze({ id: "studio-2.2", minimum: "2.2", maximumExclusive: "2.3", formatCandidates: Object.freeze([16]) }),
  Object.freeze({ id: "studio-2.3", minimum: "2.3", maximumExclusive: null, formatCandidates: Object.freeze([17]) })
]);
const OBSERVATIONS = Object.freeze({
  "1.4.9999": Object.freeze({ testedWadVersions: Object.freeze([16]),
    architectures: Object.freeze(["x86_64"]), workaround: "software-opengl", steamApiVersion: "0.5.0" }),
  "2.2.5.378": Object.freeze({ testedWadVersions: Object.freeze([16]),
    architectures: Object.freeze(["x86_64"]), workaround: "software-opengl" }),
  "2024.13.1.242": Object.freeze({ testedWadVersions: Object.freeze([17]),
    architectures: Object.freeze(["arm64", "x86_64"]), workaround: "software-opengl" }),
  "2026.0.0.23": Object.freeze({ testedWadVersions: Object.freeze([17]), rejectedLayouts: Object.freeze(["legacy-name-only-or-null-path"]), workaround: "software-opengl" })
});

function capabilityForVersion(version) {
  const valid = /^(?:1\.4\.\d{1,5}|\d{1,4}\.\d{1,5}\.\d{1,5}\.\d{1,6})$/.test(version || "");
  const generation = valid ? GENERATIONS.find(row => compareVersions(version, row.minimum) >= 0 &&
    (!row.maximumExclusive || compareVersions(version, row.maximumExclusive) < 0)) : null;
  const generationCandidates = generation?.id === "studio-1.4" && compareVersions(version, "1.4.1767") < 0 ? [] : [...(generation?.formatCandidates || [])];
  return { version, generation: generation?.id || null,
    formatCandidates: [...new Set([...generationCandidates, ...(OBSERVATIONS[version]?.testedWadVersions || [])])],
    testedWadVersions: [...(OBSERVATIONS[version]?.testedWadVersions || [])], observation: OBSERVATIONS[version] || null };
}

function compatibility(inspection, version) {
  const capability = capabilityForVersion(version), wad = inspection?.wadVersion;
  if (!capability.generation) return { compatible: false, capability, reason: `Official runtime '${version}' is not a supported engine generation.` };
  if (inspection?.executionKind && inspection.executionKind !== "studio-vm") return { compatible: false, capability, reason: "Official VM execution requires VM bytecode." };
  if (wad != null && !capability.formatCandidates.includes(wad)) return { compatible: false, capability,
    reason: `Official ${version} has no compatible WAD ${wad} support. ${wad === 16 ? "Use a compatible Studio 1.4 or 2.2 Mac runner." : wad === 17 ? "Use a compatible Studio 2.3+ runner." : "No matching official Mac runner is available; Butterscotch supports this bytecode generation."}` };
  if (["legacy-32", "mixed"].includes(inspection?.spriteSequenceLayout) && compareVersions(version, "2024.13") >= 0) return { compatible: false, capability,
    reason: `Official ${version} requires sequence Width/Height fields missing from this game's embedded sprite sequences. Use a runtime before 2024.13.` };
  if (inspection?.maximumOfficialRuntimeExclusive && compareVersions(version, inspection.maximumOfficialRuntimeExclusive) >= 0) return { compatible: false, capability,
    reason: `Official ${version} requires AGRP audio-group paths missing from this game. Use a runtime before ${inspection.maximumOfficialRuntimeExclusive}.` };
  if (inspection?.minimumEngineVersion && compareVersions(version, inspection.minimumEngineVersion) < 0) return { compatible: false, capability,
    reason: `Official ${version} predates this game's ${inspection.minimumEngineVersion}+ format.` };
  return { compatible: true, capability, reason: null };
}

function defaultCandidates(inspection, versions = []) {
  return versions.filter(version => compatibility(inspection, version).compatible)
    .sort((left, right) => compareVersions(right, left));
}

module.exports = { GENERATIONS, OBSERVATIONS, capabilityForVersion, compatibility, defaultCandidates };
