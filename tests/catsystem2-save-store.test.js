const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createSaveStore } = require("../src/modules/catsystem2/runtime/save-store");
test("CatSystem stored data distinguishes absence, preserves originals and rejects path aliases", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-state-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = await createSaveStore({ directory }); assert.equal(await store.read("savegen.dat"), null);
  const file = path.join(directory, "savegen.dat"), bytes = Buffer.from("CSS\0bounded original"); fs.writeFileSync(file, bytes); const before = fs.statSync(file);
  assert.deepEqual(await store.read("savegen.dat"), bytes); const after = fs.statSync(file);
  for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(before[key], after[key]);
  await assert.rejects(store.read("../savegen.dat"), /unsafe/); fs.symlinkSync(file, path.join(directory, "alias.dat")); await assert.rejects(store.read("alias.dat"), /regular paths/);
  const original = path.join(directory, "original"); fs.mkdirSync(original); fs.writeFileSync(path.join(original, "savegen.dat"), bytes);
  const duplicate = await createSaveStore({ directory, originalDirectories: [original] }); await assert.rejects(duplicate.read("savegen.dat"), /ambiguous/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(createSaveStore({ directory, signal: abort.signal }), /abort/i);
});
test("CatSystem stored-data writes are atomic, bounded and confined to the state root", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-write-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, "state"), original = path.join(base, "original"); fs.mkdirSync(directory); fs.mkdirSync(original);
  const originalFile = path.join(original, "savegen.dat"), bytes = Buffer.from("original"); fs.writeFileSync(originalFile, bytes); const before = fs.statSync(originalFile);
  const store = await createSaveStore({ directory, originalDirectories: [original] });
  assert.equal(await store.write("nested\\new.dat", Buffer.from("first")), true); assert.deepEqual(await store.read("nested/new.dat"), Buffer.from("first"));
  assert.equal(await store.write("nested/new.dat", Buffer.from("second")), true); assert.deepEqual(await store.read("nested/new.dat"), Buffer.from("second"));
  assert.deepEqual(fs.readdirSync(path.join(directory, "nested")), ["new.dat"]); assert.equal(fs.statSync(path.join(directory, "nested/new.dat")).mode & 0o777, 0o600);
  fs.symlinkSync(original, path.join(directory, "linked")); await assert.rejects(store.write("linked/savegen.dat", Buffer.from("changed")), /regular directories/);
  fs.symlinkSync(originalFile, path.join(directory, "alias.dat")); await assert.rejects(store.write("alias.dat", Buffer.from("changed")), /regular file/);
  await assert.rejects(store.write("../original/savegen.dat", Buffer.from("changed")), /unsafe/); await assert.rejects(store.write("large.dat", Buffer.alloc(16777217)), /limit/);
  assert.deepEqual(fs.readFileSync(originalFile), bytes); const after = fs.statSync(originalFile); for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(before[key], after[key]);
  const abort = new AbortController(), aborted = await createSaveStore({ directory, signal: abort.signal }); abort.abort(); await assert.rejects(aborted.write("cancelled.dat", bytes), /abort/i);
  assert.equal(fs.existsSync(path.join(directory, "cancelled.dat")), false);
});
test("CatSystem stored-data removal checks nested paths and session cancellation", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catsystem-remove-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = await createSaveStore({ directory }); await store.write("nested/data.dat", Buffer.from("private state"));
  assert.equal(await store.remove("nested\\data.dat"), true); assert.equal(await store.read("nested/data.dat"), null);
  assert.equal(await store.remove("absent/data.dat"), false);
  fs.symlinkSync(path.join(directory, "nested"), path.join(directory, "alias")); await assert.rejects(store.remove("alias/data.dat"), /regular paths/);
  const abort = new AbortController(), cancelled = await createSaveStore({ directory, signal: abort.signal });
  await cancelled.write("retained.dat", Buffer.from("retained")); abort.abort(); await assert.rejects(cancelled.remove("retained.dat"), /abort/i);
  assert.equal(fs.readFileSync(path.join(directory, "retained.dat"), "utf8"), "retained");
});
