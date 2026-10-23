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

function detectedNativeRuntime(existing, detected, moduleInfo, moduleSettings = {}) {
  if (existing?.runtimeId || detected?.runtimeId !== "native") return null;
  const selected = moduleSettings?.defaultRuntime;
  const shipped = moduleInfo?.settingsDefaults?.defaultRuntime ?? moduleInfo?.runtime?.default;
  // Older settings files materialized every shipped default. That value does
  // not constitute a request to replace a publisher-provided Mac runtime.
  return selected && selected !== shipped ? null : "native";
}

module.exports = {
  mergeDetectedEntry,
  detectedNativeRuntime
};
