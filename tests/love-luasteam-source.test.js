const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Overlay = require("../src/modules/love/runtime/luasteam-source-overlay");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-luasteam-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "upstream"); fs.mkdirSync(source);
  const bytes = Buffer.from("reviewed source\n"); fs.writeFileSync(path.join(source, "source.cpp"), bytes);
  const input = { origin: "luasteam", path: "source.cpp", destination: "src/source.cpp", size: bytes.length, sha256: Overlay.sha256(bytes) };
  return { root, source, bytes, input };
}

test("LuaSteam stages exact source bytes outside the original checkout", t => {
  const f = fixture(t), destination = path.join(f.root, "build");
  const receipt = Overlay.stageSource({ roots: { luasteam: f.source }, destination, inputs: [f.input] });
  assert.deepEqual(fs.readFileSync(path.join(destination, f.input.destination)), f.bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.source, f.input.path)), f.bytes);
  assert.equal(receipt.version, Overlay.VERSION);
  assert.equal(receipt.hostLuaAbi, "Lua 5.1 C API");
  assert.match(receipt.sourceTreeSha256, /^[a-f0-9]{64}$/);
});

test("changed source and symlinked source inputs cannot enter a sealed LuaSteam build", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, f.input.path), Buffer.alloc(f.bytes.length, 0));
  assert.throws(() => Overlay.stageSource({ roots: { luasteam: f.source }, destination: path.join(f.root, "changed"), inputs: [f.input] }), /input changed/);
  fs.rmSync(path.join(f.source, f.input.path)); fs.symlinkSync(path.join(f.root, "changed"), path.join(f.source, f.input.path));
  assert.throws(() => Overlay.stageSource({ roots: { luasteam: f.source }, destination: path.join(f.root, "linked"), inputs: [f.input] }), /input changed/);
});

test("output aliases into upstream and existing build artifacts are preserved", t => {
  const f = fixture(t), alias = path.join(f.root, "alias"); fs.symlinkSync(f.source, alias, "dir");
  assert.throws(() => Overlay.stageSource({ roots: { luasteam: f.source }, destination: path.join(alias, "new"), inputs: [f.input] }), /read-only source/);
  assert.equal(fs.existsSync(path.join(f.source, "new")), false);
  const destination = path.join(f.root, "build"); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "old-receipt"), "preserved");
  assert.throws(() => Overlay.stageSource({ roots: { luasteam: f.source }, destination, inputs: [f.input] }), /new empty/);
  assert.equal(fs.readFileSync(path.join(destination, "old-receipt"), "utf8"), "preserved");
});

test("source input traversal and duplicate destinations are rejected", t => {
  const f = fixture(t);
  for (const [name, inputs] of [["traversal", [{ ...f.input, destination: "../outside" }]], ["duplicate", [f.input, f.input]]])
    assert.throws(() => Overlay.stageSource({ roots: { luasteam: f.source }, destination: path.join(f.root, name), inputs }), /Invalid pinned/);
});

test("both CPU builds resolve host Lua dynamically and export only the entry point", () => {
  for (const architecture of ["arm64", "x86_64"]) {
    const arguments = Overlay.compilerArguments({ sourceRoot: "/owned/source", architecture, steamLibraryPath: "/sealed/libsteam_api.dylib", outputPath: "/owned/luasteam.so" });
    assert.equal(arguments[arguments.indexOf("-arch") + 1], architecture);
    assert.ok(arguments.includes("-Wl,-undefined,dynamic_lookup"));
    assert.ok(arguments.includes("-Wl,-exported_symbol,_luaopen_luasteam"));
    assert.equal(arguments.some(item => /libluajit|liblua|\.a$/.test(item)), false);
    assert.equal(arguments.some(item => /rpath,\//.test(item)), false);
  }
  assert.throws(() => Overlay.compilerArguments({ architecture: "x86", sourceRoot: "/owned", steamLibraryPath: "/native", outputPath: "/output" }), /architecture/);
});
