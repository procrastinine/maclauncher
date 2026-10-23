const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const {
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("../src/modules/renpy/extract");
const RenpyModule = require("../src/modules/renpy/main");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveExtractionRoot uses the gameId module directory", () => {
  const entry = { gameId: "game-renpy", gamePath: "/Games/RenpyGame" };
  const userDataDir = "/path/to/Library/Application Support/maclauncher";
  const root = resolveExtractionRoot({ entry, userDataDir });
  assert.equal(
    root,
    path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "renpy"), "extracted")
  );
});

test("resolveExtractionStatus marks matching extracts as ready", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-extract-");
  try {
    const entry = { gameId: "game-renpy", gamePath: "/Games/RenpyGame", moduleData: {} };
    const sourcePath = "/Games/RenpyGame/game";
    const extractRoot = resolveExtractionRoot({ entry, userDataDir });
    fs.mkdirSync(extractRoot, { recursive: true });
    writeExtractionMeta(extractRoot, { sourcePath, extractedAt: 123 });
    const status = resolveExtractionStatus({ entry, userDataDir, sourcePath });
    assert.equal(status.extractedReady, true);
    assert.equal(status.extractedAt, 123);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resolveExtractionStatus rejects mismatched source paths", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-extract-");
  try {
    const entry = { gameId: "game-renpy", gamePath: "/Games/RenpyGame", moduleData: {} };
    const extractRoot = resolveExtractionRoot({ entry, userDataDir });
    fs.mkdirSync(extractRoot, { recursive: true });
    writeExtractionMeta(extractRoot, { sourcePath: "/Games/RenpyGame/game", extractedAt: 123 });
    const status = resolveExtractionStatus({
      entry,
      userDataDir,
      sourcePath: "/Games/OtherGame/game"
    });
    assert.equal(status.extractedReady, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("refreshExtractionStatus flags extracted overrides when present", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-extract-");
  const gameRoot = makeTempDir("maclauncher-renpy-game-");
  try {
    const gameDir = path.join(gameRoot, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    const entry = { gameId: "game-renpy", gamePath: gameRoot, moduleData: {} };
    const extractRoot = resolveExtractionRoot({ entry, userDataDir });
    fs.mkdirSync(path.join(extractRoot, "gui"), { recursive: true });
    fs.writeFileSync(
      path.join(extractRoot, "options.rpy"),
      'define config.save_directory = "ExtractedSave"\n' +
        'define config.window_icon = "gui/icon.png"'
    );
    fs.writeFileSync(path.join(extractRoot, "gui", "icon.png"), "png");
    writeExtractionMeta(extractRoot, { sourcePath: gameDir, extractedAt: 123 });

    RenpyModule.actions.refreshExtractionStatus(entry, {}, { userDataDir });

    assert.equal(entry.moduleData.extractedOverridesFromExtraction, true);
    assert.ok(String(entry.defaultSaveDir || "").includes("ExtractedSave"));
    assert.ok(entry.moduleData.extractedIconPath);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
});

test("resolveGameIcon ignores cached webp and falls back to window_icon.png", () => {
  const root = makeTempDir("maclauncher-renpy-game-");
  try {
    const gameDir = path.join(root, "game", "gui");
    fs.mkdirSync(gameDir, { recursive: true });
    const fallbackPng = path.join(gameDir, "window_icon.png");
    fs.writeFileSync(fallbackPng, require("../src/core/icon-utils").encodePngBitmap({ width: 1, height: 1, buffer: Buffer.from([255, 0, 0, 255]) }));
    const cachedWebp = path.join(root, "cached-icon.webp");
    fs.writeFileSync(cachedWebp, "webp");

    const entry = {
      gameId: "game-renpy",
      gamePath: root,
      moduleData: { extractedIconPath: cachedWebp }
    };
    const resolved = RenpyModule.resolveGameIcon(entry);
    assert.equal(resolved, fallbackPng);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGameIcon prefers cached png sibling for webp cache paths", () => {
  const root = makeTempDir("maclauncher-renpy-game-");
  try {
    const cachedWebp = path.join(root, "window-icon.webp");
    const cachedPng = path.join(root, "window-icon.png");
    fs.writeFileSync(cachedWebp, "webp");
    fs.writeFileSync(cachedPng, "png");

    const entry = {
      gameId: "game-renpy",
      gamePath: root,
      moduleData: { extractedIconPath: cachedWebp }
    };
    const resolved = RenpyModule.resolveGameIcon(entry);
    assert.equal(resolved, cachedPng);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renpycompat patch defines astsupport PyExpr with the expected class name", () => {
  const patchPath = path.join(
    __dirname,
    "..",
    "src",
    "modules",
    "renpy",
    "resources",
    "unren",
    "patches",
    "renpycompat.py"
  );
  const source = fs.readFileSync(patchPath, "utf8");

  assert.match(source, /class\s+PyExpr\(/);
  assert.doesNotMatch(source, /class\s+PyExprSupport\(/);
  assert.match(source, /__module__\s*=\s*"renpy\.astsupport"/);
});
