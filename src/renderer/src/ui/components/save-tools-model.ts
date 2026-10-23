import type { SaveScalar, StructuredSaveChange, StructuredSaveInspection } from "../types";

export type SaveView = "switches" | "variables" | "party" | "actors";
export type ScalarType = "number" | "string" | "boolean" | "null";
export type SaveDraft = { type: ScalarType; text: string };
type Target =
  | { kind: "switch"; id: number }
  | { kind: "variable"; id: number }
  | { kind: "gold" }
  | { kind: "inventory"; category: "items" | "weapons" | "armors"; id: number }
  | { kind: "actor"; id: number; field: "hp" | "mp" | "tp" | "level" };
export type SaveField = Target & { key: string; label: string; detail: string; value: SaveScalar; editable: boolean; reason?: string };

export function valueDraft(value: SaveScalar): SaveDraft {
  return { type: value === null ? "null" : typeof value as ScalarType,
    text: value === null ? "" : Object.is(value, -0) ? "-0" : String(value) };
}

export function structuredFields(inspection: StructuredSaveInspection): Record<SaveView, SaveField[]> {
  const sections = inspection.sections;
  const fields: Record<SaveView, SaveField[]> = { switches: [], variables: [], party: [], actors: [] };
  for (const category of ["switches", "variables"] as const) {
    const kind = category === "switches" ? "switch" : "variable";
    fields[category] = sections[category].map(row => ({ ...row, key: `${kind}:${row.id}`, kind,
      label: row.name, detail: `ID ${row.id}` }));
  }
  if (sections.gold) fields.party.push({ ...sections.gold, key: "gold", kind: "gold", label: "Gold", detail: "Party" });
  for (const category of ["items", "weapons", "armors"] as const) {
    fields.party.push(...sections.inventory[category].map(row => ({ ...row, key: `inventory:${category}:${row.id}`,
      kind: "inventory" as const, category, label: row.name, detail: `${category[0].toUpperCase()}${category.slice(1)} · ID ${row.id}` })));
  }
  for (const actor of sections.actors) fields.actors.push(...actor.fields.map(row => ({ ...row, key: `actor:${actor.id}:${row.key}`,
    kind: "actor" as const, id: actor.id, field: row.key, label: `${actor.name} · ${row.label}`, detail: `Actor ${actor.id}` })));
  return fields;
}

function parseDraft(draft: SaveDraft): SaveScalar {
  if (draft.type === "null") return null;
  if (draft.type === "string") return draft.text;
  if (draft.type === "boolean") {
    if (draft.text !== "true" && draft.text !== "false") throw new Error("Choose a boolean value.");
    return draft.text === "true";
  }
  if (draft.type !== "number" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(draft.text.trim())) {
    throw new Error("Enter a valid number.");
  }
  const number = Number(draft.text);
  if (!Number.isFinite(number)) throw new Error("Enter a finite number.");
  return number;
}

export function draftChanges(fields: SaveField[], drafts: Record<string, SaveDraft>): StructuredSaveChange[] {
  const byKey = new Map(fields.map(field => [field.key, field]));
  const changes: StructuredSaveChange[] = [];
  for (const [key, draft] of Object.entries(drafts)) {
    const field = byKey.get(key);
    if (!field?.editable) throw new Error("This save field is read-only or unavailable.");
    let value: SaveScalar;
    try { value = parseDraft(draft); }
    catch (error) { throw new Error(`${field.label}: ${error instanceof Error ? error.message : String(error)}`); }
    if (Object.is(value, field.value)) continue;
    if (field.kind === "switch") {
      if (typeof value !== "boolean") throw new Error(`${field.label}: choose true or false.`);
      changes.push({ kind: "switch", id: field.id, value });
    } else if (field.kind === "variable") changes.push({ kind: "variable", id: field.id, value });
    else {
      const minimum = field.kind === "actor" && field.field === "level" ? 1 : 0;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${field.label}: enter a whole number of at least ${minimum}.`);
      }
      if (field.kind === "gold") changes.push({ kind: "gold", value });
      else if (field.kind === "inventory") changes.push({ kind: "inventory", category: field.category, id: field.id, value });
      else changes.push({ kind: "actor", id: field.id, field: field.field, value });
    }
  }
  return changes;
}
