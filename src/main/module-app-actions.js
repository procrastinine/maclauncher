// App-scope module actions act without a selected game, such as applying
// graphics to another app's window. A module declares them in
// manifest.ui.appActions ({id, label, menus}) and implements
// appActions[id].targets(context) and appActions[id].createEntry(target, context),
// optionally endEntry(entry, context) and maintain(context). An action may
// name a user-assigned graphics shortcut (`shortcut`) that starts a session for
// the frontmost app or ends that app's part of it, and a `stopLabel` for its
// sessions' Stop menu. Its `sessionShortcuts` ([{shortcut, action}]) name
// further graphics shortcuts that run a module action in the running sessions
// that serve the frontmost app. A module whose sessions take several targets
// implements removeTarget(entry, id, context) and sessionTargets(entry), and
// each target gets its own remove item. With addTarget(entry, target, context),
// a choice made while the module's session runs joins that session; without
// it, each choice starts its own session.
// An action with `picker: true` opens a picker window instead of a submenu;
// its picker(context, update) streams the window's sections and thumbnails
// until stop() and is called only while that window is open. stop() may
// return a promise that settles when the picker's processes have ended; a
// chosen target's session starts after it. While a session that takes
// added targets runs, context.session gives the picker request(action,
// payload), which runs a module action in that session's lane, and
// subscribe(listener), which receives the session's own events.
// The launcher renders them in its native menus without naming any module.
// Target lists are local and offline; they refresh when a launcher window
// gains focus and when a menu is rebuilt.
// sessions: running(moduleId) gives the module's running session entry;
// request(entry, action, payload) and subscribe(entry, listener) reach it.
const ShortcutActions = require("../modules/shared/graphics-shortcuts.mjs");

