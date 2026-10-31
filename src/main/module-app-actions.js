// App-scope module actions act without a selected game, such as applying
// graphics to another app's window. A module declares them in
// manifest.ui.appActions ({id, label, menus}) and implements
// appActions[id].targets(context) and appActions[id].createEntry(target, context),
// optionally endEntry(entry, context) and maintain(context). An action may
// name a user-assigned graphics shortcut (`shortcut`) that starts a session for
// the frontmost app, or stops it, and a `stopLabel` for its sessions' Stop
// menu. A session entry's moduleData.pid names the app it serves.
// The launcher renders them in its native menus without naming any module.
// Target lists are local and offline; they refresh when a launcher window
// gains focus and when a menu is rebuilt.
function createModuleAppActions({ registry, logger = console, targetContext = () => ({}), choose }) {
  let current = [], signature = "[]", pending = null;
  function declared() {
    const out = [];
    for (const manifest of registry.listModules()) {
      for (const action of Array.isArray(manifest.ui?.appActions) ? manifest.ui.appActions : []) {
        const handler = registry.getModule(manifest.id)?.appActions?.[action?.id];
        if (typeof action?.label !== "string" || typeof handler?.targets !== "function" || typeof handler.createEntry !== "function") continue;
        out.push({ moduleId: manifest.id, action, handler });
      }
    }
    return out;
  }
  // Resolves to true when the menus need rebuilding.
  function refresh() {
    return pending ||= (async () => {
      const next = [];
      for (const { moduleId, action, handler } of declared()) {
        let targets = [];
        try { targets = await handler.targets(targetContext(moduleId)); }
        catch (error) { logger.warn?.(`[app actions] ${moduleId}/${action.id}: ${error?.message || error}`); }
        targets = (Array.isArray(targets) ? targets : []).filter(target => typeof target?.id === "string" && typeof target.label === "string").slice(0, 64);
        if (targets.length) next.push({ moduleId, action, targets });
      }
      const nextSignature = JSON.stringify(next.map(({ moduleId, action, targets }) => [moduleId, action.id, targets.map(target => [target.id, target.label, target.iconPath])]));
      const changed = nextSignature !== signature;
      current = next;signature = nextSignature;
      return changed;
    })().finally(() => { pending = null; });
  }
  // Native menu items for one menu ("file" or "dock"). icon(target) may supply
  // a NativeImage for an item.
  function menuItems(menu, { icon = () => null } = {}) {
    return current.filter(({ action }) => Array.isArray(action.menus) && action.menus.includes(menu)).map(({ moduleId, action, targets }) => ({
      label: action.label,
      submenu: targets.flatMap(target => {
        const image = icon(target);
        return [...(target.separatorBefore ? [{ type: "separator" }] : []),
          { label: target.label, ...(image ? { icon: image } : {}), click: () => void choose(moduleId, action.id, target) }];
      })
    }));
  }
  function createEntry(moduleId, actionId, target, context) {
    const handler = registry.getModule(moduleId)?.appActions?.[actionId];
    if (typeof handler?.createEntry !== "function") throw new Error("This action is unavailable.");
    const entry = handler.createEntry(target.target ?? target, context);
    if (!entry || entry.ephemeral !== true || typeof entry.gameId !== "string") throw new Error("This action did not create a session.");
    return entry;
  }
  // Called with an ended session's current record before it is removed.
  function endEntry(entry, context) {
    const owner = declared().find(({ moduleId, handler }) => moduleId === entry?.moduleId && typeof handler.endEntry === "function");
    return owner ? owner.handler.endEntry(entry, context) : null;
  }
  // Called once per launcher start, for local upkeep such as removing data of
  // apps that are no longer installed.
  async function maintain(context) {
    for (const { moduleId, action, handler } of declared()) {
      if (typeof handler.maintain !== "function") continue;
      try { await handler.maintain(context); }
      catch (error) { logger.warn?.(`[app actions] ${moduleId}/${action.id}: ${error?.message || error}`); }
    }
  }
  // The available action bound to a shortcut, with its current targets.
  function forShortcut(shortcut) {
    return current.find(({ action }) => action.shortcut === shortcut) || null;
  }
  // Stop items for running session entries, one submenu per action.
  function stopItems(entries, stop) {
    return declared().filter(({ action }) => typeof action.stopLabel === "string").flatMap(({ moduleId, action }) => {
      const owned = entries.filter(entry => entry.moduleId === moduleId);
      return owned.length ? [{ label: action.stopLabel, submenu: owned.map(entry => ({ label: entry.name, click: () => void stop(entry) })) }] : [];
    });
  }
  return { refresh, menuItems, createEntry, endEntry, maintain, forShortcut, stopItems, declared };
}

module.exports = { createModuleAppActions };
