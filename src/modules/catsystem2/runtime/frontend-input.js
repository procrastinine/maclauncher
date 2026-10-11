const LIMITS = Object.freeze({ eventsPerFrame: 256, coordinate: 1048576 });
const KEY_BUTTON = Object.freeze({ Enter: 0, Space: 0, Escape: 2 });

/** Bounded native viewport events, consumed once by the authored front end. */
function createInputQueue() {
  const events = [], pressed = new Set(); let pointer = null, closed = false;
  function enqueue(event) {
    if (closed || !event || typeof event !== "object" || Array.isArray(event)) throw new Error("CatSystem2 input is unavailable.");
    if (events.length >= LIMITS.eventsPerFrame) throw new Error("CatSystem2 input exceeds its frame limit.");
    if (event.type === "pointer") {
      if (!["move", "down", "up"].includes(event.kind) || ![event.x, event.y].every(value => Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate) ||
          event.kind !== "move" && ![0, 1, 2].includes(event.button)) throw new Error("Invalid native CatSystem2 pointer event.");
      events.push({ type: "pointer", kind: event.kind, x: Math.floor(event.x), y: Math.floor(event.y), button: event.button });
    } else if (event.type === "key") {
      if (!["down", "up"].includes(event.kind) || typeof event.key !== "string" || !event.key || event.key.length > 32 || typeof event.repeat !== "boolean")
        throw new Error("Invalid native CatSystem2 key event.");
      events.push({ type: "key", kind: event.kind, key: event.key, repeat: event.repeat });
    } else throw new Error("This native CatSystem2 input event is unsupported.");
  }
  function drain() {
    if (closed) throw new Error("CatSystem2 input is closed.");
    const actions = [];
    for (const event of events.splice(0)) {
      if (event.type === "pointer") {
        pointer = { x: event.x, y: event.y };
        if (event.kind !== "move") actions.push({ type: "button", kind: event.kind, button: event.button, pointer: { ...pointer }, keyboard: false });
      } else {
        if (event.kind === "down") { if (event.repeat || pressed.has(event.key)) continue; pressed.add(event.key); }
        else { if (!pressed.delete(event.key)) continue; }
        if (Object.hasOwn(KEY_BUTTON, event.key)) actions.push({ type: "button", kind: event.kind, button: KEY_BUTTON[event.key], keyboard: true });
        else if (event.kind === "down" && /^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) actions.push({ type: "navigate", direction: event.key.slice(5) });
      }
    }
    return { pointer: pointer && { ...pointer }, actions };
  }
  function close() { closed = true; events.length = 0; pressed.clear(); }
  return { enqueue, drain, close };
}
module.exports = { LIMITS, KEY_BUTTON, createInputQueue };
