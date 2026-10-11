const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("../src/modules/nscripter/main");
const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");

test("Onsyuri refuses missing explicit versions and architectures instead of launching another install", t => {
  const previousMac = Runtime.listInstalledMac, previousWeb = Runtime.listInstalledWeb;
  t.after(() => { Runtime.listInstalledMac = previousMac; Runtime.listInstalledWeb = previousWeb; });
  Runtime.listInstalledMac = () => [
    { version: "0.7.7", variant: "arm64", installDir: "/owned/current" },
    { version: "0.7.6", variant: "x64", installDir: "/owned/older" }
  ];
  Runtime.listInstalledWeb = () => [{ version: "0.7.7", installDir: "/owned/web" }];
  const settings = { runtimes: { onsyuri: { mac: { defaultVersion: "0.7.7", defaultVariant: "arm64" } } } };
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.5", variant: "arm64" }), /0\.7\.5.*unavailable/);
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.7", variant: "x64" }), /x64.*unavailable/);
  assert.equal(Module.__test.resolveOnsyuriMacInstall("/owned", settings, { version: "0.7.6", variant: "x64" }).installDir, "/owned/older");
  assert.equal(Module.__test.resolveOnsyuriMacInstall("/owned", settings).installDir, "/owned/current");
  assert.throws(() => Module.__test.resolveOnsyuriWebInstall("/owned", {}, { version: "0.7.6" }), /0\.7\.6.*not installed/);
  assert.throws(() => Module.__test.resolveOnsyuriWebInstall("/owned", { runtimes: { onsyuri: { web: { defaultVersion: "0.7.6" } } } }), /0\.7\.6.*not installed/);
  Runtime.listInstalledMac = () => [{ version: "0.7.7", variant: "arm64", ready: false, error: "Runtime requires macOS 27.0." }];
  assert.throws(() => Module.__test.resolveOnsyuriMacInstall("/owned", settings), /requires macOS 27\.0/);
});

test("native save overrides go to the exact configured absolute directory with interpreter path separator", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-onsyuri-save-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game"), save = path.join(root, "private", "new saves");
  fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "sentinel.dat"), "unchanged");
  const args = Module.__test.buildNativeLaunchArgs({ saveDirOverride: save }, game);
  assert.deepEqual(args, ["--root", game, "--save-dir", save + path.sep]);
  assert.equal(fs.statSync(save).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(game, "sentinel.dat"), "utf8"), "unchanged");
  assert.deepEqual(Module.__test.buildNativeLaunchArgs({}, game), ["--root", game]);
  assert.throws(() => Module.__test.buildNativeLaunchArgs({ saveDirOverride: "relative/save" }, game), /absolute/);
  assert.throws(() => Module.__test.buildNativeLaunchArgs({ saveDirOverride: 42 }, game), /absolute/);
});

test("versioned Lua libraries produce the dependency install hint", () => {
  const info = Module.__test.parseMissingDylibs("/owned/onsyuri:\n\t/opt/homebrew/opt/lua/lib/liblua.5.5.dylib (compatibility version 5.5.0)\n", () => false);
  assert.deepEqual(info.brewHints, ["lua"]);
});

test("NScripter encoding selection preserves Japanese defaults, Chinese overrides and declared UTF scripts", () => {
  assert.equal(Module.__test.resolveScriptEncoding({}, {}), "sjis");
  assert.equal(Module.__test.resolveScriptEncoding({}, { scriptEncoding: "gbk" }), "gbk");
  assert.equal(Module.__test.resolveScriptEncoding({ needsAlias: true }, { scriptEncoding: "sjis" }), "utf8");
  assert.equal(Module.__test.resolveScriptEncoding({}, { scriptEncoding: "runtime" }), "runtime");
  assert.throws(() => Module.__test.resolveScriptEncoding({}, { scriptEncoding: "utf8 --debug:1" }), /supported.*encoding/);
});
