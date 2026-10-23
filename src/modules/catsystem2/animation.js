const VERSION = "1.0.0-ml1", LIMITS = Object.freeze({ timelines: 65536, storedBytes: 32 + 65536 * 68 });
const COUNTS = Object.freeze([3,3,2,1,2,3,3,3,3,3,3,1,1,1,2,2,2,2]);

/** ANM timeline records; lengths and parameter roles follow the binary format. */
function inspectAnimation(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > LIMITS.storedBytes || bytes.toString("ascii", 0, 4) !== "ANM\0" ||
      bytes.readUInt32LE(4) !== 0 || bytes.subarray(12,32).some(Boolean)) throw new Error("This ANM header profile is unsupported.");
  const count = bytes.readUInt32LE(8);
  if (!count || count > LIMITS.timelines || bytes.length !== 32 + count * 68) throw new Error("ANM timeline lengths exceed their declared bounds.");
  const timelines = [];
  for (let index = 0; index < count; index++) {
    const offset = 32 + index * 68, command = bytes.readUInt32LE(offset), parameters = [];
    if (command >= COUNTS.length) throw new Error(`ANM command ${command} is unsupported.`);
    for (let at = 0; at < 8; at++) {
      const type = bytes.readUInt32LE(offset + 4 + at * 8), value = bytes.readInt32LE(offset + 8 + at * 8);
      if (![0,1,2].includes(type) || type === 1 && (value < 0 || value >= 64) || at >= COUNTS[command] && (type || value))
        throw new Error("This ANM parameter profile is unsupported.");
      if (at < COUNTS[command]) parameters.push(Object.freeze({ type, value }));
    }
    timelines.push(Object.freeze({ index, command, parameters: Object.freeze(parameters) }));
  }
  return Object.freeze({ format: "ANM", parserVersion: VERSION, storedBytes: bytes.length, timelineCount: count, timelines: Object.freeze(timelines) });
}
module.exports = { VERSION, LIMITS, COUNTS, inspectAnimation };
