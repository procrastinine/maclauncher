import type { RuntimeSettingOption } from "../types";
import { formatBytes } from "../ui-helpers";

// Runtime role rows (Wine, CPU translators, each Direct3D API, Vulkan, video)
// come from the launch plan. The plan supplies every fact: the architecture
// labels measured from the build's files, how its code runs, and why an
// option cannot be used. These helpers only format those facts.
export type RoleExecution = "native" | "rosetta" | "fex";
export type RoleOption = RuntimeSettingOption & {
  kind?: "automatic" | "environment" | "source" | "build";
  badges?: string[];
  execution?: RoleExecution;
  translatorLabel?: string;
  prerelease?: boolean;
  disabled?: boolean;
  reason?: string;
  download?: { bytes?: number } | null;
};

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

// Mac code under Rosetta already reads "Intel (Rosetta)" in its badge; FEX is
// named with its build, because more than one FEX build can be installed.
function executionText(option: RoleOption) {
  if (option.execution !== "fex") return "";
  return typeof option.translatorLabel === "string" && option.translatorLabel.trim() ? option.translatorLabel.trim() : "FEX";
}

export function roleOptionLabel(option: RoleOption): string {
  const parts = [option.label, ...strings(option.badges), executionText(option)];
  if (option.prerelease === true) parts.push("Pre-release");
  if (option.kind !== "automatic" && option.kind !== "environment" && option.download && typeof option.download.bytes === "number" && option.download.bytes > 0)
    parts.push(`Download ${formatBytes(option.download.bytes)}`);
  return parts.filter(Boolean).join(" · ");
}

export function isRoleOptionDisabled(option: RoleOption): boolean {
  return option.disabled === true;
}

// The sentence under a row: why the chosen option cannot be used, or the held
// back notice the plan already supplies.
export function roleOptionReason(option: RoleOption | undefined): string {
  if (!option) return "";
  if (option.disabled === true && typeof option.reason === "string" && option.reason.trim()) return option.reason.trim();
  return "";
}

// A role the plan does not use is not shown. Lists without a role inventory
// keep every field, so existing option actions are unchanged.
export function isRoleFieldShown(choices: Record<string, any> | undefined, fieldKey: string): boolean {
  const present = choices?.roleKeys;
  return !Array.isArray(present) || present.includes(fieldKey);
}

export function planSummary(choices: Record<string, any> | undefined): string {
  return typeof choices?.summary === "string" ? choices.summary.trim() : "";
}
