const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const NscripterModule = require("../src/modules/nscripter/main");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("buildOnsyuriIndex includes game files and aliases", () => {
  const root = makeTempDir("maclauncher-onsyuri-index-");
  const gameRoot = path.join(root, "game");
  const wrapperDir = path.join(root, "wrapper");
  const gameId = "game-onsyuri";
  try {
    writeFile(path.join(gameRoot, "0.utf"), "dummy");
    writeFile(path.join(gameRoot, "arc.nsa"), "archive");
    writeFile(path.join(gameRoot, "bgm", "track.ogg"), "audio");
    writeFile(path.join(wrapperDir, "0.txt"), "alias");
    writeFile(path.join(wrapperDir, "default.ttf"), "font");

    NscripterModule.__test.buildOnsyuriIndex({
      wrapperDir,
      gameRootDir: gameRoot,
      gameId,
      name: "Test Game",
      scriptInfo: { needsAlias: true },
      includeFontAlias: true,
      gameArguments: ["--fullscreen", "A name", ""]
    });

    const indexPath = path.join(wrapperDir, "onsyuri_index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.equal(index.title, "Test Game");
    assert.equal(index.gamedir, `/onsyuri/${gameId}`);
    assert.equal(index.savedir, `/onsyuri_save/${gameId}`);
    assert.equal(index.lazyload, true);
    assert.ok(index.args.includes("--enc:utf8"));
    assert.deepEqual(index.args.slice(-3), ["--fullscreen", "A name", ""]);
    const files = index.files.map(item => item.path);
    assert.ok(files.includes("0.utf"));
    assert.ok(files.includes("arc.nsa"));
    assert.ok(files.includes("bgm/track.ogg"));
    assert.ok(files.includes("0.txt"));
    assert.ok(files.includes("default.ttf"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Yuri index replaces a staged alias without writing the original index", t => {
  const root = makeTempDir("maclauncher-onsyuri-index-alias-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, "game"), wrapperDir = path.join(root, "wrapper");
  writeFile(path.join(gameRoot, "0.txt"), "*define\ngame\n*start\nend\n");
  const original = path.join(root, "publisher-index.json");
  writeFile(original, '{"publisher":"unchanged"}');
  fs.mkdirSync(wrapperDir);
  fs.symlinkSync(original, path.join(wrapperDir, "onsyuri_index.json"));
  NscripterModule.__test.buildOnsyuriIndex({ wrapperDir, gameRootDir: gameRoot, gameId: "owned-game", scriptInfo: {} });
  assert.equal(fs.readFileSync(original, "utf8"), '{"publisher":"unchanged"}');
  assert.equal(fs.lstatSync(path.join(wrapperDir, "onsyuri_index.json")).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(wrapperDir, "onsyuri_index.json"), "utf8")).gamedir, "/onsyuri/owned-game");
});
