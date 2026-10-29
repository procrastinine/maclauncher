const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Python = require("../src/modules/shared/runtime/python");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveEvbunpackRoot retains the bundled upstream source helper", () => {
  const root = Python.resolveEvbunpackRoot();
  const expected = path.resolve(__dirname, "../src/external/evbunpack");
  assert.equal(root, expected);
});

test("resolveEvbunpackVenvDir builds the managed runtime path", () => {
  const userDataDir = "/path/to/Library/Application Support/maclauncher";
  const venvDir = Python.resolveEvbunpackVenvDir(userDataDir);
  assert.equal(
    venvDir,
    path.join(userDataDir, "runtimes", "python", "evbunpack", "venv")
  );
});

test("resolvePythonBinary prefers managed venv when present", () => {
  const userDataDir = makeTempDir("maclauncher-python-");
  try {
    const venvPython = path.join(
      userDataDir,
      "runtimes",
      "python",
      "evbunpack",
      "venv",
      "bin",
      "python3"
    );
    fs.mkdirSync(path.dirname(venvPython), { recursive: true });
    fs.writeFileSync(venvPython, "");
    const resolved = Python.resolvePythonBinary({ userDataDir });
    assert.equal(resolved.pythonPath, venvPython);
    assert.equal(resolved.source, "managed");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("buildEvbunpackCommand includes python module invocation", () => {
  const cmd = Python.buildEvbunpackCommand({ userDataDir: "/tmp" });
  assert.deepEqual(cmd.args, ["-B", "-m", "evbunpack"]);
  assert.equal(cmd.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.ok(cmd.env.PYTHONPATH.includes(cmd.evbunpackRoot));
});

test("resolveEmbeddedPythonBinary returns a path when bundled python exists", t => {
  const root = Python.resolveEmbeddedPythonRoot();
  if (!root) {
    t.skip();
    return;
  }
  const bin = Python.resolveEmbeddedPythonBinary(root);
  assert.ok(bin);
});

test("embedded Python acquisition rejects changed archives and symlink aliases", async t => {
  const { verifyArchive } = await import("../scripts/setup-python-runtime.mjs");
  const crypto = require("node:crypto"), root = makeTempDir("python-input-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "python.tar.gz"), bytes = Buffer.from("pinned runtime archive");
  const pin = { sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  fs.writeFileSync(archive, bytes); verifyArchive(archive, pin);
  const alias = path.join(root, "alias.tar.gz"); fs.symlinkSync(archive, alias);
  assert.throws(() => verifyArchive(alias, pin), /SHA-256/);
  fs.writeFileSync(archive, "changed runtime archive");
  assert.throws(() => verifyArchive(archive, pin), /SHA-256/);
});

test("embedded Python copies resolve executable aliases before build staging is removed", async t => {
  const { copyPythonTree } = await import("../scripts/setup-python-runtime.mjs");
  const root = makeTempDir("python-copy-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), destination = path.join(root, "output"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "python3.12"), "runtime executable", { mode: 0o755 });
  fs.symlinkSync("python3.12", path.join(source, "python3"));
  copyPythonTree(source, destination); fs.rmSync(source, { recursive: true });
  assert.equal(fs.lstatSync(path.join(destination, "python3")).isFile(), true);
  assert.equal(fs.readFileSync(path.join(destination, "python3"), "utf8"), "runtime executable");
  assert.equal(fs.statSync(path.join(destination, "python3")).mode & 0o777, 0o755);
});
