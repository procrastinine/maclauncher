const GameAvailability = require("../core/game-availability");

// The launcher's view of which library games have unavailable files. Each
// check is one bounded, asynchronous stat of a game's root, so a missing or
// unresponsive location never blocks the main process. Checks run at startup,
// when a launcher window gains focus, before Play and on the library's
// missing-file check. Only unavailable games are stored, along with which
// games have been checked at all.
// remembered holds the unavailable games of the previous launch as
// [key, { root, result }]. Until a game is checked again, a game remembered at
// the same root reads as unavailable, so the first library paint shows the
// last-known state and a check changes only what differs. onRemember receives
// the new list whenever it changes.
function createAvailabilityMonitor({ userDataDir, listGames, onChange = () => {}, onRestored = () => {}, logger = console,
  check = entry => GameAvailability.checkGameAvailability(entry, { userDataDir }), focusIntervalMs = 2000,
  remembered: rememberedEntries = [], onRemember = () => {} } = {}) {
  const unavailable = new Map(), sequence = new Map(), checked = new Map(), first = new Map();
  const remembered = new Map(rememberedEntries);
  let timer = null, lastLibraryCheck = 0, closed = false;
  const keyOf = entry => entry.gameId || entry.gamePath;

  // Results apply in request order per game: a slow check started before a
  // drive returned never overwrites a newer one.
  async function refresh(entries, { maxAgeMs = 0 } = {}) {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(entry => typeof entry?.gamePath === "string");
    const tokens = list.map(entry => {
      const key = keyOf(entry), token = (sequence.get(key) || 0) + 1;
      sequence.set(key, token);
      return token;
    });
    const results = await Promise.all(list.map(entry => Promise.resolve().then(() => {
      const previous = checked.get(keyOf(entry));
      const root = GameAvailability.rootPath(entry, { userDataDir });
      if (previous?.root === root && Date.now() - previous.at < maxAgeMs) return previous.result;
      return check(entry);
    }).catch(error => {
      try { Promise.resolve(logger.warn?.(`[library] availability check failed for ${entry.gamePath}`, error?.message)).catch(() => {}); } catch {}
      return null;
    })));
    const restored = [];
    let changed = false, rememberChanged = false;
    list.forEach((entry, index) => {
      const key = keyOf(entry), result = results[index];
      if (!result || sequence.get(key) !== tokens[index]) return;
      const root = GameAvailability.rootPath(entry, { userDataDir });
      if (checked.get(key)?.root !== root) changed = true;
      checked.set(key, { root, result, at: Date.now() });
      const next = result.available ? null : result, last = remembered.get(key);
      if (next ? !(last?.root === root && GameAvailability.sameAvailability(last.result, next)) : last) {
        if (next) remembered.set(key, { root, result: next }); else remembered.delete(key);
        rememberChanged = true;
      }
      const previous = unavailable.get(key) || null;
      if (GameAvailability.sameAvailability(previous, next)) return;
      if (next) unavailable.set(key, next); else unavailable.delete(key);
      changed = true;
      if (previous && !next) restored.push(entry);
    });
    if (rememberChanged && !closed) onRemember([...remembered]);
    if (changed && !closed) onChange();
    if (restored.length && !closed) onRestored(restored);
    return results;
  }
  function refreshLibrary() {
    lastLibraryCheck = Date.now();
    let games;
    try { games = listGames(); } catch (error) { games = []; logger.warn?.("[library] games could not be listed for availability", error?.message); }
    return refresh(games, { maxAgeMs: focusIntervalMs });
  }
  function schedule(delayMs) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refreshLibrary(); }, delayMs);
    timer.unref?.();
  }
  return {
    get(entry) {
      if (!entry) return null;
      const key = keyOf(entry), current = unavailable.get(key);
      if (current || checked.has(key)) return current || null;
      const last = remembered.get(key);
      return last && last.root === GameAvailability.rootPath(entry, { userDataDir }) ? last.result : null;
    },
    // Inspection of cached availability never starts another probe.
    known(entry) {
      const key = entry && keyOf(entry);
      return Boolean(key && checked.get(key)?.root === GameAvailability.rootPath(entry, { userDataDir }));
    },
    // Shared per-game library work owns the first check and forwards its result
    // to the backend. Runtime inventory updates reuse it without probing again.
    ensure(entry) {
      const key = keyOf(entry), root = GameAvailability.rootPath(entry, { userDataDir });
      const previous = checked.get(key);
      if (previous?.root === root) return Promise.resolve(previous.result);
      const pending = first.get(key);
      if (pending?.root === root) return pending.promise;
      lastLibraryCheck = Date.now();
      const promise = refresh(entry).then(([result]) => result).finally(() => {
        if (first.get(key)?.promise === promise) first.delete(key);
      });
      first.set(key, { root, promise });
      return promise;
    },
    refresh,
    start() { schedule(0); },
    // Window focus is frequent; a recent library check already covers it.
    focus() { if (Date.now() - lastLibraryCheck >= focusIntervalMs) schedule(0); },
    close() { closed = true; clearTimeout(timer); }
  };
}

module.exports = { createAvailabilityMonitor };
