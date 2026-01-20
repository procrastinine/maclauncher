const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

test("buildOnsyuriIndex includes game files and aliases", () => {
  const root = makeTempDir("maclauncher-onsyuri-index-");
  const gameRoot = path.join(root, "game");
  const wrapperDir = path.join(root, "wrapper");
  try {
    writeFile(path.join(gameRoot, "0.utf"), "dummy");
    writeFile(path.join(gameRoot, "arc.nsa"), "archive");
    writeFile(path.join(gameRoot, "bgm", "track.ogg"), "audio");
    writeFile(path.join(wrapperDir, "0.txt"), "alias");
    writeFile(path.join(wrapperDir, "default.ttf"), "font");

    NscripterModule.__test.buildOnsyuriIndex({
      wrapperDir,
      gameRootDir: gameRoot,
      gamePath: gameRoot,
      name: "Test Game",
      scriptInfo: { needsAlias: true },
      includeFontAlias: true
    });

    const indexPath = path.join(wrapperDir, "onsyuri_index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const id = stableIdForPath(gameRoot);
    assert.equal(index.title, "Test Game");
    assert.equal(index.gamedir, `/onsyuri/${id}`);
    assert.equal(index.savedir, `/onsyuri_save/${id}`);
    assert.equal(index.lazyload, true);
    assert.ok(index.args.includes("--enc:utf8"));
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
