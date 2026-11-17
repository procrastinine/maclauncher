const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { afterProcessStop } = require("./process-lifecycle");

const activity = new AsyncLocalStorage();

// One admission guard covers preparation, tools and the resulting process.
// Nested module/core actions share their reservation rather than leaving a gap.
function createGameLifecycle({ userDataDir, coordinator }) {
  const root = path.resolve(userDataDir);
  const identity = entry => ({ gameId: entry.gameId, gamePath: path.resolve(entry.gamePath) });
  function matching(entry) {
    const scope = activity.getStore();
    return scope?.root === root && scope.games.has(entry.gameId) && scope.coordinator === coordinator ? scope : null;
  }
  const release = scope => Promise.all([...scope.games.values()].map(token => coordinator.release(token)));
  async function claim(entry) {
    const scope = activity.getStore();
    if (!scope || scope.root !== root || scope.coordinator !== coordinator) throw new Error("Game identity can only be claimed inside an active operation.");
    if (!scope.games.has(entry.gameId)) scope.games.set(entry.gameId, await coordinator.acquireGameUse(identity(entry)));
  }
  async function retain(scope, result) {
    const target = result?.child || result?.win;
    if (!target?.once || scope.targets.has(target) || target.exitCode != null || target.signalCode != null || target.isDestroyed?.()) return;
    scope.targets.add(target);
    let finished = false;
    const releaseTarget = () => {
      if (finished) return;
      finished = true; scope.targets.delete(target);
      if (scope.finished && !scope.targets.size) void Promise.resolve().then(() => release(scope)).catch(() => {});
    };
    const finish = () => afterProcessStop(target, releaseTarget);
    for (const event of ["exit", "close", "closed"]) target.once(event, finish);
    target.once("error", () => { if (!target.pid || target.exitCode != null || target.signalCode != null) finish(); });
    if (Number.isSafeInteger(target.pid) && target.pid > 0) await Promise.all([...scope.games.values()].map(token => coordinator.bindUse(token, target.pid)));
    if (target.exitCode != null || target.signalCode != null || target.isDestroyed?.()) finish();
  }
  // A launch's use refuses removal from its start, before its process exists.
  async function use(entry, work, { launch = false } = {}) {
    if (!entry?.gameId) return work();
    const current = matching(entry);
    if (current) {
      const result = await work(); await retain(current, result); return result;
    }
    const token = await coordinator.acquireGameUse({ ...identity(entry), ...(launch ? { launch: true } : {}) });
    const scope = { root, coordinator, games: new Map([[entry.gameId, token]]), targets: new Set(), finished: false };
    try {
      return await activity.run(scope, async () => {
        const result = await work(); await retain(scope, result); return result;
      });
    } finally {
      scope.finished = true;
      if (!scope.targets.size) await release(scope);
    }
  }
  async function remove(entry, work) {
    // Removal waits for the game's other work, so work for the same game never removes it.
    if (matching(entry)) throw Object.assign(new Error("Stop the game or wait for its current action to finish."), { code: "GAME_IN_USE" });
    const token = await coordinator.acquireGameRemoval(identity(entry));
    try {
      const result = await work();
      await coordinator.completeGameRemoval(token);
      return result;
    } finally { await coordinator.release(token); }
  }
  function bindProcess(child) {
    const scope = activity.getStore();
    if (scope?.root === root && scope.coordinator === coordinator) return retain(scope, { child });
  }
  return { use, remove, claim, bindProcess };
}

module.exports = { createGameLifecycle };
