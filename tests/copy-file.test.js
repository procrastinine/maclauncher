const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const ChildProcess = require("node:child_process");
const { copyFileExclusive } = require("../src/modules/shared/copy-file");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copy-file-")), source = path.join(root, "source");
  fs.writeFileSync(source, crypto.randomBytes(65536), { mode: 0o640 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, target: path.join(root, "target") };
}
const noStages = root => assert.deepEqual(fs.readdirSync(root).filter(x => x.startsWith(".copy-")), []);

test("Exclusive copies preserve bytes and modes without sharing writable inodes", async t => {
  const { root, source, target } = fixture(t), original = fs.readFileSync(source);
  await copyFileExclusive(source, target, { validate: async staged => {
    assert.equal(fs.statSync(path.dirname(staged)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readFileSync(staged), original);
    assert.equal(fs.existsSync(target), false, "validation precedes publication");
  } });
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.notEqual(fs.statSync(source).ino, fs.statSync(target).ino);
  fs.writeFileSync(source, "source edit"); assert.deepEqual(fs.readFileSync(target), original);
  fs.writeFileSync(target, "destination edit"); assert.equal(fs.readFileSync(source, "utf8"), "source edit");
  noStages(root);
});

test("Exclusive publication preserves files, directories, symlinks and a competing creator", async t => {
  const { root, source, target } = fixture(t), file = path.join(root, "existing"), directory = path.join(root, "directory");
  fs.writeFileSync(file, "preserved"); fs.mkdirSync(directory);
  const alias = path.join(root, "alias"), dangling = path.join(root, "dangling");
  fs.symlinkSync(file, alias); fs.symlinkSync("absent", dangling);
  for (const existing of [file, directory, alias, dangling])
    await assert.rejects(copyFileExclusive(source, existing), { code: "EEXIST" });
  await assert.rejects(copyFileExclusive(source, target, { validate: async () => fs.writeFileSync(target, "competing creator", { flag: "wx" }) }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), "preserved"); assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(fs.readlinkSync(alias), file); assert.equal(fs.readlinkSync(dangling), "absent");
  assert.equal(fs.readFileSync(target, "utf8"), "competing creator"); noStages(root);
});

test("Validation failure and cancellation remove private copies before publication", async t => {
  const { root, source, target } = fixture(t), failed = new Error("invalid bytes");
  await assert.rejects(copyFileExclusive(source, target, { validate: async () => { throw failed; } }), error => error === failed);
  const before = new AbortController(); before.abort();
  await assert.rejects(copyFileExclusive(source, target, { signal: before.signal }), { name: "AbortError" });
  const during = new AbortController();
  await assert.rejects(copyFileExclusive(source, target, { signal: during.signal, validate: async () => during.abort() }), { name: "AbortError" });
  const publishing = new AbortController(), link = fs.promises.link.bind(fs.promises);
  t.mock.method(fs.promises, "link", async (...args) => { await link(...args); publishing.abort(); });
  await assert.rejects(copyFileExclusive(source, target, { signal: publishing.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(target), false); noStages(root);
});

test("Native copy failures and cancellation wait for the owned child before cleanup", { skip: process.platform !== "darwin", timeout: 10000 }, async t => {
  const { root, source, target } = fixture(t), spawn = ChildProcess.spawn, children = [];
  let cancel, closed;
  t.after(() => children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }));
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    assert.equal(command, "/bin/cp"); closed = false;
    const code = 'require("fs").writeFileSync(process.argv[1],"partial");process.stderr.write("copy-ready\\n");' +
      (cancel ? 'setInterval(()=>{},1000);' : 'process.exitCode=9;');
    const child = spawn(process.execPath, ["-e", code, args[2]], options); children.push(child);
    child.once("close", () => { closed = true; });
    if (cancel) child.stderr.once("data", () => cancel.abort());
    return child;
  });
  await assert.rejects(copyFileExclusive(source, target), { code: "COPY_FAILED", exitCode: 9 });
  assert.equal(closed, true); assert.equal(fs.existsSync(target), false); noStages(root);
  cancel = new AbortController();
  await assert.rejects(copyFileExclusive(source, target, { signal: cancel.signal }), { name: "AbortError" });
  assert.equal(closed, true); assert.equal(fs.existsSync(target), false); noStages(root);
});
