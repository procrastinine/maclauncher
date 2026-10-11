function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function mergeRuntimeData(existing, detected) {
  const result = { ...asObject(existing) };
  for (const [runtimeId, value] of Object.entries(asObject(detected))) {
    result[runtimeId] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...asObject(result[runtimeId]), ...value } : value;
  }
  return result;
}

function mergeDetectedEntry(existing, detected, options = {}) {
  const base = asObject(existing);
  const next = asObject(detected);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  return {
    ...base,
    ...next,
    moduleData: {
      ...(base.moduleData && typeof base.moduleData === "object" ? base.moduleData : {}),
      ...(next.moduleData && typeof next.moduleData === "object" ? next.moduleData : {})
    },
    runtimeData: mergeRuntimeData(base.runtimeData, next.runtimeData),
    saveDirOverride: base.saveDirOverride ?? null,
    cheats: base.cheats ?? null,
    runtimeId: base.runtimeId ?? null,
    lastPlayedAt: now
  };
}

module.exports = {
  mergeDetectedEntry
};
