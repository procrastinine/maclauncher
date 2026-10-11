const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const GameData = require("../src/modules/shared/game-data");
const MvModule = require("../src/modules/mv/main");
const { resolveExtractionRoot: resolveMvmzExtractionRoot } = require("../src/modules/shared/mvmz/decrypt");
const ConstructModule = require("../src/modules/construct/main");
const { resolveExtractionRoot: resolveConstructExtractionRoot } = require("../src/modules/construct/extract");
const TyranoModule = require("../src/modules/tyrano/main");
const { resolveExtractionRoot } = require("../src/modules/tyrano/extract");
const NscripterModule = require("../src/modules/nscripter/main");
const { resolveExtractionRoot: resolveNscripterExtractionRoot } = require("../src/modules/nscripter/extract");
const RenpyModule = require("../src/modules/renpy/main");
const { resolveExtractionRoot: resolveRenpyExtractionRoot } = require("../src/modules/renpy/extract");
const GodotModule = require("../src/modules/godot/main");
const { resolveExtractionRoot: resolveGodotExtractionRoot } = require("../src/modules/godot/extract");
const JavaModule = require("../src/modules/java/main");
const { resolveExtractionRoot: resolveJavaExtractionRoot } = require("../src/modules/java/extract");
const FlashModule = require("../src/modules/flash/main");
const LoveModule = require("../src/modules/love/main");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("cleanupGameData removes Tyrano extraction data", () => {
  const userDataDir = makeTempDir("maclauncher-tyrano-cleanup-");
  const gameId = "game-tyrano";
  const gamePath = "/Games/TyranoGame";
  const packagedPath = "/Games/TyranoGame.exe";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "tyrano");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      packagedPath,
      extractedRoot: path.join(moduleRoot, "extracted", "custom")
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

test("cleanupGameData removes MV/MZ decryption data", () => {
  const userDataDir = makeTempDir("maclauncher-mvmz-cleanup-");
  const gameId = "game-mvmz";
  const gamePath = "/Games/MVGame";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "mv");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      decryptedRoot: path.join(moduleRoot, "extracted", "custom")
    }
  };

  const computed = resolveMvmzExtractionRoot({
    entry,
    userDataDir,
    moduleId: "mv"
  });

  fs.mkdirSync(computed, { recursive: true });
  fs.mkdirSync(entry.moduleData.decryptedRoot, { recursive: true });

  MvModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(computed));
  assert.ok(!fs.existsSync(entry.moduleData.decryptedRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Construct extraction data", () => {
  const userDataDir = makeTempDir("maclauncher-construct-cleanup-");
  const gameId = "game-construct";
  const gamePath = "/Games/ConstructGame";
  const packagedPath = "/Games/ConstructGame/package.nw";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "construct");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      packagedPath,
      extractedRoot: path.join(moduleRoot, "extracted", "custom")
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
  const gameId = "game-nscripter";
  const gamePath = "/Games/NScripterGame";
  const packagedPath = "/Games/NScripterGame.exe";
  const entry = { gameId, gamePath, moduleData: { packagedPath } };
  const webWrapperDir = path.join(
    GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_web"),
    "wrappers",
    "wrapper"
  );
  const macWrapperDir = path.join(
    GameData.resolveGameRuntimeDir(userDataDir, gameId, "onsyuri_mac"),
    "wrappers",
    "wrapper"
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
  const gameId = "game-renpy";
  const gamePath = "/Games/RenpyGame";
  const root = GameData.resolveGameModuleDir(userDataDir, gameId, "renpy");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      extractedRoot: path.join(root, "extracted", "custom")
    }
  };
  const extractedRoot = resolveRenpyExtractionRoot({ entry, userDataDir });

  fs.mkdirSync(path.join(root, "builds"), { recursive: true });
  fs.writeFileSync(path.join(root, "builds", "builds.json"), "{}");
  fs.mkdirSync(path.join(root, "projects", "8.0.0"), { recursive: true });
  fs.mkdirSync(path.join(root, "patches"), { recursive: true });
  fs.writeFileSync(path.join(root, "patches", "patch.json"), "{}");
  fs.mkdirSync(extractedRoot, { recursive: true });
  fs.mkdirSync(entry.moduleData.extractedRoot, { recursive: true });

  RenpyModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(root));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Godot per-game module data", () => {
  const userDataDir = makeTempDir("maclauncher-godot-cleanup-");
  const gameId = "game-godot";
  const gamePath = "/Games/GodotGame";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "godot");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      extractedRoot: path.join(moduleRoot, "extracted", "custom")
    }
  };
  const extractedRoot = resolveGodotExtractionRoot({ entry, userDataDir });

  fs.mkdirSync(extractedRoot, { recursive: true });
  fs.mkdirSync(entry.moduleData.extractedRoot, { recursive: true });
  fs.mkdirSync(path.join(moduleRoot, "packs"), { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "packs", "Game.embedded.pck"), "test");

  GodotModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(moduleRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Java per-game module data", () => {
  const userDataDir = makeTempDir("maclauncher-java-cleanup-");
  const gameId = "game-java";
  const gamePath = "/Games/Game.jar";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "java");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      jarPath: gamePath,
      extractedRoot: path.join(moduleRoot, "extracted", "custom")
    }
  };
  const extractedRoot = resolveJavaExtractionRoot({ entry, userDataDir });

  fs.mkdirSync(extractedRoot, { recursive: true });
  fs.mkdirSync(entry.moduleData.extractedRoot, { recursive: true });

  JavaModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(moduleRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes Flash per-game module data", () => {
  const userDataDir = makeTempDir("maclauncher-flash-cleanup-");
  const gameId = "game-flash";
  const gamePath = "/Games/Game.swf";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "flash");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      swfPath: gamePath
    }
  };

  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "state.json"), "{}");

  FlashModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(moduleRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("cleanupGameData removes LÖVE per-game module data", () => {
  const userDataDir = makeTempDir("maclauncher-love-cleanup-");
  const gameId = "game-love";
  const gamePath = "/Games/Game.love";
  const moduleRoot = GameData.resolveGameModuleDir(userDataDir, gameId, "love");
  const entry = {
    gameId,
    gamePath,
    moduleData: {
      sourceKind: "appimage",
      appImageExtractRoot: path.join(moduleRoot, "appimage")
    }
  };

  fs.mkdirSync(path.join(moduleRoot, "appimage", "bin"), { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, "appimage", "bin", "Game"), "#!/bin/sh\n");

  LoveModule.cleanupGameData(entry, { userDataDir });

  assert.ok(!fs.existsSync(moduleRoot));

  fs.rmSync(userDataDir, { recursive: true, force: true });
});
