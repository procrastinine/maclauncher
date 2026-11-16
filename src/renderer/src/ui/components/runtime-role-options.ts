import type { RuntimeSettingOption } from "../types";

// Runtime role rows (CPU translators, each Direct3D API, Vulkan, video) come
// from the launch plan for the game's Wine. The plan decides what this Wine can
// use; a row lists only those choices and explains none of them.
export type RoleOption = RuntimeSettingOption & {
  kind?: "automatic" | "environment" | "source" | "build";
  sourceId?: string;
  prerelease?: boolean;
  disabled?: boolean;
};

// An option list that comes with the plan's role inventory.
export function isRoleList(choices: Record<string, any> | undefined): boolean {
  return Array.isArray(choices?.roleKeys);
}

// A role the plan does not use is not shown. Lists without a role inventory
// keep every field, so other option actions are unchanged.
export function isRoleFieldShown(choices: Record<string, any> | undefined, fieldKey: string): boolean {
  return !isRoleList(choices) || choices!.roleKeys.includes(fieldKey);
}

// A row offers the automatic and environment entries, each usable source (its
// newest build) and, for a source with more than one usable build, each exact
// version. Choices this Wine cannot use are left out. The saved choice always
// stays, so the closed menu names it.
export function roleRowOptions(options: RoleOption[], selected: string): RoleOption[] {
  const builds = new Map<string, number>();
  for (const option of options) if (option.kind === "build" && option.disabled !== true && option.sourceId)
    builds.set(option.sourceId, (builds.get(option.sourceId) || 0) + 1);
  return options.filter(option => option.value === selected || option.disabled !== true &&
    !(option.kind === "build" && option.sourceId && (builds.get(option.sourceId) || 0) < 2));
}

export function roleOptionLabel(option: RoleOption): string {
  if (option.disabled === true) return `${option.label} (unavailable)`;
  return option.prerelease === true ? `${option.label} · Pre-release` : option.label;
}
