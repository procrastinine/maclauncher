const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ConstructModule = require("../src/modules/construct/main");
const { resolveExtractionRoot: resolveConstructExtractionRoot } = require("../src/modules/construct/extract");
const TyranoModule = require("../src/modules/tyrano/main");
const { resolveExtractionRoot } = require("../src/modules/tyrano/extract");
const NscripterModule = require("../src/modules/nscripter/main");
const { resolveExtractionRoot: resolveNscripterExtractionRoot } = require("../src/modules/nscripter/extract");
const RenpyModule = require("../src/modules/renpy/main");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stableIdForPath(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex").slice(0, 12);
}

test("cleanupGameData removes Tyrano extraction data", () => {
  const userDataDir = makeTempDir("maclauncher-tyrano-cleanup-");
  const gamePath = "/Games/TyranoGame";
  const packagedPath = "/Games/TyranoGame.exe";
  const entry = {
    gamePath,
    moduleData: {
      packagedPath,
      extractedRoot: path.join(userDataDir, "modules", "tyrano", "extracted", "custom")
    }
  };

  const computed = resolveExtractionRoot({
    entry,
    userDataDir,
    moduleId: "tyrano"
  });

  fs.mkdirSync(computed, { recursive: true });
  fs.mkdirSync(entry.moduleData.extractedRoot, { recursive: true });

  TyranoModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(computed));
  assert.ok(!fs.existsSync(entry.moduleData.extractedRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Construct extraction data", () => {
  const userDataDir = makeTempDir("maclauncher-construct-cleanup-");
  const gamePath = "/Games/ConstructGame";
  const packagedPath = "/Games/ConstructGame/package.nw";
  const entry = {
    gamePath,
    moduleData: {
      packagedPath,
      extractedRoot: path.join(userDataDir, "modules", "construct", "extracted", "custom")
    }
  };

  const computed = resolveConstructExtractionRoot({
    entry,
    userDataDir,
    moduleId: "construct"
  });

  fs.mkdirSync(computed, { recursive: true });
  fs.mkdirSync(entry.moduleData.extractedRoot, { recursive: true });

  ConstructModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(computed));
  assert.ok(!fs.existsSync(entry.moduleData.extractedRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes NScripter wrapper data", () => {
  const userDataDir = makeTempDir("maclauncher-nscripter-cleanup-");
  const gamePath = "/Games/NScripterGame";
  const packagedPath = "/Games/NScripterGame.exe";
  const entry = { gamePath, moduleData: { packagedPath } };
  const id = stableIdForPath(gamePath);
  const webWrapperDir = path.join(
    userDataDir,
    "modules",
    "nscripter",
    "onsyuri-web",
    "wrappers",
    id
  );
  const macWrapperDir = path.join(
    userDataDir,
    "modules",
    "nscripter",
    "onsyuri-mac",
    "wrappers",
    id
  );
  const extractedRoot = resolveNscripterExtractionRoot({
    entry,
    userDataDir,
    moduleId: "nscripter"
  });

  fs.mkdirSync(webWrapperDir, { recursive: true });
  fs.mkdirSync(macWrapperDir, { recursive: true });
  fs.mkdirSync(extractedRoot, { recursive: true });

  NscripterModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(webWrapperDir));
  assert.ok(!fs.existsSync(macWrapperDir));
  assert.ok(!fs.existsSync(extractedRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Ren'Py per-game data", () => {
  const userDataDir = makeTempDir("maclauncher-renpy-cleanup-");
  const gamePath = "/Games/RenpyGame";
  const id = stableIdForPath(gamePath);
  const root = path.join(userDataDir, "modules", "renpy");

  fs.mkdirSync(path.join(root, "builds", id), { recursive: true });
  fs.writeFileSync(path.join(root, "builds", id, "builds.json"), "{}");
  fs.mkdirSync(path.join(root, "projects", id, "8.0.0"), { recursive: true });
  fs.mkdirSync(path.join(root, "builds", "keep-me"), { recursive: true });
  fs.mkdirSync(path.join(root, "patches"), { recursive: true });
  fs.writeFileSync(path.join(root, "patches", `${id}.json`), "{}");

  RenpyModule.cleanupGameData({ gamePath }, { userDataDir });

  assert.ok(!fs.existsSync(path.join(root, "builds", id)));
  assert.ok(!fs.existsSync(path.join(root, "projects", id)));
  assert.ok(!fs.existsSync(path.join(root, "patches", `${id}.json`)));
  assert.ok(fs.existsSync(path.join(root, "builds", "keep-me")));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
