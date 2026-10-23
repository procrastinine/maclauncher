const WAD_MINIMUMS = Object.freeze({ 8: "1.0.198", 9: "1.0.527", 10: "1.1.609", 11: "1.1.754",
  12: "1.1.867", 13: "1.1.917", 14: "1.4.1464", 15: "1.4.1675", 16: "1.4.1767", 17: "2.2" });
const CHUNK_MINIMUMS = Object.freeze({ ACRV: "2.3", SEQN: "2.3", TAGS: "2.3", FEDS: "2.3.6",
  FEAT: "2022.8", PSEM: "2023.2", PSYS: "2023.2", UILR: "2024.13" });
function compareVersions(a, b) {
  const first = a.split(".").map(Number), second = b.split(".").map(Number);
  for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
    const difference = (first[i] || 0) - (second[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

// WAD/chunk evidence identifies a format floor, never an exact official runner build.
function detectStudioVersion({ wadVersion, rawVersion, gen8Offset, chunks, compact = false, audioGroupLayout, spriteSequences }) {
  const gen8VersionTuple = compact ? null : rawVersion.split(".").map(Number);
  const evidence = [compact ? { kind: "compact-header-format", source: "GEN8", offset: gen8Offset,
    value: "WAD 8 compact", meaning: "This layout contains no engine version tuple; the historical format floor is inferred." }
    : { kind: "header-tuple", source: "GEN8", offset: gen8Offset + 44,
    value: rawVersion, meaning: "Stored engine header tuple; GMS2 commonly retains 2.0.0.0. It is not an exact official runtime build ID." },
  { kind: "format-version", source: "GEN8", offset: gen8Offset + 1, value: wadVersion,
    meaning: "WAD/VM instruction generation, distinct from the GameMaker release version." }];
  let minimum = WAD_MINIMUMS[wadVersion] || null;
  if (minimum) evidence.push({ kind: "minimum-engine-version", source: "WAD", value: minimum });
  for (const chunk of chunks) {
    const floor = CHUNK_MINIMUMS[chunk.id];
    if (!floor) continue;
    evidence.push({ kind: "minimum-engine-version", source: `${chunk.id} chunk`, offset: chunk.offset, value: floor });
    if (!minimum || compareVersions(floor, minimum) > 0) minimum = floor;
  }
  const audio = chunks.find(chunk => chunk.id === "AGRP");
  let maximumOfficialRuntimeExclusive = null;
  if (audioGroupLayout === "legacy-name-only-or-null-path") {
    maximumOfficialRuntimeExclusive = "2024.14";
    evidence.push({ kind: "maximum-official-runtime-exclusive", source: "AGRP audio-group path field", offset: audio?.dataOffset,
      value: maximumOfficialRuntimeExclusive, meaning: "Missing/null audio-group paths are incompatible with the required path layout in official 2024.14+ runners. This is a runtime format constraint, not an exact compiler build." });
  } else if (audioGroupLayout === "name-and-path") {
    evidence.push({ kind: "minimum-engine-version", source: "AGRP audio-group path field", offset: audio?.dataOffset, value: "2024.14" });
    if (!minimum || compareVersions(minimum, "2024.14") < 0) minimum = "2024.14";
  }
  for (const item of spriteSequences?.evidence || []) {
    if (item.layout === "legacy-32") {
      const maximum = "2024.13";
      evidence.push({ ...item, kind: "maximum-official-runtime-exclusive", value: maximum,
        meaning: "This embedded sequence has the 32-byte header; official 2024.13+ expects the Width/Height fields of the 40-byte layout." });
      if (!maximumOfficialRuntimeExclusive || compareVersions(maximum, maximumOfficialRuntimeExclusive) < 0) maximumOfficialRuntimeExclusive = maximum;
    } else if (item.layout === "dimensions-40") {
      evidence.push({ ...item, kind: "minimum-engine-version", value: "2024.13" });
      if (!minimum || compareVersions(minimum, "2024.13") < 0) minimum = "2024.13";
    }
  }
  return { gen8VersionTuple, detectedVersion: minimum ? maximumOfficialRuntimeExclusive ? `${minimum}–<${maximumOfficialRuntimeExclusive}` : `${minimum}+` : null,
    detectedVersionSource: "WAD and structural chunk evidence", detectedVersionConfidence: maximumOfficialRuntimeExclusive ? "format-range" : minimum ? "format-minimum" : "unknown",
    minimumEngineVersion: minimum, maximumOfficialRuntimeExclusive, exactEngineVersion: null, versionEvidence: evidence };
}

module.exports = { WAD_MINIMUMS, CHUNK_MINIMUMS, detectStudioVersion, compareVersions };
