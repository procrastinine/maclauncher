const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const {
  resolveSourceRoot,
  resolveExtractionRoot,
  resolveExtractionStatus,
  writeExtractionMeta
} = require("../src/modules/shared/mvmz/decrypt");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolveSourceRoot prefers contentRootDir and gamePath", () => {
  const entry = {
    indexDir: "/Games/MV/www",
    indexHtml: "/Games/MV/www/index.html",
    contentRootDir: "/Games/MV",
    gamePath: "/Games/MV"
  };
  assert.equal(resolveSourceRoot(entry), "/Games/MV");

  const entryFromGamePath = {
    gamePath: "/Games/MZ",
    indexDir: "/Games/MZ/www"
  };
  assert.equal(resolveSourceRoot(entryFromGamePath), "/Games/MZ");

  const entryFromIndex = {
    indexDir: "/Games/Other/www",
    indexHtml: "/Games/Other/www/index.html"
  };
  assert.equal(resolveSourceRoot(entryFromIndex), "/Games/Other/www");
});

test("resolveExtractionRoot uses the gameId module directory", () => {
  const entry = { gameId: "game-123", gamePath: "/Games/MVGame" };
  const userDataDir = "/path/to/Library/Application Support/maclauncher";
  const root = resolveExtractionRoot({ entry, userDataDir, moduleId: "mv" });
  assert.equal(
    root,
    path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "mv"), "extracted")
  );
});

test("resolveExtractionStatus marks matching extracts as ready", () => {
  const userDataDir = makeTempDir("maclauncher-mvmz-extract-");
  try {
    const entry = { gameId: "game-123", gamePath: "/Games/MVGame", moduleData: {} };
    const extractRoot = resolveExtractionRoot({ entry, userDataDir, moduleId: "mv" });
    fs.mkdirSync(extractRoot, { recursive: true });
    writeExtractionMeta(extractRoot, {
      sourcePath: "/Games/MVGame",
      extractedAt: 123,
      mode: "decrypt"
    });
    const status = resolveExtractionStatus({
      entry,
      userDataDir,
      sourcePath: "/Games/MVGame",
      moduleId: "mv"
    });
    assert.equal(status.decryptedReady, true);
    assert.equal(status.decryptedAt, 123);
    assert.equal(status.mode, "decrypt");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("resolveExtractionStatus rejects mismatched source paths", () => {
  const userDataDir = makeTempDir("maclauncher-mvmz-extract-");
  try {
    const entry = { gameId: "game-123", gamePath: "/Games/MVGame", moduleData: {} };
    const extractRoot = resolveExtractionRoot({ entry, userDataDir, moduleId: "mv" });
    fs.mkdirSync(extractRoot, { recursive: true });
    writeExtractionMeta(extractRoot, {
      sourcePath: "/Games/OtherGame",
      extractedAt: 123,
      mode: "decrypt"
    });
    const status = resolveExtractionStatus({
      entry,
      userDataDir,
      sourcePath: "/Games/MVGame",
      moduleId: "mv"
    });
    assert.equal(status.decryptedReady, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
