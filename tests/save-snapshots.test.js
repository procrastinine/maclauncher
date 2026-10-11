const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const S = require("../src/modules/shared/save-snapshots");
const { createSaveService } = require("../src/core/save-service");
const Codec = require("../src/modules/shared/mvmz/rpgmaker-save");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maclauncher-snapshots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saveDir = path.join(root, "saves");
  fs.mkdirSync(saveDir);
  return { userDataDir: path.join(root, "data"), saveDir, entry: { gameId: "test-game", moduleId: "mv", defaultSaveDir: saveDir } };
}

test("snapshots preserve original bytes and metadata; restore keeps extra saves and makes recovery", t => {
  const opts = fixture(t);
  fs.mkdirSync(path.join(opts.saveDir, "nested"));
  fs.writeFileSync(path.join(opts.saveDir, "nested/slot.save"), Buffer.from([0, 128, 255]));
  const first = S.createSnapshot({ ...opts, reason: "manual" });
  fs.writeFileSync(path.join(opts.saveDir, "nested/slot.save"), "new");
  fs.writeFileSync(path.join(opts.saveDir, "extra.save"), "keep");
  const preview = S.previewRestore({ ...opts, snapshotId: first.id });
  assert.deepEqual(preview.changes.map(row => [row.name, row.operation]), [["nested/slot.save", "replace"]]);
  assert.deepEqual(preview.keptFiles, ["extra.save"]);
  const restored = S.restoreSnapshot({ ...opts, snapshotId: first.id, expectedStateHash: preview.expectedStateHash });
  assert.deepEqual(fs.readFileSync(path.join(opts.saveDir, "nested/slot.save")), Buffer.from([0, 128, 255]));
  assert.equal(fs.readFileSync(path.join(opts.saveDir, "extra.save"), "utf8"), "keep");
  assert.notEqual(restored.recoverySnapshotId, first.id);
  assert.equal(S.listSnapshots({ userDataDir: opts.userDataDir, gameId: opts.entry.gameId }).length, 2);
});

test("stale restore preview and tampered snapshot fail before any write", t => {
  const opts = fixture(t), file = path.join(opts.saveDir, "slot.save");
  fs.writeFileSync(file, "original");
  const snapshot = S.createSnapshot(opts);
  const preview = S.previewRestore({ ...opts, snapshotId: snapshot.id });
  fs.writeFileSync(file, "game changed");
  assert.throws(() => S.restoreSnapshot({ ...opts, snapshotId: snapshot.id, expectedStateHash: preview.expectedStateHash }), /preview/);
  const saved = path.join(S.resolveSnapshotRoot(opts.userDataDir, opts.entry.gameId), snapshot.id, "files/slot.save");
  fs.chmodSync(saved, 0o600);
  fs.writeFileSync(saved, "tampered");
  assert.throws(() => S.previewRestore({ ...opts, snapshotId: snapshot.id }), /checksum/);
  assert.equal(fs.readFileSync(file, "utf8"), "game changed");
});

test("symlinks, traversal, oversized files and backup failures leave saves alone", t => {
  const opts = fixture(t), file = path.join(opts.saveDir, "slot.save");
  fs.writeFileSync(file, "original");
  fs.symlinkSync(file, path.join(opts.saveDir, "linked.save"));
  assert.throws(() => S.createSnapshot(opts), /symlink/);
  fs.rmSync(path.join(opts.saveDir, "linked.save"));
  assert.throws(() => S.collectFiles(opts.saveDir, { limits: { ...S.LIMITS, fileBytes: 1 } }), /size limit/);
  for (const name of ["../outside", "/outside", "nested/../outside", "a\\b"]) assert.throws(() => S.relativeName(name), /relative/);
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (String(target).includes(".pending-")) throw Object.assign(new Error("No space"), { code: "ENOSPC" });
    return originalWrite(target, ...args);
  });
  assert.throws(() => S.createSnapshot(opts), /No space/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(S.resolveSnapshotRoot(opts.userDataDir, opts.entry.gameId)), []);
});

test("a mid-batch replacement failure rolls back earlier writes and cleans staging", t => {
  const opts = fixture(t);
  fs.writeFileSync(path.join(opts.saveDir, "a.save"), "a-original");
  fs.writeFileSync(path.join(opts.saveDir, "b.save"), "b-original");
  const expectedStateHash = S.stateHash(S.collectFiles(opts.saveDir));
  const rename = fs.renameSync;
  let replacements = 0;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (source.includes(".maclauncher-restore-") && ++replacements === 2) throw new Error("Interrupted write");
    return rename(source, destination);
  });
  assert.throws(() => S.replaceFiles({ ...opts, expectedStateHash, files: [
    { name: "a.save", bytes: Buffer.from("a-new") }, { name: "b.save", bytes: Buffer.from("b-new") }
  ] }), /Interrupted/);
  assert.equal(fs.readFileSync(path.join(opts.saveDir, "a.save"), "utf8"), "a-original");
  assert.equal(fs.readFileSync(path.join(opts.saveDir, "b.save"), "utf8"), "b-original");
  assert.deepEqual(fs.readdirSync(opts.saveDir), ["a.save", "b.save"]);
});

