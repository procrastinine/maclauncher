const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Sdk = require("../src/modules/renpy/runtime/sdk");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "original"), userDataDir = path.join(root, "userData");
  const files = {
    "game/script.rpy": "label start:\n    'Hello'\n",
    "game/script.rpyc": "original compiled script",
    "game/tl/french/dialogue.rpy": "translate french start:\n    'Bonjour'\n",
    "game/python-packages/helper.py": "answer = 42\n",
    "game/archive.rpa": Buffer.alloc(1024 * 1024, 7),
    "game/images/cat.png": "original image",
    "game/audio/music.ogg": "original audio",
    "game/cache/bytecode.rpyb": "other SDK cache",
    "game/saves/1-1-LT1.save": "existing save",
    "log.txt": "original log",
    "icon.png": "original icon"
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const options = { userDataDir, gameId: "overlay-game", gamePath: path.join(source, "Game.exe"),
    contentRootDir: source, sdkVersion: "8.5.2" };
  return { root, source, options };
}

function digestTree(root) {
  const files = {};
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) visit(target);
      else files[path.relative(root, target)] = {
        sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
        mtime: fs.statSync(target).mtimeMs
      };
    }
  }
  visit(root);
  return files;
}

test("Ren'Py SDK keeps immutable assets in the original and runtime writes in private directories", t => {
  const { source, options } = fixture(t);
  const before = digestTree(source);
  t.mock.method(fs, "cpSync", () => { throw new Error("Full project copies are forbidden"); });
  const wrapper = Sdk.ensureWrapper(options);
  assert.equal(wrapper, Sdk.resolveWrapperDir(options.userDataDir, options.gameId, "8.5.2"));
  for (const relative of ["game", "game/cache", "game/saves", "game/tl/french", "game/images", "game/python-packages"]) {
    assert.equal(fs.lstatSync(path.join(wrapper, relative)).isSymbolicLink(), false);
  }
  for (const relative of ["game/archive.rpa", "game/images/cat.png", "game/audio/music.ogg", "icon.png"]) {
    assert.equal(fs.lstatSync(path.join(wrapper, relative)).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(path.join(wrapper, relative)), fs.realpathSync(path.join(source, relative)));
  }
  for (const relative of ["game/script.rpy", "game/script.rpyc", "game/python-packages/helper.py", "log.txt"]) {
    assert.equal(fs.lstatSync(path.join(wrapper, relative)).isSymbolicLink(), false);
  }
  assert.equal(fs.existsSync(path.join(wrapper, "game/cache/bytecode.rpyb")), false);
  fs.writeFileSync(path.join(wrapper, "game/script.rpyc"), "SDK compiled script");
  fs.writeFileSync(path.join(wrapper, "game/cache/bytecode.rpyb"), "current SDK cache");
  fs.writeFileSync(path.join(wrapper, "game/saves/1-1-LT1.save"), "updated local save");
  fs.writeFileSync(path.join(wrapper, "game/images/generated.txt"), "generated metadata");
  fs.writeFileSync(path.join(wrapper, "log.txt"), "current runtime log");
  assert.deepEqual(digestTree(source), before);
});

test("Ren'Py warm launches preserve compiled scripts, saves and logs without recopying inputs", t => {
  const { options } = fixture(t);
  const wrapper = Sdk.ensureWrapper(options);
  fs.writeFileSync(path.join(wrapper, "game/script.rpyc"), "SDK compiled script");
  fs.writeFileSync(path.join(wrapper, "game/saves/1-1-LT1.save"), "new save");
  fs.writeFileSync(path.join(wrapper, "log.txt"), "new log");
  t.mock.method(fs, "copyFileSync", () => { throw new Error("Unchanged inputs should not be copied again"); });
  assert.equal(Sdk.ensureWrapper(options), wrapper);
  assert.equal(fs.readFileSync(path.join(wrapper, "game/script.rpyc"), "utf8"), "SDK compiled script");
  assert.equal(fs.readFileSync(path.join(wrapper, "game/saves/1-1-LT1.save"), "utf8"), "new save");
  assert.equal(fs.readFileSync(path.join(wrapper, "log.txt"), "utf8"), "new log");
});

test("Ren'Py overlays refresh changed source scripts and remove deleted scripts and generated companions", t => {
  const { source, options } = fixture(t);
  const wrapper = Sdk.ensureWrapper(options);
  fs.writeFileSync(path.join(source, "game/script.rpy"), "label start:\n    'Updated dialogue'\n");
  Sdk.ensureWrapper(options);
  assert.equal(fs.readFileSync(path.join(wrapper, "game/script.rpy"), "utf8"),
    fs.readFileSync(path.join(source, "game/script.rpy"), "utf8"));
  fs.writeFileSync(path.join(wrapper, "game/tl/french/dialogue.rpyc"), "generated translated script");
  fs.rmSync(path.join(source, "game/tl/french/dialogue.rpy"));
  Sdk.ensureWrapper(options);
  assert.equal(fs.existsSync(path.join(wrapper, "game/tl/french/dialogue.rpy")), false);
  assert.equal(fs.existsSync(path.join(wrapper, "game/tl/french/dialogue.rpyc")), false);
});

test("Ren'Py migrates an old game-directory alias without touching the original", t => {
  const { source, options } = fixture(t);
  const wrapper = Sdk.resolveWrapperDir(options.userDataDir, options.gameId, options.sdkVersion);
  fs.mkdirSync(wrapper, { recursive: true });
  fs.symlinkSync(path.join(source, "game"), path.join(wrapper, "game"), "dir");
  fs.writeFileSync(path.join(wrapper, ".maclauncher-renpy-wrapper.json"), JSON.stringify({ source }));
  const before = digestTree(source);
  Sdk.ensureWrapper(options);
  assert.equal(fs.lstatSync(path.join(wrapper, "game")).isSymbolicLink(), false);
  assert.deepEqual(digestTree(source), before);
});

test("Ren'Py SDK generations use independent private script and cache overlays", t => {
  const { options } = fixture(t);
  const first = Sdk.ensureWrapper(options);
  fs.writeFileSync(path.join(first, "game/script.rpyc"), "Python 3 compiled script");
  const second = Sdk.ensureWrapper({ ...options, sdkVersion: "7.8.7" });
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(second, "game/script.rpyc"), "utf8"), "original compiled script");
  assert.equal(fs.realpathSync(path.join(first, "game/archive.rpa")), fs.realpathSync(path.join(second, "game/archive.rpa")));
});

test("Ren'Py never silently copies assets when an asset link fails", t => {
  const { source, options } = fixture(t);
  const before = digestTree(source);
  t.mock.method(fs, "symlinkSync", () => { throw Object.assign(new Error("Link unavailable"), { code: "ENOTSUP" }); });
  t.mock.method(fs, "cpSync", () => { throw new Error("A full copy must not be used as fallback"); });
  assert.throws(() => Sdk.ensureWrapper(options), /Link unavailable/);
  assert.deepEqual(digestTree(source), before);
});

test("Ren'Py refuses an overlay inside the original game, including directory aliases", t => {
  const { root, source, options } = fixture(t);
  const alias = path.join(root, "source-alias");
  fs.symlinkSync(source, alias, "dir");
  assert.throws(() => Sdk.ensureWrapper({ ...options, userDataDir: path.join(alias, "game/runtime-data") }),
    /outside the original game folder/);
  assert.equal(fs.existsSync(path.join(source, "game/runtime-data")), false);
});
