const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-test-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "tests", "fixtures"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "run-testing.mjs"), path.join(root, "scripts", "run-testing.mjs"));
  fs.writeFileSync(path.join(root, "tests", "sample.test.js"), 'require("node:test")("offline sample", () => { require("node:assert/strict").equal(2 + 2, 4); });');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return {
    root,
    run: (...args) => spawnSync(process.execPath, [path.join(root, "scripts", "run-testing.mjs"), ...args], { env, encoding: "utf8", timeout: 10_000 })
  };
}

test("unit test runner works in a fresh checkout without local config or Electron", t => {
  const { run } = fixture(t);
  const result = run("test", "--test-name-pattern=offline sample");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline sample/);
});

test("smoke runner still requires an explicit game config", t => {
  const { run } = fixture(t);
  const result = run("smoke");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing .local\/testing.json/);
});