test("JSON edits require a matching source hash, block a running game, and snapshot before replacement", async t => {
  const opts = fixture(t), file = path.join(opts.saveDir, "slot.rmmzsave");
  opts.entry.moduleId = "mz";
  const original = '{"party":{"_gold":1},"plugin":-0}';
  fs.writeFileSync(file, Codec.encodeSave("mz", original), "utf8");
  let running = false;
  const service = createSaveService({ ...opts, registry: {
    getModule: () => ({ save: { extensions: ["rmmzsave"], decode: raw => Codec.decodeSave("mz", raw), encode: json => Codec.encodeSave("mz", json) } }),
    getModuleInfo: () => ({ supports: { saveEditing: true } })
  }, isGameRunning: () => running });
  const read = await service.runAction(opts.entry, "readSaveDocument", { fileName: "slot.rmmzsave" });
  running = true;
  await assert.rejects(service.runAction(opts.entry, "writeSaveDocument", { fileName: read.fileName, expectedHash: read.sourceHash, json: original }), /Stop the game/);
  running = false;
  await assert.rejects(service.runAction(opts.entry, "writeSaveDocument", { fileName: read.fileName, expectedHash: "stale", json: original }), /Reload/);
  const updated = original.replace('"_gold":1', '"_gold":2');
  const written = await service.runAction(opts.entry, "writeSaveDocument", { fileName: read.fileName, expectedHash: read.sourceHash, json: updated });
  assert.ok(written.snapshotId);
  assert.equal(Codec.decodeSave("mz", fs.readFileSync(file, "utf8")), updated);
  assert.equal(Codec.decodeSave("mz", fs.readFileSync(file + ".maclauncher.bak", "utf8")), original);
});

test("save imports make recovery snapshots and reject duplicate basenames before writing", async t => {
  const opts = fixture(t), root = path.dirname(opts.saveDir);
  fs.writeFileSync(path.join(opts.saveDir, "slot.save"), "old");
  const source = path.join(root, "slot.save");
  fs.writeFileSync(source, "imported");
  const service = createSaveService({ ...opts, registry: { getModule: () => ({ save: { extensions: ["save"] } }) } });
  await assert.rejects(service.runAction(opts.entry, "importSaveFiles", { filePaths: [source, source] }), /Duplicate/);
  assert.equal(fs.readFileSync(path.join(opts.saveDir, "slot.save"), "utf8"), "old");
  const result = await service.runAction(opts.entry, "importSaveFiles", { filePaths: [source] });
  assert.equal(result.imported, 1);
  assert.ok(result.snapshotId);
  assert.equal(fs.readFileSync(path.join(opts.saveDir, "slot.save"), "utf8"), "imported");
});

test("concurrent later-file writes abort a restore and roll back earlier replacements", t => {
  const opts = fixture(t);
  const a = path.join(opts.saveDir, "a.save"), b = path.join(opts.saveDir, "b.save");
  fs.writeFileSync(a, "a-original"); fs.writeFileSync(b, "b-original");
  const expectedStateHash = S.stateHash(S.collectFiles(opts.saveDir));
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, dest) => {
    rename(source, dest);
    if (source.includes(".maclauncher-restore-") && dest === a) fs.writeFileSync(b, "concurrent-save");
  });
  assert.throws(() => S.replaceFiles({ ...opts, expectedStateHash, files: [
    { name: "a.save", bytes: Buffer.from("a-new") }, { name: "b.save", bytes: Buffer.from("b-new") }
  ] }), /changed during the transaction/);
  assert.equal(fs.readFileSync(a, "utf8"), "a-original");
  assert.equal(fs.readFileSync(b, "utf8"), "concurrent-save");
});

test("rollback preserves a concurrent write to an already replaced save", t => {
  const opts = fixture(t), a = path.join(opts.saveDir, "a.save"), b = path.join(opts.saveDir, "b.save");
  fs.writeFileSync(a, "a-original"); fs.writeFileSync(b, "b-original");
  const expectedStateHash = S.stateHash(S.collectFiles(opts.saveDir));
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, dest) => {
    if (source.includes(".maclauncher-restore-") && dest === b) {
      fs.writeFileSync(a, "concurrent-save");
      throw new Error("Interrupted");
    }
    return rename(source, dest);
  });
  assert.throws(() => S.replaceFiles({ ...opts, expectedStateHash, files: [
    { name: "a.save", bytes: Buffer.from("a-new") }, { name: "b.save", bytes: Buffer.from("b-new") }
  ] }), /rollback incomplete/);
  assert.equal(fs.readFileSync(a, "utf8"), "concurrent-save");
  assert.equal(fs.readFileSync(b, "utf8"), "b-original");
});

test("the generic save editor rejects recovery files and forwards decompression limits", async t => {
  const opts = fixture(t), file = path.join(opts.saveDir, "slot.save");
  fs.writeFileSync(file, "encoded"); fs.writeFileSync(file + ".maclauncher.bak", "recovery");
  const service = createSaveService({ ...opts, registry: {
    getModule: () => ({ save: { extensions: ["save"], decode: (_raw, config) => {
      assert.equal(config.maxOutputBytes, S.LIMITS.fileBytes);
      throw new Error("Expansion refused");
    }, encode: value => value } }), getModuleInfo: () => ({ supports: { saveEditing: true } })
  } });
  await assert.rejects(service.runAction(opts.entry, "readSaveDocument", { fileName: "slot.save.maclauncher.bak" }), /sidecars/);
  await assert.rejects(service.runAction(opts.entry, "readSaveDocument", { fileName: "slot.save" }), /Expansion refused/);
  const originalRead = fs.readSync;
  let reads = 0;
  t.mock.method(fs, "readSync", (...args) => { reads++; return originalRead(...args); });
  await assert.rejects(service.runAction(opts.entry, "importSaveFiles", { filePaths: [file, file] }), /Duplicate/);
  assert.equal(reads, 0);
});
