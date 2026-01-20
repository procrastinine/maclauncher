const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Python = require("../src/modules/shared/runtime/python");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveEvbunpackRoot points to external evbunpack", () => {
  const root = Python.resolveEvbunpackRoot();
  const expected = path.resolve(__dirname, "..", "src", "external", "evbunpack");
  assert.equal(root, expected);
});

test("resolveEvbunpackVenvDir builds the managed runtime path", () => {
  const userDataDir = "/Users/tester/Library/Application Support/maclauncher";
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
  assert.equal(cmd.args[0], "-m");
  assert.equal(cmd.args[1], "evbunpack");
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
