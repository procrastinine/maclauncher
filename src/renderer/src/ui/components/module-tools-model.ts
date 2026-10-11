import type { ModuleUiField } from "../types";
import { formatFieldValue, getByPath } from "../ui-helpers";

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
    const value = formatFieldValue(raw, field.format, field.empty);
    if (!hasDisplayValue(value)) return [];
    const key = `${field.label}\0${value}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...field, value }];
  });
}
