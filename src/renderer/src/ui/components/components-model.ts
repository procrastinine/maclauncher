import type { ComponentEntry, ComponentItem, ConfirmActionRequest } from "../types";
import { cpuBuildName, formatBytes } from "../ui-helpers";

// Presentation of Runtimes → Components rows (core/component-service.js lists them).

export function componentItemName(component: Pick<ComponentEntry, "label">, item: Pick<ComponentItem, "version">) {
  return item.version ? `${component.label} ${item.version}` : component.label;
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

// A digest is shortened in the row; the full value is the row's tooltip.
export function componentIdentityText(identity: string) {
  const match = /^(SHA-(?:1|256)) ([a-f0-9]{40,64})$/.exec(identity || "");
  return match ? `${match[1]} ${match[2].slice(0, 12)}…` : identity || "";
}

export function componentCpuLabel(item: Pick<ComponentItem, "architecture">) {
  return item.architecture ? cpuBuildName(item.architecture) : "";
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

export function componentImportLabel(component: Pick<ComponentEntry, "importLabel" | "label">) {
  return `${component.importLabel || `Add ${component.label}`}…`;
}
