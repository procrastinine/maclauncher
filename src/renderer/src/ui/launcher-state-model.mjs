// IPC clones every object, including unchanged games and release catalogs. Keep
// their identities so React's memoization and effect dependencies remain useful.
// Only plain launcher data is reconciled; opaque structured-clone values stay new.
export function shareLauncherValue(previous, incoming) {
  if (Object.is(previous, incoming)) return previous;
  if (!previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(previous) !== Array.isArray(incoming)) return incoming;
  if (Array.isArray(incoming)) {
    const identity = value => value && typeof value === "object"
      ? typeof value.gamePath === "string" ? `path:${value.gamePath}`
        : typeof value.id === "string" ? `id:${value.id}` : null
      : null;
    let byIdentity = null;
    if (incoming.some((value, index) => identity(value) && identity(value) !== identity(previous[index]))) {
      const entries = Array.from(previous, value => [identity(value), value]);
      const incomingKeys = Array.from(incoming, identity);
      const candidates = new Map(entries);
      if (!candidates.has(null) && candidates.size === previous.length
        && !incomingKeys.includes(null) && new Set(incomingKeys).size === incoming.length) byIdentity = candidates;
    }
    let equal = previous.length === incoming.length;
    let result = incoming;
    for (let index = 0; index < incoming.length; index += 1) {
      const before = byIdentity ? byIdentity.get(identity(incoming[index])) : previous[index];
      const shared = shareLauncherValue(before, incoming[index]);
      if (!Object.is(shared, previous[index]) || (index in previous) !== (index in incoming)) equal = false;
      if (!Object.is(shared, incoming[index])) {
        if (result === incoming) result = incoming.slice();
        result[index] = shared;
      }
    }
    return equal ? previous : result;
  }
  const plain = value => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if (!plain(previous) || !plain(incoming)) return incoming;
  const keys = Object.keys(incoming);
  let equal = Object.keys(previous).length === keys.length;
  let result = incoming;
  for (const key of keys) {
    const shared = shareLauncherValue(previous[key], incoming[key]);
    if (!Object.hasOwn(previous, key) || !Object.is(shared, previous[key])) equal = false;
    if (!Object.is(shared, incoming[key])) {
      if (result === incoming) result = { ...incoming };
      result[key] = shared;
    }
  }
  return equal ? previous : result;
}

export function updatePathValue(values, gamePath, value) {
  const shared = shareLauncherValue(values[gamePath], value);
  return Object.hasOwn(values, gamePath) && Object.is(shared, values[gamePath])
    ? values : { ...values, [gamePath]: shared };
}

export function subscribeLauncherState(api, receive, fail) {
  let active = true;
  let receivedBroadcast = false;
  const unsubscribe = api.onState(next => {
    if (!active) return;
    receivedBroadcast = true;
    receive(next);
  });
  Promise.resolve().then(() => api.getState()).then(next => {
    if (active && !receivedBroadcast) receive(next);
  }).catch(error => {
    if (active && !receivedBroadcast) fail(error);
  });
  return () => { active = false; unsubscribe(); };
}

export function subscribeLauncherGameFailures(api, receive) {
  if (typeof api?.onGameFailed !== "function") return () => {};
  let active = true;
  const unsubscribe = api.onGameFailed(failure => {
    if (active && typeof failure?.message === "string" && failure.message.trim()) receive(failure.message);
  });
  return () => { active = false; unsubscribe(); };
}

// A status belongs to a game and its relevant inputs, rather than the current
// selection. Returning to an unchanged game reuses the existing request; failed
// requests can retry, and changed inputs cannot publish an older response.
export function createInspectionRequests() {
  const entries = new Map();
  return {
    run(gamePath, action, key, request) {
      const id = JSON.stringify([gamePath, action]);
      const existing = entries.get(id);
      const deliver = entry => entry.promise.then(value => ({ current: entries.get(id) === entry, value }));
      if (existing?.key === key) return deliver(existing);
      const entry = { gamePath, key, promise: null };
      entry.promise = Promise.resolve().then(request).catch(error => {
        if (entries.get(id) === entry) entries.delete(id);
        throw error;
      });
      entries.set(id, entry);
      return deliver(entry);
    },
    invalidate(gamePath, action) {
      for (const [id, entry] of entries) {
        if (entry.gamePath === gamePath && (!action || id === JSON.stringify([gamePath, action]))) entries.delete(id);
      }
    },
    retain(gamePaths) {
      const paths = new Set(gamePaths);
      for (const [id, entry] of entries) if (!paths.has(entry.gamePath)) entries.delete(id);
    }
  };
}
