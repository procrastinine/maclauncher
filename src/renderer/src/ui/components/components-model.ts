import type { ComponentEntry, ComponentItem, ComponentList, ConfirmActionRequest } from "../types";
import { formatBytes } from "../ui-helpers";
import { cpuLabel } from "../../../../core/cpu-labels.mjs";

// Presentation of Runtimes → Tools → Downloaded files (core/component-service.js lists them).

export type ComponentRow = { component: ComponentEntry; item: ComponentItem };

export function componentItemName(component: Pick<ComponentEntry, "label">, item: Pick<ComponentItem, "version">) {
  return item.version ? `${component.label} ${item.version}` : component.label;
}

// Installed items only, largest first.
export function componentRows(list: ComponentList | null | undefined): ComponentRow[] {
  return (list?.components || []).flatMap(component => component.items.map(item => ({ component, item })))
    .sort((a, b) => b.item.bytes - a.item.bytes || componentItemName(a.component, a.item).localeCompare(componentItemName(b.component, b.item)));
}

// Items that no installed runtime or game uses and that can be deleted.
export function unusedComponentRows(rows: ComponentRow[]) {
  return rows.filter(row => row.item.removable && row.item.users.length === 0);
}

export function componentSizeText(item: Pick<ComponentItem, "bytes" | "sizeComplete" | "path">) {
  if (!item.path) return "";
  return item.sizeComplete ? formatBytes(item.bytes) : `At least ${formatBytes(item.bytes)}`;
}

export function componentSourceText(item: Pick<ComponentItem, "source">) {
  const source = item.source;
  if (!source) return "";
  if (source.manual) return source.label || "Added manually";
  if (source.url) {
    try { return `Downloaded from ${new URL(source.url).hostname.replace(/^www\./, "")}`; } catch {}
  }
  return source.label || "";
}

export function componentCpuLabel(item: Pick<ComponentItem, "architecture" | "windows">) {
  return cpuLabel(item.architecture, { windows: item.windows === true });
}

// Deletion names what still uses the item. A cache is filled again by its owner;
// a download is offered again, after consent, the next time something needs it.
export function componentDeleteRequest(component: Pick<ComponentEntry, "label" | "cache">, item: Pick<ComponentItem, "version" | "users">,
  gameRunning = false): ConfirmActionRequest {
  const name = componentItemName(component, item);
  const parts = [] as string[];
  if (item.users.length) parts.push(`In use by ${item.users.join(", ")}.`);
  if (gameRunning) parts.push("A running game keeps the files it already loaded until it quits.");
  parts.push(component.cache ? "MacLauncher fills it again when needed."
    : "MacLauncher asks before downloading it again the next time something needs it.");
  return { message: `Delete ${name}?`, detail: parts.join(" "), confirmLabel: "Delete", destructive: true };
}

export function componentDeleteUnusedRequest(rows: ComponentRow[], gameRunning = false): ConfirmActionRequest {
  const names = rows.map(row => componentItemName(row.component, row.item));
  const parts = [`${names.join(", ")}.`];
  if (gameRunning) parts.push("A running game keeps the files it already loaded until it quits.");
  parts.push("MacLauncher asks before downloading one again the next time something needs it.");
  return { message: rows.length === 1 ? "Delete 1 unused download?" : `Delete ${rows.length} unused downloads?`, detail: parts.join(" "),
    confirmLabel: "Delete", destructive: true };
}
