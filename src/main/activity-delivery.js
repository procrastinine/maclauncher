// A slow renderer retains at most its current IPC message and the newest
// pending activity snapshot. Intermediate progress has no lasting value.
function createActivityDelivery(send) {
  const receivers = new Map();
  let sequence = 0;
  function transmit(receiver, state, activity) {
    const message = { sequence: ++sequence, activity };
    state.inFlight = message.sequence;
    try { send(receiver, message); }
    catch { receivers.delete(receiver); }
  }
  return {
    ready(receiver, activity) {
      const state = { inFlight: null, pending: null };
      receivers.set(receiver, state);
      transmit(receiver, state, activity);
    },
    publish(receiver, activity) {
      const state = receivers.get(receiver);
      if (!state) return;
      if (state.inFlight !== null) state.pending = activity;
      else transmit(receiver, state, activity);
    },
    acknowledge(receiver, received) {
      const state = receivers.get(receiver);
      if (!state || !Number.isSafeInteger(received) || received !== state.inFlight) return;
      state.inFlight = null;
      const latest = state.pending; state.pending = null;
      if (latest !== null) transmit(receiver, state, latest);
    },
    supersede(receiver) {
      const state = receivers.get(receiver);
      if (state) state.pending = null;
    },
    close(receiver) { receivers.delete(receiver); },
    get size() { return receivers.size; }
  };
}

module.exports = { createActivityDelivery };
