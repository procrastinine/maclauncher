const { LIMITS: MOTION, OFFSET } = require("./motion-vm");

const VERSION = "2.6.1.76";
const LIMITS = Object.freeze({ controllers: 512, issuedHandles: 65536, objectBytes: MOTION.objectBytes });

/** The original motion container holds an ordered program set and two object states. */
function createMotionControllers({ engineVersion } = {}) {
  if (engineVersion !== VERSION) throw new Error("This KCS motion-controller version is unsupported.");
  const records = new Map(); let nextHandle = 0x30000000, issued = 0, closed = false;
  function lookup(id) {
    const record = records.get(id);
    if (closed || !record) throw new Error("The KCS motion-controller handle is invalid.");
    return record;
  }
  function create() {
    if (closed || records.size >= LIMITS.controllers || issued >= LIMITS.issuedHandles)
      throw new Error("KCS motion controllers exceed their session limit.");
    const bytes = Buffer.alloc(LIMITS.objectBytes);
    // The constructor initializes a 4x4 identity matrix, unit scale, opaque
    // white color and the final enabled flag. Coordinates start at zero.
    for (let index = 0; index < 16; index++) bytes.writeFloatLE(index % 5 === 0 ? 1 : 0, 0x24 + index * 4);
    for (let offset = OFFSET.scale; offset < OFFSET.scale + 12; offset += 4) bytes.writeFloatLE(1, offset);
    bytes.writeUInt32LE(0xffffffff, OFFSET.color); bytes.writeUInt32LE(1, 0x8c);
    const id = nextHandle++; issued++;
    records.set(id, { id, bytes, evaluated: null, programs: new Map(), enabled: true, rate: 1, dataMode: 0 });
    return id;
  }
  function remove(id) {
    const record = lookup(id); record.programs.clear(); records.delete(id);
  }
  function clear(id) { lookup(id).programs.clear(); }
  function setDataMode(id, mode) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 1) throw new Error("This KCS motion data mode is unsupported.");
    // Native field134 is forwarded to new motion programs' external field4a4.
    lookup(id).dataMode = mode;
  }
  function restore(id) {
    const record = lookup(id);
    if (!Buffer.isBuffer(record.evaluated) || record.evaluated.length !== LIMITS.objectBytes)
      throw new Error("The KCS motion controller has no evaluated object state.");
    record.evaluated.copy(record.bytes);
  }
  function close() { if (closed) return; for (const record of records.values()) record.programs.clear(); records.clear(); closed = true; }
  return { version: VERSION, records, lookup, create, remove, clear, setDataMode, restore, close };
}

module.exports = { VERSION, LIMITS, createMotionControllers };