function createModuleAppActions({ registry, logger = console, targetContext = () => ({}), choose, openPicker: openPickerWindow = null, sessions = null }) {
  let current = [], signature = "[]", pending = null;
  function declared() {
    const out = [];
    for (const manifest of registry.listModules()) {
      for (const action of Array.isArray(manifest.ui?.appActions) ? manifest.ui.appActions : []) {
        const handler = registry.getModule(manifest.id)?.appActions?.[action?.id];
        if (typeof action?.label !== "string" || typeof handler?.targets !== "function" || typeof handler.createEntry !== "function") continue;
        const sessionShortcuts = (Array.isArray(action.sessionShortcuts) ? action.sessionShortcuts : [])
          .filter(item => typeof item?.shortcut === "string" && typeof item.action === "string");
        out.push({ moduleId: manifest.id, action, handler, sessionShortcuts });
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
  // a NativeImage for an item; openPicker(moduleId, actionId) opens a picker
  // action's window.
  function menuItems(menu, { icon = () => null, openPicker = openPickerWindow } = {}) {
    return current.filter(({ action }) => Array.isArray(action.menus) && action.menus.includes(menu)).map(({ moduleId, action, targets }) => isPicker(moduleId, action)
      ? (openPicker ? { label: action.label, click: () => void openPicker(moduleId, action.id) } : null) : ({
      label: action.label,
      submenu: targets.flatMap(target => {
        const image = icon(target);
        return [...(target.separatorBefore ? [{ type: "separator" }] : []),
          { label: target.label, ...(image ? { icon: image } : {}), click: () => void choose(moduleId, action.id, target) }];
      })
    })).filter(Boolean);
  }
  function isPicker(moduleId, action) {
    return action.picker === true && typeof registry.getModule(moduleId)?.appActions?.[action.id]?.picker === "function";
  }
  // Starts a picker action's live list; update receives the module's models.
  function watchPicker(moduleId, actionId, context, update) {
    const found = declared().find(item => item.moduleId === moduleId && item.action.id === actionId);
    if (!found || !isPicker(moduleId, found.action)) throw new Error("This action is unavailable.");
    const running = runningSession(moduleId, actionId);
    const watch = found.handler.picker(running ? { ...context, session: sessionFor(running) } : context, update);
    const warn = error => logger.warn?.(`[app actions] ${moduleId}/${actionId}: ${error?.message || error}`);
    // stop() resolves when the picker's own processes have ended.
    return { stop: () => { try { return Promise.resolve(watch?.stop?.()).catch(warn); } catch (error) { warn(error);return Promise.resolve(); } } };
  }
  // The picker window's title: the action's label without its ellipsis.
  function title(moduleId, actionId) {
    const found = declared().find(item => item.moduleId === moduleId && item.action.id === actionId);
    return found ? found.action.label.replace(/(?:…|\.\.\.)$/, "") : null;
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
  // The available action that declares a session shortcut, with the module
  // action it runs: {moduleId, actionId, action}, or null.
  function sessionShortcut(shortcut) {
    for (const { moduleId, action, sessionShortcuts } of declared()) {
      const found = sessionShortcuts.find(item => item.shortcut === shortcut);
      if (found && current.some(item => item.moduleId === moduleId && item.action.id === action.id)) return { moduleId, actionId: action.id, action: found.action };
    }
    return null;
  }
  // Runs a module action in a running session; resolves to false without one.
  function sessionAction(entry, action) {
    return sessions ? sessions.request(entry, action, {}) : false;
  }
  // Stop items for running session entries, one submenu per action. A
  // session with several targets offers each for removal above its Stop. An
  // action with a shortcut ends its submenu with the assignment, from
  // shortcutLabel(shortcut), or with an item that calls openShortcutSettings.
  function stopItems(entries, stop, remove, { shortcutLabel = () => null, openShortcutSettings = null, runSessionAction = null } = {}) {
    const named = (label, detail) => { const value = detail ? `${label} (${detail})` : label;return value.length > 60 ? value.slice(0, 59) + "…" : value; };
    const shortcutItem = action => {
      const shortcuts = [...new Set([action.shortcut, ...(action.sessionShortcuts || []).map(item => item?.shortcut)].filter(name => typeof name === "string"))];
      const items = shortcuts.flatMap(shortcut => {
        const label = ShortcutActions.ACTIONS[shortcut] || action.label, accelerator = shortcutLabel(shortcut);
        if (accelerator) return [{ label, accelerator: ShortcutActions.electronAccelerator(accelerator), registerAccelerator: false,
          enabled: false }];
        return openShortcutSettings ? [{ label, sublabel: "Assign in Settings…", click: () => void openShortcutSettings() }] : [];
      });
      return items.length ? [{ type: "separator" }, ...items] : [];
    };
    return declared().filter(({ action }) => typeof action.stopLabel === "string").flatMap(({ moduleId, action }) => {
      const owned = entries.filter(entry => entry.moduleId === moduleId);
      const handler = registry.getModule(moduleId)?.appActions?.[action.id];
      return owned.length ? [{ label: action.stopLabel, submenu: [...owned.flatMap((entry, index) => {
        const targets = remove && handler?.sessionTargets?.(entry);
        const separator = index ? [{ type: "separator" }] : [];
        const appliesToApp = handler?.sessionTargets?.(entry)?.some(target => Number.isSafeInteger(target.pid) && target.pid > 0);
        const sessionItems = runSessionAction && appliesToApp ? (action.sessionShortcuts || []).filter(item => typeof item?.action === "string").map(item => ({
          label: ShortcutActions.ACTIONS[item.shortcut] || action.label, sublabel: entry.name,
          click: () => void runSessionAction(entry, item.action)
        })) : [];
        const stopItems = targets?.length > 1 ? [...separator, ...targets.map(target => ({ label: "Remove " + named(target.label, target.detail), click: () => void remove(entry, target.id) })),
          { type: "separator" }, { label: "Stop", click: () => void stop(entry) }] : [...separator, { label: entry.name, click: () => void stop(entry) }];
        return [...stopItems, ...sessionItems];
      }), ...shortcutItem(action)] }] : [];
    });
  }
  function sessionFor(entry) {
    return sessions ? { request: (action, payload) => sessions.request(entry, action, payload), subscribe: listener => sessions.subscribe(entry, listener) } : {};
  }
  // A running session of the module that takes several targets, or null.
  function runningSession(moduleId, actionId) {
    return canAddTarget(moduleId, actionId) ? sessions?.running(moduleId) || null : null;
  }
  // Each resolves to the module's answer, false when the session is gone.
  function addTarget(entry, actionId, target, context = {}) {
    const handler = registry.getModule(entry.moduleId)?.appActions?.[actionId];
    return typeof handler?.addTarget === "function" ? handler.addTarget(entry, target.target ?? target, { ...sessionFor(entry), ...context }) : false;
  }
  function removeTarget(entry, id, context = {}) {
    const owner = declared().find(item => item.moduleId === entry.moduleId && typeof item.handler.removeTarget === "function");
    return owner ? owner.handler.removeTarget(entry, id, { ...sessionFor(entry), ...context }) : false;
  }
  // The running session's targets, each {id, label, pid?}, or null.
  function sessionTargets(entry) {
    const owner = declared().find(item => item.moduleId === entry?.moduleId && typeof item.handler.sessionTargets === "function");
    return owner ? owner.handler.sessionTargets(entry) : null;
  }
  function canAddTarget(moduleId, actionId) { return typeof registry.getModule(moduleId)?.appActions?.[actionId]?.addTarget === "function"; }
  return { refresh, menuItems, watchPicker, title, createEntry, endEntry, maintain, forShortcut, sessionShortcut, sessionAction, stopItems, runningSession,
    addTarget, removeTarget, sessionTargets, canAddTarget, declared };
}

// Running sessions' own events, by game ID, for the views that subscribed.
function createSessionEvents() {
  const listeners = new Map();
  return {
    subscribe(gameId, listener) {
      if (!listeners.has(gameId)) listeners.set(gameId, new Set());
      listeners.get(gameId).add(listener);
      return () => { listeners.get(gameId)?.delete(listener);if (!listeners.get(gameId)?.size) listeners.delete(gameId); };
    },
    dispatch({ gameId, event } = {}) {
      for (const listener of [...listeners.get(gameId) || []]) listener(event);
    }
  };
}

module.exports = { createModuleAppActions, createSessionEvents };
