const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createSaveSlots, slotName } = require("../src/modules/catsystem2/runtime/save-slots");
const { createSaveStore } = require("../src/modules/catsystem2/runtime/save-store");
const { encodeStoredData } = require("../src/modules/catsystem2/runtime/data-records");

async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-slots-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, "state"), original = path.join(base, "original"); fs.mkdirSync(directory); fs.mkdirSync(original);
  const store = await createSaveStore({ directory, originalDirectories: [original] });
  const slots = createSaveSlots({ engineVersion: "2.6.1.76", store }); return { directory, original, store, slots };
}
test("CSS save slots distinguish absence and inclusive engine-authored version bounds", async t => {
  const { store, slots } = await setup(t), bytes = await encodeStoredData({ version: 19, records: new Map([[1, Buffer.from("saved flags")]]) });
  assert.equal(await slots.exists(7), 0); await store.write("save0007.dat", bytes);
  assert.equal(await slots.exists(7), 1); assert.equal(await slots.exists(7, 19), 1); assert.equal(await slots.exists(7, 18, 20), 1);
  assert.equal(await slots.exists(7, 20, 21), -1); assert.equal(await slots.exists(7, 17, 18), -1);
  for (const args of [[7, 20, 19], [7, -1, 19], [7, -2, -2], [7, NaN, 20]]) await assert.rejects(() => slots.exists(...args), /version range/);
  await store.write("save0008.dat", Buffer.from("CSS\0invalid")); await assert.rejects(slots.exists(8), /stored-data header/);
  assert.equal(slotName(7000), "save7000.dat"); assert.equal(slotName(10000), "save10000.dat");
  for (const value of [-1, 1.5, NaN, 0x80000000, "../1"]) assert.throws(() => slotName(value), /slot exceeds/);
  assert.throws(() => createSaveSlots({ engineVersion: "2.6.1", store }), /version is unsupported/);
});
test("CSS slot copy preserves exact record bytes and removal never changes original saves", async t => {
  const { directory, original, store, slots } = await setup(t), bytes = await encodeStoredData({ version: 9, records: new Map([[2, Buffer.from([0, 255, 7])]]) });
  const file = path.join(original, "save0001.dat"); fs.writeFileSync(file, bytes); const before = fs.statSync(file);
  assert.equal(await slots.copy(1, 2), true); assert.deepEqual(fs.readFileSync(path.join(directory, "save0002.dat")), bytes);
  assert.equal(await slots.copy(2, 2), true); assert.equal(await slots.copy(3, 4), false);
  assert.equal(await slots.remove(2), true); assert.equal(await slots.exists(2), 0); assert.equal(await slots.remove(2), false);
  await assert.rejects(slots.remove(1), /Original.*read-only/);
  fs.symlinkSync(file, path.join(directory, "save0005.dat")); await assert.rejects(slots.remove(5), /regular paths/); await assert.rejects(slots.copy(5, 6), /regular paths/);
  await assert.rejects(store.remove("../original/save0001.dat"), /unsafe/);
  assert.deepEqual(fs.readFileSync(file), bytes); const after = fs.statSync(file); for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(after[key], before[key]);
});
test("CSS save-slot cancellation prevents file changes", async t => {
  const { store, directory } = await setup(t), abort = new AbortController(), slots = createSaveSlots({ engineVersion: "2.6.1.76", store, signal: abort.signal });
  await store.write("save0001.dat", await encodeStoredData({ version: 1, records: new Map() })); abort.abort();
  for (const operation of [() => slots.exists(1), () => slots.copy(1, 2), () => slots.remove(1)]) await assert.rejects(operation, /abort/i);
  assert.deepEqual(fs.readdirSync(directory), ["save0001.dat"]);
});
