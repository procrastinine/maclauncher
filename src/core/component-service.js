const fs = require("node:fs"), path = require("node:path");
const Architecture = require("../modules/shared/runtime/architecture");

// Runtimes → Components lists every downloadable file that has no row of its
// own in Runtimes: small helpers, shared assets, packages of runtimes without
// a list and caches the launcher fills. Core services declare theirs in
// core/components.js; a module or shared namespace declares its own in an
// optional components.js beside it (registry.listComponents()). A declaration:
//   id, label, description  stable identity and plain-language name
//   list(context)            installed items, from local files only
//   remove(item, context)    optional; deletes one item. The owner downloads it
//                            again, after consent, when something needs it
//   import                   optional { label, kinds, extensions, run(path, context) };
//                            run checks the chosen file or folder against the
//                            component's declared identity without network
//                            access and throws a plain reason when it differs
//   cache                    optional; true for data the launcher recreates
// An item: { id, version, identity, architecture, path, source, users, status,
// removable, removeReason }. `source` is { url } or { label }, or "manual" for
// an item added by hand; `users` names the runtimes or games that load it.
// Sizes, Reveal in Finder and the listing itself are generic.
const ENTRY_LIMIT = 200000;
const text = (value, limit = 512) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit) : "";

function declarations(registry) {
  const seen = new Set();
  return [...require("./components"), ...(registry.listComponents?.() || [])].filter(item => {
    if (!item || typeof item.id !== "string" || typeof item.list !== "function" || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
}

// Bytes on disk below a file or folder, without following links. A very large
// tree stops counting at the entry limit and is reported as at least that size.
function diskSize(target) {
  let bytes = 0, entries = 0, complete = true;
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (++entries > ENTRY_LIMIT) { complete = false; break; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) { bytes += stat.blocks ? stat.blocks * 512 : stat.size; continue; }
    if (!stat.isDirectory()) continue;
    try { for (const name of fs.readdirSync(current)) pending.push(path.join(current, name)); } catch {}
  }
  return { bytes, complete };
}

function presentItem(item, component) {
  const location = typeof item?.path === "string" && path.isAbsolute(item.path) ? item.path : null;
  const size = location ? diskSize(location) : { bytes: 0, complete: true };
  const source = item?.source === "manual" ? { manual: true, label: "Added manually" }
    : item?.source && typeof item.source === "object" ? { url: /^https:\/\//.test(item.source.url || "") ? item.source.url : null, label: text(item.source.label) || null } : null;
  const architecture = typeof item?.architecture === "string" ? Architecture.normalizeArchitecture(item.architecture) || text(item.architecture, 64) : null;
  return { id: text(String(item?.id ?? ""), 1024), version: text(item?.version), identity: text(item?.identity), architecture,
    path: location, bytes: size.bytes, sizeComplete: size.complete, source,
    users: (Array.isArray(item?.users) ? item.users : []).map(value => text(value)).filter(Boolean),
    status: text(item?.status) || null,
    removable: typeof component.remove === "function" && item?.removable !== false,
    removeReason: item?.removable === false ? text(item.removeReason) || null : null };
}

// `confirmRuntimeInstall` and `downloads` let an import that needs a helper
// tool, such as an installer reader, ask before downloading it as Play does.
function createComponentService({ userDataDir, registry, settings = () => ({}), logger = console, callHost, runtimeAction, running = () => ({}),
  confirmRuntimeInstall, downloads }) {
  const context = signal => ({ userDataDir, settings: settings(), logger, signal, runtimeAction,
    ...(confirmRuntimeInstall ? { confirmRuntimeInstall } : {}), ...(downloads ? { downloads } : {}) });
  async function listOne(component, signal) {
    let items = [], error = null;
    try { items = await component.list(context(signal)) || []; }
    catch (failure) { error = failure.message || String(failure); logger.warn?.(`[components] ${component.id}: ${error}`); }
    return { component, items: Array.isArray(items) ? items : [], error };
  }
  async function find(componentId, itemId, signal) {
    const component = declarations(registry).find(item => item.id === componentId);
    if (!component) throw new Error("This component is not available.");
    if (itemId === undefined) return { component };
    const { items } = await listOne(component, signal);
    const item = items.find(row => String(row?.id) === itemId);
    if (!item) throw new Error("This component is no longer installed.");
    return { component, item };
  }
  return {
    async list({ signal } = {}) {
      const result = [];
      for (const component of declarations(registry)) {
        signal?.throwIfAborted();
        const { items, error } = await listOne(component, signal);
        result.push({ id: component.id, label: text(component.label) || component.id, description: text(component.description, 2048) || null,
          owner: component.owner || "core", cache: component.cache === true, error,
          importable: typeof component.import?.run === "function", importLabel: text(component.import?.label) || null,
          items: items.map(item => presentItem(item, component)) });
        await new Promise(resolve => setImmediate(resolve));
      }
      return { components: result, gameRunning: Object.keys(running() || {}).length > 0 };
    },
    async remove({ componentId, itemId } = {}, { signal } = {}) {
      const { component, item } = await find(componentId, String(itemId ?? ""), signal);
      if (typeof component.remove !== "function" || item.removable === false) throw new Error(text(item.removeReason) || "This component cannot be deleted here.");
      await component.remove(item, context(signal));
      return true;
    },
    async import({ componentId } = {}, { signal } = {}) {
      const { component } = await find(componentId, undefined, signal);
      if (typeof component.import?.run !== "function") throw new Error("This component cannot be added manually.");
      const kinds = (Array.isArray(component.import.kinds) ? component.import.kinds : ["file"]).filter(kind => ["file", "directory"].includes(kind));
      const inputPath = await callHost("chooseImportPath", { label: text(component.import.label) || `Add ${text(component.label)}`,
        kinds: kinds.length ? kinds : ["file"], extensions: Array.isArray(component.import.extensions) ? component.import.extensions : [], buttonLabel: "Add" });
      if (!inputPath) return false;
      signal?.throwIfAborted();
      await component.import.run(inputPath, context(signal));
      return true;
    },
    async reveal({ componentId, itemId } = {}, { signal } = {}) {
      const { item } = await find(componentId, String(itemId ?? ""), signal);
      if (typeof item.path !== "string" || !path.isAbsolute(item.path) || !fs.existsSync(item.path)) throw new Error("This component has no files on this Mac.");
      await callHost("shell.showItemInFolder", item.path);
      return true;
    }
  };
}

module.exports = { createComponentService, declarations, diskSize, presentItem };
