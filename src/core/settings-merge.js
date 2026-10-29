const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

// Apply only fields changed by an operation to a freshly read document.
function mergeSettingsChanges(before, after, current) {
  if (!isRecord(after)) return structuredClone(after);
  const previous = isRecord(before) ? before : {};
  const merged = isRecord(current) ? { ...current } : {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(after)])) {
    if (JSON.stringify(previous[key]) === JSON.stringify(after[key])) continue;
    if (!Object.hasOwn(after, key)) delete merged[key];
    else merged[key] = isRecord(after[key])
      ? mergeSettingsChanges(previous[key], after[key], merged[key]) : structuredClone(after[key]);
  }
  return merged;
}

// A cleared runtime default (empty, null or "auto") is the same as no saved
// default, so every manager applies its ordinary fallback instead of asking
// for a version. Runtime sections with their own defaults are cleaned alike.
function withoutClearedDefaults(runtimes) {
  if (!isRecord(runtimes)) return runtimes;
  const cleared = value => value === null || value === "" || value === "auto";
  const clean = settings => {
    if (!isRecord(settings)) return settings;
    const next = { ...settings };
    if (Object.hasOwn(next, "defaultVersion") && cleared(next.defaultVersion)) delete next.defaultVersion;
    for (const [key, value] of Object.entries(next)) {
      if (key !== "defaultVersion" && isRecord(value) && Object.hasOwn(value, "defaultVersion")) next[key] = clean(value);
    }
    return next;
  };
  return Object.fromEntries(Object.entries(runtimes).map(([id, settings]) => [id, clean(settings)]));
}

// A settings change that was not made because the stored settings could not
// be read; the stored document is unchanged.
function settingsUnreadable(cause) {
  return Object.assign(new Error("Settings could not be read, so they were not changed. Try again."), { code: "SETTINGS_UNREADABLE", cause });
}

module.exports = { mergeSettingsChanges, settingsUnreadable, withoutClearedDefaults };
