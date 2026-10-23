const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const Construct = require("../src/modules/construct/main");
const ConstructExtraction = require("../src/modules/construct/extract");
const Tyrano = require("../src/modules/tyrano/main");
const TyranoExtraction = require("../src/modules/tyrano/extract");
const Nwjs = require("../src/modules/shared/web/runtime/nwjs-launcher");
const NwjsPatched = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");
const { createStaticServer } = require("../src/core/static-server");
const UserEnv = require("../src/modules/tyrano/userenv-shim");

function fixture(t, moduleId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-package-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"), packagePath = path.join(game, "package.nw");
  const userDataDir = path.join(root, "userData"), extractRoot = path.join(userDataDir, "cache");
  const files = {
    "index.html": "<!doctype html><title>Creator export</title>",
    "package.json": JSON.stringify({ name: "creator-game", main: "index.html" }),
    "data/assets.bin": Buffer.alloc(1024 * 1024, 9),
    ...(moduleId === "construct" ? { "c2runtime.js": "// Construct 2 runtime" } : {
      "tyrano/plugins/kag/kag.js": 'var TYRANO_ENGINE_VERSION = "5.03";',
      "tyrano/libs.js": "// Author libraries; missing userenv is a runtime compatibility concern"
    })
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(packagePath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const entry = { gameId: `directory-${moduleId}`, moduleId, gamePath: game,
    contentRootDir: packagePath, indexHtml: path.join(packagePath, "index.html"),
    moduleData: { packagedType: "package.nw", packagedPath: packagePath } };
  return { root, game, packagePath, userDataDir, extractRoot, entry };
}

function snapshot(root) {
  const rows = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else rows[path.relative(root, target)] = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    }
  }
  visit(root);
  return rows;
}

