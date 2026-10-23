const zlib = require("node:zlib"), { promisify } = require("node:util");
const inflate = promisify(zlib.inflate), deflate = promisify(zlib.deflate);
const LIMITS = Object.freeze({ handles: 256, records: 4096, bytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });

function integer(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
/** CSS v1 stores an opaque version and bounded ID/length/data records. */
async function decodeStoredData(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > LIMITS.bytes || bytes.toString("ascii", 0, 4) !== "CSS\0" ||
      bytes.readUInt32LE(4) !== bytes.length - 16 || bytes.readUInt32LE(8) > LIMITS.bytes) throw new Error("CatSystem2 stored-data header is unsupported or oversized.");
  const length = bytes.readUInt32LE(8); let decoded;
  try { decoded = await inflate(bytes.subarray(16), { maxOutputLength: Math.max(1, length), info: true }); } catch { throw new Error("CatSystem2 stored-data compression is invalid."); }
  if (decoded.buffer.length !== length || decoded.engine.bytesWritten !== bytes.length - 16) throw new Error("CatSystem2 stored-data extents disagree.");
  const records = new Map(); let offset = 0;
  while (offset < length) {
    if (offset > length - 8 || records.size >= LIMITS.records) throw new Error("CatSystem2 stored-data records exceed their bounds.");
    const id = decoded.buffer.readUInt32LE(offset), size = decoded.buffer.readUInt32LE(offset + 4); offset += 8;
    if (size > length - offset || records.has(id)) throw new Error("CatSystem2 stored-data record is repeated or truncated.");
    records.set(id, Buffer.from(decoded.buffer.subarray(offset, offset + size))); offset += size;
  }
  return { version: bytes.readUInt32LE(12), records };
}
async function encodeStoredData(record) {
  if (!integer(record?.version) || !(record.records instanceof Map) || record.records.size > LIMITS.records) throw new Error("Bounded CatSystem2 data records are required.");
  const chunks = []; let bytes = 0;
  for (const [id, data] of record.records) {
    if (!integer(id) || !Buffer.isBuffer(data) || (bytes += data.length + 8) > LIMITS.bytes) throw new Error("CatSystem2 stored-data records exceed their bounds.");
    const header = Buffer.alloc(8); header.writeUInt32LE(id); header.writeUInt32LE(data.length, 4); chunks.push(header, data);
  }
  const compressed = await deflate(Buffer.concat(chunks, bytes)); if (compressed.length > LIMITS.bytes - 16) throw new Error("CatSystem2 compressed stored data exceeds its limit.");
  const header = Buffer.alloc(16); header.write("CSS\0"); header.writeUInt32LE(compressed.length, 4); header.writeUInt32LE(bytes, 8); header.writeUInt32LE(record.version, 12);
  return Buffer.concat([header, compressed]);
}
function createDataRecords() {
  const handles = new Map(); let next = 0x10000, totalBytes = 0;
  function lookup(id) { const record = handles.get(id); if (!record) throw new Error("KCS data-record handle is absent."); return record; }
  function create(version) {
    if (!integer(version) || handles.size >= LIMITS.handles || next > 0x7fffffff) throw new Error("KCS data-record allocation exceeds its limit.");
    const id = next++; handles.set(id, { version, records: new Map(), bytes: 0 }); return id;
  }
  function put(handle, id, source) {
    const target = lookup(handle); if (!integer(id) || !Buffer.isBuffer(source)) throw new Error("KCS data records require bounded IDs and bytes.");
    const previous = target.records.get(id), change = source.length + 8 - (previous ? previous.length + 8 : 0);
    if (target.records.size + Number(!previous) > LIMITS.records || target.bytes + change > LIMITS.bytes || totalBytes + change > LIMITS.totalBytes)
      throw new Error("KCS data records exceed their storage limit.");
    target.records.delete(id); target.records.set(id, Buffer.from(source)); target.bytes += change; totalBytes += change;
  }
  function remove(handle, id) { const target = lookup(handle), data = target.records.get(id); if (data) { const count = data.length + 8; target.records.delete(id); target.bytes -= count; totalBytes -= count; } }
  function release(handle) { const target = lookup(handle); totalBytes -= target.bytes; handles.delete(handle); }
  async function load(bytes) { const record = await decodeStoredData(bytes), id = create(record.version); try { for (const [key, value] of record.records) put(id, key, value); return id; } catch (error) { release(id); throw error; } }
  return { lookup, create, put, remove, release, load };
}
module.exports = { LIMITS, decodeStoredData, encodeStoredData, createDataRecords };
