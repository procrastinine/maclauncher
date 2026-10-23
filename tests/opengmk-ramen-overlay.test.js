const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyRamenOverlay } = require("../src/modules/gamemaker/overlays/opengmk-macos/apply-ramen");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ramen-source-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Cargo.toml"), "unexpected source");
  return { root, source };
}

test("unknown ramen source identity fails before writing or modifying a tree", t => {
  const { root, source } = fixture(t), destination = path.join(root, "owned", "ramen");
  assert.throws(() => applyRamenOverlay({ sourceDir: source, destination }), /identity check failed/);
  assert.equal(fs.existsSync(path.dirname(destination)), false);
  assert.equal(fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"), "unexpected source");
});

test("ramen overlay cannot modify its upstream source or a source-relative directory", t => {
  const { source } = fixture(t);
  for (const destination of [source, path.join(source, "owned")]) {
    assert.throws(() => applyRamenOverlay({ sourceDir: source, destination }), /read-only/);
  }
});

test("a symlinked destination cannot bypass the upstream read-only boundary", t => {
  const { root, source } = fixture(t), alias = path.join(root, "alias"); fs.symlinkSync(source, alias);
  assert.throws(() => applyRamenOverlay({ sourceDir: source, destination: path.join(alias, "owned") }), /read-only/);
  assert.equal(fs.existsSync(path.join(source, "owned")), false);
});

test("ramen overlay rejects Cargo-cache and vendored destination paths", t => {
  const { root, source } = fixture(t);
  for (const relative of [".cargo/git/checkouts/ramen", "src/external/ramen"]) {
    assert.throws(() => applyRamenOverlay({ sourceDir: source, destination: path.join(root, relative) }), /read-only/);
  }
});
