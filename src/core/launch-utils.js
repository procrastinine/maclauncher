function asObject(value) {
  return value && typeof value === "object" ? value : {};
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
    runtimeData: {
      ...(base.runtimeData && typeof base.runtimeData === "object" ? base.runtimeData : {}),
      ...(next.runtimeData && typeof next.runtimeData === "object" ? next.runtimeData : {})
    },
    saveDirOverride: base.saveDirOverride ?? null,
    cheats: base.cheats ?? null,
    runtimeId: base.runtimeId ?? null,
    lastPlayedAt: now
  };
}

module.exports = {
  mergeDetectedEntry
};
