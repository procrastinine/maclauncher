// One registration path for every user-assigned graphics shortcut. Actions
// register a handler here; the assignments live in launcher settings and are
// checked by graphics-shortcuts.mjs, which never admits a native macOS
// shortcut. Hot keys are held only while they can act: game actions while a
// game runs, and actions marked `always` (such as starting window graphics)
// whenever their handler exists. Carbon hot keys need no permission.
const Shortcuts = require("../modules/shared/graphics-shortcuts.mjs");
const ProcessTree = require("../core/process-tree");

function create({globalShortcut, readAssignments, logger}) {
  const handlers = new Map(), registered = new Map(), failures = new Map();
  let active = false;
  const assignments = () => { try { return Shortcuts.normalize(readAssignments()); } catch { return {}; } };
  const run = action => {
    const handler = handlers.get(action);
    if (!handler) return;
    Promise.resolve().then(() => handler.run()).catch(error => logger?.warn?.(`[graphics] ${Shortcuts.ACTIONS[action] || action} failed:`, error?.message || error));
  };
  function refresh() {
    const assigned = assignments(), wanted = new Map();
    for (const [action, accelerator] of Object.entries(assigned))
      if (handlers.has(action) && (active || handlers.get(action).always)) wanted.set(accelerator, action);
    for (const [accelerator, action] of [...registered]) {
      if (wanted.get(accelerator) === action) continue;
      try { globalShortcut.unregister(Shortcuts.electronAccelerator(accelerator)); } catch {}
      registered.delete(accelerator);
    }
    for (const action of [...failures.keys()]) if (!assigned[action] || !handlers.has(action)) failures.delete(action);
    for (const [accelerator, action] of wanted) {
      if (registered.has(accelerator)) continue;
      let ok = false;
      try { ok = globalShortcut.register(Shortcuts.electronAccelerator(accelerator), () => run(action)) === true; } catch {}
      if (ok) { registered.set(accelerator, action);failures.delete(action); }
      else failures.set(action, "Another app is using this shortcut.");
    }
  }
  return {
    /** Adds an action handler and returns a function that removes it. */
    handle(action, handler, {always = false} = {}) {
      if (!Object.hasOwn(Shortcuts.ACTIONS, action) || typeof handler !== "function") throw new Error("Choose a graphics shortcut action.");
      handlers.set(action, {run: handler, always});refresh();
      return () => { if (handlers.get(action)?.run === handler) { handlers.delete(action);refresh(); } };
    },
    /** Game actions hold their hot keys only while a game runs. */
    setActive(value) { if (active !== Boolean(value)) { active = Boolean(value);refresh(); } },
    refresh,
    /** Actions that have a handler, with their assignment and any registration problem. */
    status() {
      const assigned = assignments();
      return Object.keys(Shortcuts.ACTIONS).filter(action => handlers.has(action)).map(action => ({action, label: Shortcuts.ACTIONS[action],
        accelerator: assigned[action] || null, ...(failures.has(action) ? {reason: failures.get(action)} : {})}));
    },
    dispose() {
      for (const accelerator of registered.keys()) try { globalShortcut.unregister(Shortcuts.electronAccelerator(accelerator)); } catch {}
      registered.clear();handlers.clear();failures.clear();
    }
  };
}

// The process of the frontmost app, from Launch Services; null when unknown.
async function frontmostPid({execFile = require("node:child_process").execFile} = {}) {
  const run = (...args) => new Promise((resolve, reject) => execFile("/usr/bin/lsappinfo", args, {timeout: 2000}, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
  try {
    const front = (await run("front")).trim();
    if (!/^ASN:[\w-]+:?$/.test(front)) return null;
    const pid = Number(/"?pid"?\s*=\s*(\d+)/.exec(await run("info", "-only", "pid", front))?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
// The game a shortcut acts on: the only running game, otherwise the one whose
// process or captured app (`targetPid`) is frontmost, then the one with a
// frontmost descendant in the [pid, parent pid] `processes` rows (a Wine
// supervisor shell and its wine child), otherwise the most recently started one.
function chooseGame(running, pid, processes = []) {
  if (running.length <= 1) return running[0]?.gamePath || null;
  return running.find(item => pid && (item.pid === pid || item.targetPid === pid))?.gamePath ||
    running.find(item => pid && ProcessTree.descendants(item.pid, processes).has(pid))?.gamePath || running.at(-1).gamePath;
}

module.exports = { create, frontmostPid, chooseGame };
