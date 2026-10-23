// Progress can arrive once per archive chunk. Keep only the latest update for
// each live operation; phase changes and completion must reach the UI promptly.
function createProgressReporter(send, { intervalMs = 250 } = {}) {
  const active = new Map();
  function discard(key) {
    const state = active.get(key);
    if (state) clearTimeout(state.timer);
    active.delete(key);
  }
  function report(key, value) {
    if (typeof send !== "function") return;
    const previous = active.get(key);
    if (value.phase === "done") {
      discard(key);
      send(value);
      return;
    }
    const now = Date.now();
    if (!previous || previous.phase !== value.phase || now - previous.sentAt >= intervalMs) {
      discard(key);
      if (previous?.latest && previous.phase !== value.phase) send(previous.latest);
      active.set(key, { phase: value.phase, sentAt: now, timer: null, latest: null });
      send(value);
      return;
    }
    previous.latest = value;
    if (previous.timer) return;
    previous.timer = setTimeout(() => {
      previous.timer = null;
      previous.sentAt = Date.now();
      const latest = previous.latest; previous.latest = null;
      send(latest);
    }, Math.max(0, intervalMs - (now - previous.sentAt)));
    previous.timer.unref?.();
  }
  return { report, clear() { for (const key of active.keys()) discard(key); },
    get size() { return active.size; } };
}

module.exports = { createProgressReporter };
