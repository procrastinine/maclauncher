const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Modules = require("../src/modules/registry");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function writeJson(filePath, data) {
  writeFile(filePath, JSON.stringify(data, null, 2));
}

test("detectGame identifies RPG Maker MV and uses System.json title", () => {
  const root = makeTempDir("maclauncher-engine-");
  try {
    const mvDir = path.join(root, "mv");
    writeFile(path.join(mvDir, "index.html"), "<html></html>");
    writeFile(path.join(mvDir, "js", "rpg_core.js"), "");
    writeJson(path.join(mvDir, "data", "System.json"), { gameTitle: "MV Title" });

    const mvDetected = Modules.detectGame(mvDir);
    assert.equal(mvDetected.engine, "mv");
    assert.equal(mvDetected.gamePath, mvDir);
    assert.equal(mvDetected.indexHtml, path.join(mvDir, "index.html"));
    assert.equal(mvDetected.name, "MV Title");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RPG Maker MZ", () => {
  const root = makeTempDir("maclauncher-engine-");
  try {
    const mzDir = path.join(root, "mz");
    writeFile(path.join(mzDir, "index.html"), "<html></html>");
    writeFile(path.join(mzDir, "js", "rmmz_core.js"), "");

    const mzDetected = Modules.detectGame(mzDir);
    assert.equal(mzDetected.engine, "mz");
    assert.equal(mzDetected.gamePath, mzDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies RPG Maker MV inside a .app bundle", () => {
  const root = makeTempDir("maclauncher-app-");
  const appPath = path.join(root, "Test.app");
  try {
    const appNw = path.join(appPath, "Contents", "Resources", "app.nw");
    writeFile(path.join(appNw, "index.html"), "<html></html>");
    writeFile(path.join(appNw, "js", "rpg_core.js"), "");

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "mv");
    assert.equal(detected.gamePath, appPath);
    assert.equal(detected.contentRootDir, appNw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Ren'Py root folder and build_info name", () => {
  const root = makeTempDir("maclauncher-renpy-");
  try {
    writeFile(path.join(root, "renpy", "vc_version.py"), 'version = "8.2.1"\n');
    writeFile(path.join(root, "game", "script.rpy"), "# script");
    writeJson(path.join(root, "game", "cache", "build_info.json"), { name: "RenPy Game" });

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.renpyMajor, 8);
    assert.equal(detected.renpyVersion, "8.2.1");
    assert.equal(detected.renpyGameOnly, false);
    assert.equal(detected.name, "RenPy Game");
    assert.equal(detected.gameType, "scripted");
    assert.equal(detected.indexHtml, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Ren'Py game folder only", () => {
  const root = makeTempDir("maclauncher-renpy-");
  const gameDir = path.join(root, "game");
  try {
    writeFile(path.join(gameDir, "script_version.txt"), "7, 4, 11\n");
    writeFile(path.join(gameDir, "main.rpy"), "# script");

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.renpyMajor, 7);
    assert.equal(detected.renpyVersion, "7.4.11");
    assert.equal(detected.renpyGameOnly, true);
    assert.equal(detected.gamePath, gameDir);
    assert.equal(detected.contentRootDir, gameDir);
    assert.equal(detected.name, path.basename(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame treats Ren'Py 6 as legacy Ren'Py 7", () => {
  const root = makeTempDir("maclauncher-renpy-");
  const gameDir = path.join(root, "game");
  try {
    writeFile(path.join(gameDir, "script_version.txt"), "6, 99, 12\n");
    writeFile(path.join(gameDir, "main.rpy"), "# script");

    const detected = Modules.detectGame(gameDir);
    assert.equal(detected.engine, "renpy");
    assert.equal(detected.renpyMajor, 7);
    assert.equal(detected.renpyVersion, "6.99.12");
    assert.equal(detected.renpyGameOnly, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Construct runtimes", () => {
  const root = makeTempDir("maclauncher-construct-");
  try {
    const c3Dir = path.join(root, "construct3");
    writeFile(path.join(c3Dir, "index.html"), "<html></html>");
    writeFile(path.join(c3Dir, "c3runtime.js"), "");

    const detected = Modules.detectGame(c3Dir);
    assert.equal(detected.engine, "construct");
    assert.equal(detected.moduleData.constructRuntime, "Construct 3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Construct C3 exports without c3runtime.js", t => {
  const repoRoot = path.resolve(__dirname, "..");
  const exampleDir = path.join(repoRoot, ".local", "example_games", "construct_dating_killmulator");
  if (!fs.existsSync(exampleDir)) {
    t.skip();
    return;
  }
  const detected = Modules.detectGame(exampleDir);
  assert.equal(detected.engine, "construct");
  assert.equal(detected.moduleData.constructRuntime, "Construct 3");
});

test("detectGame identifies Construct package.nw bundles", t => {
  const repoRoot = path.resolve(__dirname, "..");
  const exampleDir = path.join(repoRoot, ".local", "example_games", "construct_BioEvil4");
  const packageNw = path.join(exampleDir, "package.nw");
  if (!fs.existsSync(packageNw)) {
    t.skip();
    return;
  }
  const detected = Modules.detectGame(exampleDir);
  assert.equal(detected.engine, "construct");
  assert.equal(detected.moduleData.packagedType, "package.nw");
  assert.equal(detected.moduleData.packagedPath, packageNw);
  assert.equal(detected.moduleData.constructRuntime, "Construct 2");
});

test("detectGame identifies NScripter roots", () => {
  const root = makeTempDir("maclauncher-nscripter-");
  try {
    writeFile(path.join(root, "nscript.dat"), "dummy");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "nscripter");
    assert.equal(detected.gameType, "scripted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies NScripter roots with 0.utf", () => {
  const root = makeTempDir("maclauncher-nscripter-");
  try {
    writeFile(path.join(root, "0.utf"), "dummy");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "nscripter");
    assert.equal(detected.gameType, "scripted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies NScripter packaged exe", t => {
  if (process.platform !== "darwin") {
    t.skip();
    return;
  }
  const repoRoot = path.resolve(__dirname, "..");
  const exePath = path.join(
    repoRoot,
    ".local",
    "example_games",
    "nscripter_exe",
    "nscripter_40days.exe"
  );
  if (!fs.existsSync(exePath)) {
    t.skip();
    return;
  }
  const detected = Modules.detectGame(exePath);
  assert.equal(detected.engine, "nscripter");
  assert.equal(detected.gamePath, exePath);
  assert.equal(detected.moduleData.packagedPath, exePath);
  assert.ok(detected.moduleData.packagedType);
});

test("detectGame identifies Tyrano roots with kag.js", () => {
  const root = makeTempDir("maclauncher-tyrano-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    writeFile(
      path.join(root, "tyrano", "plugins", "kag", "kag.js"),
      "TYRANO_ENGINE_VERSION = \"5.10\";"
    );
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "tyrano");
    assert.equal(detected.moduleData.version, "5.10");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame falls back to Web module for generic index.html", () => {
  const root = makeTempDir("maclauncher-web-");
  try {
    writeFile(path.join(root, "index.html"), "<html></html>");
    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.gameType, "web");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web app bundles", () => {
  const root = makeTempDir("maclauncher-web-app-");
  const appPath = path.join(root, "Web.app");
  try {
    const appNw = path.join(appPath, "Contents", "Resources", "app.nw");
    writeFile(path.join(appNw, "index.html"), "<html></html>");
    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appNw);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web app bundles with Resources/app dist layout", () => {
  const root = makeTempDir("maclauncher-web-app-");
  const appPath = path.join(root, "WebDist.app");
  try {
    const appRoot = path.join(appPath, "Contents", "Resources", "app");
    writeFile(path.join(appRoot, "dist", "index.html"), "<html></html>");
    writeJson(path.join(appRoot, "package.json"), { name: "web-dist" });
    fs.mkdirSync(path.join(appRoot, "node_modules"), { recursive: true });

    const detected = Modules.detectGame(appPath);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appRoot);
    assert.equal(detected.indexHtml, path.join(appRoot, "dist", "index.html"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detectGame identifies Web resources/app dist layout", () => {
  const root = makeTempDir("maclauncher-web-resources-");
  try {
    const appRoot = path.join(root, "resources", "app");
    writeFile(path.join(appRoot, "dist", "index.html"), "<html></html>");
    writeJson(path.join(appRoot, "package.json"), { name: "web-resources" });
    fs.mkdirSync(path.join(appRoot, "node_modules"), { recursive: true });

    const detected = Modules.detectGame(root);
    assert.equal(detected.engine, "web");
    assert.equal(detected.contentRootDir, appRoot);
    assert.equal(detected.indexHtml, path.join(appRoot, "dist", "index.html"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supported module labels include RPG Maker and Ren'Py", () => {
  const labels = Modules.listSupportedModules();
  assert.ok(labels.includes("RPG Maker MV"));
  assert.ok(labels.includes("RPG Maker MZ"));
  assert.ok(labels.includes("RPG Maker XP/VX/VX Ace"));
  assert.ok(labels.includes("Ren'Py"));
});
