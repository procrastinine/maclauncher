// After a failed Tools button save, the launcher returns the game's record to
// the last choice whose patch succeeded. The cheats window follows the record
// once the library state shows a value other than the failed one. Returns
// undefined while that state has not arrived, otherwise the record's override
// (true, false or null for the module default).
export function toolsOverrideAfterFailure(pending, record) {
  if (!pending || !record || record.gamePath !== pending.gamePath) return undefined;
  const stored = record.moduleData?.toolsButtonVisibleOverride;
  const value = typeof stored === "boolean" ? stored : null;
  return value === pending.failed ? undefined : value;
}
