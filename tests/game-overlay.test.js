const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { syncOverlay } = require("../src/modules/shared/game-overlay");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-overlay-")), source = path.join(root, "game"), managed = path.join(root, "managed");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "data"), { recursive: true }); fs.mkdirSync(managed);
  fs.writeFileSync(path.join(source, "options.ini"), "volume=1");
  fs.writeFileSync(path.join(source, "data", "level.cfg"), "level one");
  fs.writeFileSync(path.join(source, "data", "notes.txt"), "author notes");
  fs.writeFileSync(path.join(source, "data", "art.png"), "image bytes");
  const options = { destination: path.join(managed, "game"), recordPath: path.join(managed, "game-files.json"),
    layers: [{ source }], link: name => name.endsWith(".png"), skip: name => name.startsWith(".") };
  const inodes = () => {
    const result = {};
    (function visit(directory, prefix) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name), relative = path.join(prefix, item.name);
        if (item.isDirectory()) visit(file, relative); else result[relative] = fs.lstatSync(file).ino;
      }
    })(options.destination, "");
    return result;
  };
  return { root, source, options, game: options.destination, inodes };
}

test("Game overlays follow edited, added and removed original files and keep what the game wrote", t => {
  const { source, options, game, inodes } = fixture(t);
  assert.deepEqual(syncOverlay(options), { changed: true });
  assert.equal(fs.readlinkSync(path.join(game, "data", "art.png")), path.join(source, "data", "art.png"));
  assert.equal(fs.lstatSync(path.join(game, "options.ini")).isFile(), true);
  // The game edits one private file and creates another.
  fs.writeFileSync(path.join(game, "data", "notes.txt"), "game wrote this");
  fs.writeFileSync(path.join(game, "save.dat"), "game save");
  const before = inodes();
  assert.deepEqual(syncOverlay(options), { changed: false }, "nothing changed, nothing is redone");
  assert.deepEqual(inodes(), before);
  // The user edits, adds and removes originals.
  fs.writeFileSync(path.join(source, "options.ini"), "volume=0, longer");
  fs.writeFileSync(path.join(source, "data", "extra.cfg"), "added later");
  fs.rmSync(path.join(source, "data", "level.cfg")); fs.rmSync(path.join(source, "data", "notes.txt"));
  assert.deepEqual(syncOverlay(options), { changed: true });
  assert.equal(fs.readFileSync(path.join(game, "options.ini"), "utf8"), "volume=0, longer");
  assert.equal(fs.readFileSync(path.join(game, "data", "extra.cfg"), "utf8"), "added later");
  assert.equal(fs.existsSync(path.join(game, "data", "level.cfg")), false, "an untouched copy of a removed original goes");
  assert.equal(fs.readFileSync(path.join(game, "data", "notes.txt"), "utf8"), "game wrote this", "a copy the game changed stays");
  assert.equal(fs.readFileSync(path.join(game, "save.dat"), "utf8"), "game save");
  assert.equal(fs.readFileSync(path.join(source, "options.ini"), "utf8"), "volume=0, longer");
  // A removed resource link goes with its original; the folder stays while it holds game data.
  fs.rmSync(path.join(source, "data", "art.png"));
  syncOverlay(options);
  assert.equal(fs.existsSync(path.join(game, "data", "art.png")), false);
  assert.equal(fs.statSync(path.join(game, "data")).isDirectory(), true);
});

test("A game folder that disappears and returns unchanged is reused as it was", t => {
  const { root, source, options, game, inodes } = fixture(t);
  syncOverlay(options);
  fs.writeFileSync(path.join(game, "options.ini"), "game settings");
  const before = inodes(), record = fs.readFileSync(options.recordPath, "utf8");
  // A disconnected drive: the pass stops before changing anything.
  fs.renameSync(source, path.join(root, "away"));
  assert.throws(() => syncOverlay(options), { code: "ENOENT" });
  assert.deepEqual(inodes(), before); assert.equal(fs.readFileSync(options.recordPath, "utf8"), record);
  fs.renameSync(path.join(root, "away"), source);
  assert.deepEqual(syncOverlay(options), { changed: false });
  assert.deepEqual(inodes(), before);
  assert.equal(fs.readFileSync(path.join(game, "options.ini"), "utf8"), "game settings");
});

test("Later overlay layers win, and private files from older layouts are adopted rather than replaced", t => {
  const { root, source, options, game } = fixture(t), engine = path.join(root, "engine");
  fs.mkdirSync(path.join(engine, "data"), { recursive: true });
  fs.writeFileSync(path.join(engine, "data", "level.cfg"), "engine default");
  fs.writeFileSync(path.join(engine, "data", "common.cfg"), "engine common");
  fs.mkdirSync(game); fs.mkdirSync(path.join(game, "data"));
  fs.writeFileSync(path.join(game, "data", "level.cfg"), "older private edit");
  const layered = { ...options, layers: [{ source: path.join(engine, "data"), into: "data" }, { source: path.join(source, "data"), into: "data" },
    { source: path.join(root, "absent"), into: "data", optional: true }] };
  syncOverlay(layered);
  assert.equal(fs.readFileSync(path.join(game, "data", "level.cfg"), "utf8"), "older private edit");
  assert.equal(fs.readFileSync(path.join(game, "data", "common.cfg"), "utf8"), "engine common");
  fs.writeFileSync(path.join(source, "data", "level.cfg"), "updated game level");
  syncOverlay(layered);
  assert.equal(fs.readFileSync(path.join(game, "data", "level.cfg"), "utf8"), "updated game level");
});