for (const [moduleId, mod, extraction] of [
  ["construct", Construct, ConstructExtraction], ["tyrano", Tyrano, TyranoExtraction]
]) {
  test(`${moduleId} directory packages read original assets without copying or extraction`, async t => {
    const { game, packagePath, userDataDir, extractRoot, entry } = fixture(t, moduleId);
    const before = snapshot(game);
    t.mock.method(fs, "cpSync", () => { throw new Error("A directory package must not be copied"); });
    const result = await extraction.extractPackage({ packagePath, packageType: "package.nw", extractRoot });
    assert.equal(result.method, "directory");
    assert.equal(result.contentRootDir, packagePath);
    assert.equal(fs.existsSync(extractRoot), false);
    const status = mod.actions.refreshExtractionStatus(entry, {}, { userDataDir });
    assert.equal(status.extractedReady, true);
    assert.equal(status.extractedRoot, null);
    assert.equal(entry.contentRootDir, packagePath);
    assert.equal(entry.indexHtml, path.join(packagePath, "index.html"));
    assert.equal(fs.existsSync(userDataDir), false);
    if (moduleId === "construct") {
      assert.equal(mod.canLaunchRuntime("electron", entry), true);
      assert.deepEqual(mod.filterRuntimeSupport(entry, ["electron", "nwjs"]), ["electron", "nwjs"]);
      const outside = path.join(path.dirname(game), "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "index.html"), "unrelated document");
      assert.equal(mod.canLaunchRuntime("electron", { ...entry, contentRootDir: outside,
        indexHtml: path.join(outside, "index.html"),
        moduleData: { ...entry.moduleData, packagedPath: null } }), false);
      // A stale index on an otherwise valid original package is repaired by
      // the normal pre-launch status action before hosted launch dispatch.
      const staleEntry = { ...entry, contentRootDir: outside, indexHtml: path.join(outside, "index.html") };
      mod.actions.refreshExtractionStatus(staleEntry, {}, { userDataDir });
      assert.equal(staleEntry.contentRootDir, packagePath);
      assert.equal(staleEntry.indexHtml, path.join(packagePath, "index.html"));
    }
    const server = await createStaticServer(entry.contentRootDir);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/data/assets.bin`);
      assert.equal(response.status, 200);
      assert.equal((await response.arrayBuffer()).byteLength, 1024 * 1024);
    } finally { await server.close(); }
    assert.deepEqual(snapshot(game), before);
    mod.cleanupGameData(entry, { userDataDir });
    assert.deepEqual(snapshot(game), before);
  });
}

test("Tyrano status remains read-only for extracted archive content", t => {
  const { packagePath, userDataDir, entry } = fixture(t, "tyrano");
  const originalLibraries = fs.readFileSync(path.join(packagePath, "tyrano/libs.js"), "utf8");
  entry.moduleData = { packagedType: "zip-exe", packagedPath: path.join(packagePath, "Game.exe"), extractedRoot: packagePath };
  const status = TyranoExtraction.resolveExtractionStatus({ entry, userDataDir });
  assert.equal(status.extractedReady, true);
  assert.equal(status.version, "5.03");
  assert.equal(fs.readFileSync(path.join(packagePath, "tyrano/libs.js"), "utf8"), originalLibraries);
});

test("Tyrano invalid directory packages never identify the source as removable extracted data", t => {
  const { game, packagePath, userDataDir, entry } = fixture(t, "tyrano");
  fs.rmSync(path.join(packagePath, "index.html"));
  const before = snapshot(game);
  const status = Tyrano.actions.refreshExtractionStatus(entry, {}, { userDataDir });
  assert.equal(status.extractedReady, false);
  assert.equal(status.extractedRoot, null);
  assert.equal(entry.moduleData.extractedRoot, undefined);
  Tyrano.cleanupGameData(entry, { userDataDir });
  assert.deepEqual(snapshot(game), before);
});

for (const [name, launcher] of [["NW.js", Nwjs], ["patched NW.js", NwjsPatched]]) {
  test(`${name} wrappers reference original game assets and keep only runtime modifications private`, t => {
    const { game, packagePath, userDataDir, entry } = fixture(t, "tyrano");
    const before = snapshot(game);
    t.mock.method(fs, "cpSync", () => { throw new Error("No game-directory copies should be needed"); });
    const wrapper = launcher.buildWrapper({ entry: { ...entry, gameType: "web" }, moduleId: "tyrano",
      userDataDir, supportsCheats: false, enableProtections: false, runtimeSettings: { enableProtections: false },
      injectStart: ["./maclauncher-tyrano-userenv.js"],
      extraFiles: [{ path: "maclauncher-tyrano-userenv.js", contents: "// runtime shim" }] });
    assert.equal(fs.lstatSync(path.join(wrapper, "data")).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(wrapper, "data/assets.bin")), fs.realpathSync(path.join(packagePath, "data/assets.bin")));
    assert.equal(fs.lstatSync(path.join(wrapper, "package.json")).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(wrapper, "maclauncher-tyrano-userenv.js")).isSymbolicLink(), false);
    const pkg = JSON.parse(fs.readFileSync(path.join(wrapper, "package.json"), "utf8"));
    assert.ok(pkg.maclauncher.injectStart.includes("./maclauncher-tyrano-userenv.js"));
    assert.deepEqual(snapshot(game), before);
  });
}

test("Tyrano userenv fallback follows script loading and preserves author implementations", () => {
  const callbacks = new Map();
  const target = { document: { addEventListener(type, callback) { callbacks.set(type, callback); } } };
  assert.equal(UserEnv.install(target), true);
  target.jQuery = function jquery() {};
  callbacks.get("load")();
  assert.equal(target.jQuery.userenv(), "pc");
  const authorUserenv = () => "author environment";
  target.jQuery.userenv = authorUserenv;
  callbacks.get("load")();
  assert.equal(target.jQuery.userenv, authorUserenv);
  assert.equal(UserEnv.install(target), false);
});

test("Tyrano compatibility injection works in the browser without CommonJS globals", () => {
  const window = { jQuery: function jquery() {} };
  const source = fs.readFileSync(require.resolve("../src/modules/tyrano/userenv-shim"), "utf8");
  vm.runInNewContext(source, { window });
  assert.equal(window.jQuery.userenv(), "pc");
  assert.equal(window.__maclauncherTyranoUserenv, true);
});
