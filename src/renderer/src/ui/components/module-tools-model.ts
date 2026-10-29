import type { ModuleUiAction, ModuleUiField, ModuleUiGroup } from "../types";
import { formatFieldValue, getByPath } from "../ui-helpers";

export function moduleToolGroups(actions: ModuleUiAction[], groups?: ModuleUiGroup[]): ModuleUiGroup[] {
  const available = actions.filter(action => action.inspector !== false);
  if (!groups?.length) return [{ id: "tools", label: "Game tools", actions: available.map(action => action.id) }];
  const ids = new Set(available.map(action => action.id));
  const declared = groups.map(group => ({ ...group, actions: group.actions.filter(id => ids.has(id)) }))
    .filter(group => group.actions.length || group.infoFields?.length);
  const grouped = new Set(declared.flatMap(group => group.actions)), ungrouped = available.filter(action => !grouped.has(action.id));
  if (!ungrouped.length) return declared;
  let id = "other-tools";
  for (let index = 2; declared.some(group => group.id === id); index++) id = `other-tools-${index}`;
  return [...declared, { id, label: "More tools", collapsed: true, actions: ungrouped.map(action => action.id) }];
}

export function hasDisplayValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return !["", "—", "–", "-", "null", "undefined"].includes(value.trim());
  if (Array.isArray(value)) return value.some(hasDisplayValue);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return typeof value !== "number" || Number.isFinite(value);
}

export function presentModuleFields(source: unknown, fields: ModuleUiField[]) {
  const seen = new Set<string>();
  return fields.flatMap(field => {
    const raw = getByPath(source, field.key);
    if (!hasDisplayValue(raw)) return [];
    if (typeof raw === "object" && !Array.isArray(raw) && field.format !== "boolean") return [];
    // Older manifests also return paths without a format declaration.
    const format = field.format || (typeof raw === "string" && raw.startsWith("/") ? "path" : undefined);
    const value = formatFieldValue(raw, format, field.empty);
    if (!hasDisplayValue(value)) return [];
    const key = `${field.label}\0${value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const help = field.helpKey ? getByPath(source, field.helpKey) : undefined;
    return [{ ...field, format, value, ...(typeof help === "string" && help.trim() ? {help} : {}) }];
  });
}
