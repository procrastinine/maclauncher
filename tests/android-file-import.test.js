const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Android = require("../src/modules/android/main");
const { storagePaths, prepareStorage } = require("../src/modules/android/storage");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { gameId: "owned-game" }, context = { userDataDir: path.join(root, "state") };
  const paths = storagePaths(context.userDataDir, entry.gameId);
  const source = path.join(root, "source.txt"); fs.writeFileSync(source, "original bytes");
  return { root, entry, context, paths, source, imports: path.join(paths.filesRoot, "imports") };
}
const run = (f, files, context = f.context) => Android.actions.importFiles(f.entry, { filePaths: files }, context);
const temporaryFiles = root => fs.readdirSync(root).filter(name => name.startsWith(".file-import-"));

test("Android inspector copies selected files privately and preserves originals and collisions", async t => {
  const f = fixture(t), before = fs.statSync(f.source);
  const first = await run(f, [f.source]);
  assert.equal(first.count, 1); assert.equal(first.directory, f.imports);
  const copied = path.join(f.imports, "source.txt");
  assert.equal(fs.readFileSync(copied, "utf8"), "original bytes");
  assert.notEqual(fs.statSync(copied).ino, before.ino);
  assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
  fs.writeFileSync(copied, "keep existing import");
  assert.deepEqual((await run(f, [f.source])).files, ["source (2).txt"]);
  assert.equal(fs.readFileSync(copied, "utf8"), "keep existing import");
  assert.equal(fs.readFileSync(path.join(f.imports, "source (2).txt"), "utf8"), "original bytes");
  assert.equal(fs.statSync(f.source).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(f.source).ctimeMs, before.ctimeMs);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original bytes");
  assert.deepEqual(temporaryFiles(f.paths.root), []);
  assert.ok(Android.manifest.ui.actions.some(action => action.id === "importFiles"));
});

test("Android file selection supports native picker cancellation and rejects active games before selecting", async t => {
  const f = fixture(t); let options;
  const context = { ...f.context, ui: { dialog: { showOpenDialog: async value => { options = value; return { canceled: true }; } } } };
  assert.deepEqual(await Android.actions.importFiles(f.entry, {}, context), { canceled: true });
  assert.deepEqual(options.properties, ["openFile", "multiSelections", "noResolveAliases"]);
  assert.equal(fs.existsSync(f.paths.root), false);
  context.isGameRunning = () => true;
  context.ui.dialog.showOpenDialog = () => assert.fail("Must not show picker for running game");
  await assert.rejects(Android.actions.importFiles(f.entry, {}, context), /Quit.*before importing/);
  assert.deepEqual(await run(f, []), { canceled: true });
  await assert.rejects(run(f, ["relative"]), /absolute file paths/);
});

test("Android imports reject source aliases, directories, duplicates and oversized selections", async t => {
  const f = fixture(t), link = path.join(f.root, "alias.txt"); fs.symlinkSync(f.source, link);
  await assert.rejects(run(f, [link]), /regular files/);
  await assert.rejects(run(f, [f.root]), /regular files/);
  await assert.rejects(run(f, [f.source, f.source]), /same file/);
  await assert.rejects(run(f, Array(129).fill(f.source)), /128 files/);
  const large = path.join(f.root, "large"); fs.writeFileSync(large, ""); fs.truncateSync(large, 1024 ** 3 + 1);
  await assert.rejects(run(f, [large]), /1 GiB/);
  const files = Array.from({ length: 5 }, (_, i) => {
    const file = path.join(f.root, `sparse-${i}`); fs.writeFileSync(file, ""); fs.truncateSync(file, 1024 ** 3); return file;
  });
  await assert.rejects(run(f, files), /4 GiB/);
  assert.equal(fs.existsSync(f.paths.root), false);
});

test("Android imports reject an aliased destination and never overwrite a leaf alias", async t => {
  const f = fixture(t); await prepareStorage(f.entry, f.context.userDataDir);
  const external = path.join(f.root, "outside"); fs.mkdirSync(external);
  fs.symlinkSync(external, f.imports);
  await assert.rejects(run(f, [f.source]), /aliases/);
  assert.deepEqual(fs.readdirSync(external), []);
  fs.unlinkSync(f.imports); fs.mkdirSync(f.imports);
  fs.symlinkSync(f.source, path.join(f.imports, "source.txt"));
  assert.deepEqual((await run(f, [f.source])).files, ["source (2).txt"]);
  assert.equal(fs.readFileSync(f.source, "utf8"), "original bytes");
  assert.equal(fs.lstatSync(path.join(f.imports, "source.txt")).isSymbolicLink(), true);
});

test("Android canceled or changed-file imports clean partial copies and release their operation", async t => {
  const f = fixture(t), controller = new AbortController();
  await assert.rejects(run(f, [f.source], { ...f.context, signal: controller.signal,
    onProgress: () => controller.abort() }), { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(f.imports), []);
  assert.deepEqual(temporaryFiles(f.paths.root), []);
  const second = path.join(f.root, "second.txt"); fs.writeFileSync(second, "before");
  await assert.rejects(run(f, [f.source, second], { ...f.context,
    onProgress: () => fs.writeFileSync(second, "changed contents") }), /changed before import/);
  assert.deepEqual(fs.readdirSync(f.imports), []);
  assert.deepEqual(temporaryFiles(f.paths.root), []);
  assert.equal((await run(f, [f.source])).count, 1);
});
