// One synchronous read of installed runtimes. A manager's state, its
// selections and a translator inventory consult the same installed versions
// many times over; inside a pass each owner reads a value once. The pass ends
// when the outermost synchronous call returns, so a later call, an awaited
// continuation or another job reads the files again.
let current = null;

function within(action) {
  if (current) return action();
  current = new Map();
  try { return action(); } finally { current = null; }
}

// The value for an owner's key in the current pass, computed once. Outside a
// pass every call computes. A failure is not kept.
function remember(owner, key, compute) {
  if (!current) return compute();
  let values = current.get(owner);
  if (!values) current.set(owner, values = new Map());
  if (values.has(key)) return values.get(key);
  const value = compute();
  values.set(key, value);
  return value;
}

// A write inside a pass makes earlier reads stale.
function forget() { current?.clear(); }

const active = () => current !== null;

module.exports = { within, remember, forget, active };
