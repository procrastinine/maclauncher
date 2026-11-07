const fs = require("node:fs"), path = require("node:path");
const Architecture = require("../modules/shared/runtime/architecture");

// Runtimes → Tools → Downloaded files lists every downloaded file that has no
// row of its own in Runtimes: small helpers, shared assets, packages of
// runtimes without a list and caches the launcher fills. Core services declare
// theirs in core/components.js; a module or shared namespace declares its own
// in an optional components.js beside it (registry.listComponents()). Every
// runtime manager the registry knows whose versions have no Runtimes row
// (shared/runtime/runtime-rows.mjs) is listed as well, without a declaration;
// see managerComponents below. A declaration:
//   id, label, description  stable identity and plain-language name
//   list(context)            installed items, from local files only
//   remove(item, context)    optional; deletes one item. The owner downloads it
//                            again, after consent, when something needs it
//   import                   optional { matches(file, context), run(path, context) };
//                            matches({ path, size, sha256 }) recognizes the
//                            component's recorded identity; run checks the file
//                            again while it installs it, without network access,
//                            and throws a plain reason when it differs
//   cache                    optional; true for data the launcher recreates
// An item: { id, version, identity, architecture, windows, path, source, users,
// status, removable, removeReason }. `source` is { url } or { label }, or
// "manual" for an item added by hand; `users` names the runtimes or games that
// load it; `windows` marks Windows code, whose CPU is named as Windows names it.
// Sizes, Show in Finder, Add from file and the listing itself are generic.
const ENTRY_LIMIT = 200000;
const text = (value, limit = 512) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit) : "";

// The registry's runtime managers in the order main lists them: module
// managers first, then shared ones, the first manager of an id applying. Each
// keeps the modules that declare it.
function registryManagers(registry) {
  const managers = new Map();
  const add = (manager, moduleId) => {
    if (!manager?.id) return;
    const row = managers.get(manager.id) || managers.set(manager.id, { manager, moduleIds: [] }).get(manager.id);
    if (moduleId && !row.moduleIds.includes(moduleId)) row.moduleIds.push(moduleId);
  };
  for (const id of registry.listModuleIds?.() || []) for (const manager of registry.getModule?.(id)?.runtimeManagers || []) add(manager, id);
  for (const manager of registry.listSharedRuntimeManagers?.() || []) add(manager, null);
  return [...managers.values()];
}

// A runtime manager without a Runtimes row of its own is listed through
// fromRuntimeManager under its own label. Its optional `componentInfo`
// supplies the description, the users ("Used by") and `windows: true` for
// Windows code; without users, the game types whose modules declare the
// manager are named.
function managerComponents(registry) {
  const { hasRuntimesRow } = require("../modules/shared/runtime/runtime-rows.mjs");
  const Components = require("../modules/shared/runtime/runtime-components");
  return registryManagers(registry).filter(({ manager }) => typeof manager.getState === "function" &&
    !hasRuntimesRow(registry.getRuntimeManagerUi?.(manager.id) || manager.ui)).map(({ manager, moduleIds }) => {
    const info = manager.componentInfo && typeof manager.componentInfo === "object" ? manager.componentInfo : {};
    const users = Array.isArray(info.users) ? info.users : moduleIds.map(id => {
      const module = registry.getModuleInfo?.(id);
      return `${text(module?.shortLabel) || text(module?.label) || id} games`;
    });
    return { ...Components.fromRuntimeManager(manager, { description: text(info.description, 2048) || undefined, users, windows: info.windows === true }),
      owner: moduleIds[0] || "shared" };
  });
}

function declarations(registry) {
  const seen = new Set();
  return [...require("./components"), ...(registry.listComponents?.() || []), ...managerComponents(registry)].filter(item => {
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
    windows: item?.windows === true, path: location, bytes: size.bytes, sizeComplete: size.complete, source,
    users: (Array.isArray(item?.users) ? item.users : []).map(value => text(value)).filter(Boolean),
    status: text(item?.status) || null,
    removable: typeof component.remove === "function" && item?.removable !== false,
    removeReason: item?.removable === false ? text(item.removeReason) || null : null };
}

// Runtime names for "Used by", from the registry's runtime managers.
function runtimeLabels(registry) {
  const labels = new Map(registryManagers(registry).map(({ manager }) => [manager.id, text(manager.label) || manager.id]));
  return id => labels.get(id) || id;
}

// `confirmRuntimeInstall` and `downloads` let an import that needs a helper
// tool, such as an installer reader, ask before downloading it as Play does.
function createComponentService({ userDataDir, registry, settings = () => ({}), logger = console, callHost, runtimeAction, running = () => ({}),
  confirmRuntimeInstall, downloads }) {
  let runtimeLabel = null;
  const context = signal => ({ userDataDir, settings: settings(), logger, signal, runtimeAction,
    runtimeLabel: id => (runtimeLabel ||= runtimeLabels(registry))(id),
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
    // One Add from file: the chosen file is read first, every time, and added
    // to the component whose recorded identity it matches.
    async import(_payload = {}, { signal } = {}) {
      const inputPath = await callHost("chooseImportPath", { label: "Add from file", kinds: ["file"], extensions: [], buttonLabel: "Add" });
      if (!inputPath) return false;
      signal?.throwIfAborted();
      let stat;
      try { stat = fs.statSync(inputPath); } catch { throw new Error("The chosen file is not available."); }
      if (!stat.isFile()) throw new Error("Choose a file.");
      if (!stat.size) throw new Error("The chosen file is empty.");
      const file = { path: inputPath, size: stat.size, sha256: await require("../modules/shared/runtime/runtime-components").sha256File(inputPath, { signal }) };
      for (const component of declarations(registry)) {
        if (typeof component.import?.matches !== "function" || typeof component.import.run !== "function") continue;
        signal?.throwIfAborted();
        if (!await component.import.matches(file, context(signal))) continue;
        await component.import.run(inputPath, context(signal));
        return { componentId: component.id, label: text(component.label) || component.id };
      }
      throw new Error(`This file matches no download that MacLauncher records. Its SHA-256 is ${file.sha256}.`);
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
