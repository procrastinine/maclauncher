// Runtime UI snapshots keep inventories in their managers and share repeated
// installed/catalog facts through local references in JSON and IPC.
import { sanitizeRuntimeErrors } from "./runtime-errors.mjs";
const FORMAT = "runtimeSnapshotVersion";
const ROOT_INSTALLED = "runtimeSnapshotInstalled";
const REF = "$runtimeRef";
const plain = value => value && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const pointer = parts => "/" + parts.map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/");

export function restoreRuntimeState(state) {
  state = sanitizeRuntimeErrors(state);
  if (!plain(state) || state[FORMAT] !== 1) return state;
  const restored = new WeakMap(), active = new WeakSet();
  function restore(value) {
    if (!Array.isArray(value) && !plain(value)) return value;
    if (active.has(value)) return undefined;
    if (restored.has(value)) return restored.get(value);
    active.add(value);
    let result;
    if (Object.keys(value).length === 1 && typeof value[REF] === "string") {
      let target = state;
      for (const token of value[REF].split("/").slice(1)) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        target = target && typeof target === "object" && Object.hasOwn(target, key) ? target[key] : undefined;
      }
      result = restore(target);
    } else if (Array.isArray(value)) result = value.map(restore);
    else result = Object.fromEntries(Object.entries(value).filter(([key]) => value !== state || key !== FORMAT && key !== ROOT_INSTALLED)
      .map(([key, item]) => [key, restore(item)]));
    active.delete(value); restored.set(value, result);
    return result;
  }
  const result = restore(state);
  if (Object.hasOwn(state, ROOT_INSTALLED)) {
    const selected = state[ROOT_INSTALLED];
    if (selected === null) delete result.installed;
    else if (Array.isArray(selected)) result.installed = selected.map(index => result.installed[index]);
    else result.installed = restore(selected.value);
  }
  return result;
}

export function snapshotRuntimeState(input) {
  const state = restoreRuntimeState(input);
  if (!plain(state)) return state;
  const rows = [], rowObjects = new WeakSet();
  function clean(value, installation = false) {
    if (Array.isArray(value)) return value.map(item => clean(item, installation));
    if (!plain(value)) return value;
    // Installation inventories and sealed payload manifests stay with their managers.
    return Object.fromEntries(Object.entries(value).filter(([key]) => !installation || key !== "files" && key !== "manifest")
      .map(([key, item]) => {
        if (key !== "installed" || !Array.isArray(item)) return [key, clean(item, installation)];
        const installed = item.map(row => clean(row, true));
        for (const row of installed) if (plain(row)) { rows.push(row); rowObjects.add(row); }
        return [key, installed];
      }));
  }
  const cleaned = clean(state);
  // Root rows precede section rows so section references target /installed.
  const first = Array.isArray(cleaned.installed) ? cleaned.installed : [];
  const unique = new Map();
  for (const row of [...first, ...rows]) {
    const key = JSON.stringify(row);
    if (!unique.has(key)) unique.set(key, row);
  }
  const { installed, ...rest } = cleaned;
  const pooled = Array.isArray(installed) || unique.size > 0;
  const root = pooled ? { installed: [...unique.values()], ...rest } : cleaned;
  let selected;
  if (pooled && !Array.isArray(installed)) selected = Object.hasOwn(cleaned, "installed") ? { value: installed } : null;
  else if (pooled) {
    const indices = new Map([...unique.keys()].map((key, index) => [key, index]));
    const original = first.map(row => indices.get(JSON.stringify(row)));
    if (original.length !== unique.size || original.some((index, position) => index !== position)) selected = original;
  }
  const identities = new Map(), anchors = new Map(); let sequence = 0;
  function identity(signature) {
    if (!identities.has(signature)) identities.set(signature, ++sequence);
    return identities.get(signature);
  }
  function encode(value, parts, share = false) {
    if (!Array.isArray(value) && !plain(value)) return {
      id: identity(typeof value + ":" + (typeof value === "number" ? String(value) : JSON.stringify(value))), value
    };
    const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
    const children = entries.map(([key, item]) => [key, encode(item, [...parts, key], share || key === "catalog" || key === "installed")]);
    const id = identity((Array.isArray(value) ? "array:" : "object:") + JSON.stringify(children.map(([key, item]) => [key, item.id])));
    const result = Array.isArray(value) ? children.map(([, item]) => item.value) : Object.fromEntries(children.map(([key, item]) => [key, item.value]));
    if (share) {
      if (anchors.has(id)) {
        const reference = { [REF]: anchors.get(id) };
        if (rowObjects.has(value) || JSON.stringify(reference).length < JSON.stringify(result).length) return { id, value: reference };
      } else anchors.set(id, pointer(parts));
    }
    return { id, value: result };
  }
  return { [FORMAT]: 1, ...(selected !== undefined ? { [ROOT_INSTALLED]: selected } : {}), ...encode(root, []).value };
}
