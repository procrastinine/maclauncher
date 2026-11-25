import type { ModuleManifest, RuntimeId } from "../types";
import { formatRuntimeOption, resolveRuntimeEntry } from "../ui-helpers";

/** One entry of a runtime menu. Runtimes of one host group, such as the Wine
 * sources, share one entry named after the group, and a second menu picks
 * among its members; every other runtime is an entry of its own. */
export type RuntimeMenuEntry = { value: string; label: string; group: string; members: RuntimeId[] };

const GROUP_VALUE = "group:";

export function runtimeHostGroup(moduleInfo: ModuleManifest | null | undefined, runtimeId: RuntimeId) {
  const group = resolveRuntimeEntry(moduleInfo, runtimeId)?.hostGroup;
  return typeof group === "string" ? group.trim() : "";
}

/** The menu value that shows a runtime: its group's entry, or its own. */
export function runtimeMenuValue(moduleInfo: ModuleManifest | null | undefined, runtimeId: RuntimeId) {
  const group = runtimeHostGroup(moduleInfo, runtimeId);
  return group ? GROUP_VALUE + group : runtimeId;
}

/** Menu entries in the order of their first runtime; a group's members keep their own order. */
export function runtimeMenuEntries(runtimeIds: RuntimeId[], moduleInfo: ModuleManifest | null | undefined): RuntimeMenuEntry[] {
  const entries: RuntimeMenuEntry[] = [];
  for (const runtimeId of runtimeIds) {
    const group = runtimeHostGroup(moduleInfo, runtimeId);
    const value = group ? GROUP_VALUE + group : runtimeId;
    const existing = entries.find(entry => entry.value === value);
    if (existing) existing.members.push(runtimeId);
    else entries.push({ value, label: group || formatRuntimeOption(runtimeId, moduleInfo), group, members: [runtimeId] });
  }
  return entries;
}

/** The runtime an entry selects: the first preferred runtime among its
 * members, such as the game type's default, otherwise its first member. */
export function runtimeMenuSelection(entry: RuntimeMenuEntry, preferred: Array<RuntimeId | null | undefined> = []) {
  return preferred.find((runtimeId): runtimeId is RuntimeId => Boolean(runtimeId) && entry.members.includes(runtimeId as RuntimeId)) ||
    entry.members[0];
}
