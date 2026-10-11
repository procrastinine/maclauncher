const test = require("node:test"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const { createDataRecords, decodeStoredData, encodeStoredData } = require("../src/modules/catsystem2/runtime/data-records");
test("CatSystem CSS records round-trip their exact opaque IDs/version/data and preserve original bytes", async () => {
  const store = createDataRecords(), id = store.create(36000), source = Buffer.from([1, 2, 3, 4]); store.put(id, 0x50, source); source[0] = 9;
  const bytes = await encodeStoredData(store.lookup(id)), preserved = Buffer.from(bytes), read = await decodeStoredData(bytes);
  assert.equal(read.version, 36000); assert.deepEqual(read.records.get(0x50), Buffer.from([1, 2, 3, 4])); assert.deepEqual(bytes, preserved);
  const other = createDataRecords(), copy = await other.load(bytes); store.put(id, 0x50, Buffer.from([5])); assert.deepEqual(other.lookup(copy).records.get(0x50), Buffer.from([1, 2, 3, 4]));
  store.remove(id, 0x50); assert.equal(store.lookup(id).records.size, 0); store.release(id); assert.throws(() => store.lookup(id), /handle/);
});
test("CatSystem CSS records reject trailing compressed bytes, truncated fields and duplicate identities", async () => {
  const stored = await encodeStoredData({ version: 1, records: new Map([[5, Buffer.from([1])]]) }); await assert.rejects(decodeStoredData(Buffer.concat([stored, Buffer.from([0])])), /header/);
  const invalid = Buffer.from(stored); invalid.writeUInt32LE(1, 8); await assert.rejects(decodeStoredData(invalid), /compression|extents/);
  const raw = Buffer.alloc(16); raw.writeUInt32LE(7); raw.writeUInt32LE(7, 8); const compressed = zlib.deflateSync(raw), duplicate = Buffer.alloc(16 + compressed.length);
  duplicate.write("CSS\0"); duplicate.writeUInt32LE(compressed.length, 4); duplicate.writeUInt32LE(raw.length, 8); compressed.copy(duplicate, 16);
  await assert.rejects(decodeStoredData(duplicate), /repeated/);
});
