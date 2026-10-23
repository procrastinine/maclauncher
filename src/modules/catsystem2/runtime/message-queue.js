const LIMITS = Object.freeze({ messages: 512 });
function words(values) {
  if (!Array.isArray(values) || values.length !== 4 || values.some(value => !Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff))
    throw new Error("A bounded four-word KCS message is required."); return values.map(value => value >>> 0);
}
/** The original host message record is sender, message, parameter1, parameter2. */
function createMessageQueue() {
  const pending = [];
  function enqueue(record) { const message = words(record); if (pending.length >= LIMITS.messages) throw new Error("The KCS message queue exceeds its limit."); pending.push(message); }
  function deliver(machine) {
    if (!pending.length || machine?.suspended?.kind !== "message") return false;
    machine.resumeMessage(pending[0]); pending.shift(); return true;
  }
  return { enqueue, deliver, get size() { return pending.length; } };
}
module.exports = { LIMITS, words, createMessageQueue };
