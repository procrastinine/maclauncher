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

module.exports = { mergeSettingsChanges };
