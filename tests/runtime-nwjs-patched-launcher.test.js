const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Patched = require("../src/modules/shared/web/runtime/nwjs-patched-launcher");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("buildWrapper writes patched config and inject metadata", () => {
  const prevDevtools = process.env.MACLAUNCHER_DEVTOOLS;
  process.env.MACLAUNCHER_DEVTOOLS = "1";
  const userDataDir = makeTempDir("maclauncher-nwjs-patched-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const indexHtml = path.join(gameRoot, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>Test</title>", "utf8");
    fs.writeFileSync(
      path.join(gameRoot, "package.json"),
      JSON.stringify(
        {
          name: "patched-game",
          main: "index.html",
          "chromium-args": "--custom-flag --disable-devtools",
          inject_js_start: "existing-start.js",
          inject_js_end: "existing-end.js"
        },
        null,
        2
      ),
      "utf8"
    );

    const wrapperDir = Patched.buildWrapper({
      entry: {
        gamePath: gameRoot,
        contentRootDir: gameRoot,
        indexHtml
      },
      moduleId: "mv",
      userDataDir,
      supportsCheats: false,
      toolsButtonVisible: true,
      runtimeSettings: {
        caseInsensitive: true,
        enableUserScripts: true
      },
      patchConfig: {
        modules: ["rpg-inject.mjs", "rpg-remap.mjs"],
        scripts: ["mv-decrypted-assets.js"],
        userScriptRoot: gameRoot
      }
    });

    const wrapperPkg = JSON.parse(
      fs.readFileSync(path.join(wrapperDir, "package.json"), "utf8")
    );
    assert.equal(wrapperPkg.inject_js_start, "maclauncher-start.js");
    assert.equal(wrapperPkg.inject_js_end, "maclauncher-end.js");
    assert.ok(wrapperPkg.maclauncher);
    assert.ok(Array.isArray(wrapperPkg.maclauncher.injectStart));
    assert.ok(wrapperPkg.maclauncher.injectStart.includes("existing-start.js"));
    assert.ok(Array.isArray(wrapperPkg.maclauncher.injectEnd));
    assert.ok(wrapperPkg.maclauncher.injectEnd.includes("existing-end.js"));
    assert.equal(wrapperPkg.maclauncher.caseInsensitive, true);
    assert.equal(wrapperPkg.maclauncher.patchedConfigPath, "__maclauncher/nwjs-patched/patch.json");
    assert.ok(wrapperPkg["chromium-args"].includes("--custom-flag"));
    assert.equal(wrapperPkg["chromium-args"].includes("--disable-devtools"), false);

    const startScript = fs.readFileSync(path.join(wrapperDir, "maclauncher-start.js"), "utf8");
    assert.ok(startScript.includes("maclauncher:devtools-keybinding"));

    const patchedRoot = path.join(wrapperDir, "__maclauncher", "nwjs-patched");
    assert.ok(fs.existsSync(path.join(patchedRoot, "loader.js")));
    assert.ok(fs.existsSync(path.join(patchedRoot, "case-insensitive-nw.js")));
    const config = JSON.parse(
      fs.readFileSync(path.join(patchedRoot, "patch.json"), "utf8")
    );
    assert.deepEqual(config.modules, ["rpg-inject.mjs", "rpg-remap.mjs"]);
    assert.deepEqual(config.scripts, ["mv-decrypted-assets.js"]);
    assert.equal(config.enableUserScripts, true);
    assert.equal(config.userScriptRoot, gameRoot);
  } finally {
    if (prevDevtools === undefined) {
      delete process.env.MACLAUNCHER_DEVTOOLS;
    } else {
      process.env.MACLAUNCHER_DEVTOOLS = prevDevtools;
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
});

test("buildWrapper includes requested start injections", () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-patched-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const indexHtml = path.join(gameRoot, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>Test</title>", "utf8");
    fs.writeFileSync(
      path.join(gameRoot, "package.json"),
      JSON.stringify(
        {
          name: "patched-game",
          main: "index.html"
        },
        null,
        2
      ),
      "utf8"
    );

    const wrapperDir = Patched.buildWrapper({
      entry: {
        gamePath: gameRoot,
        contentRootDir: gameRoot,
        indexHtml
      },
      moduleId: "construct",
      userDataDir,
      supportsCheats: false,
      toolsButtonVisible: true,
      runtimeSettings: {},
      patchConfig: {},
      injectStart: ["maclauncher-construct-webview2.js"],
      extraFiles: [
        {
          path: "maclauncher-construct-webview2.js",
          contents: "// shim"
        }
      ]
    });

    const wrapperPkg = JSON.parse(
      fs.readFileSync(path.join(wrapperDir, "package.json"), "utf8")
    );
    assert.equal(wrapperPkg.inject_js_start, "maclauncher-start.js");
    assert.ok(wrapperPkg.maclauncher);
    assert.ok(Array.isArray(wrapperPkg.maclauncher.injectStart));
    assert.ok(wrapperPkg.maclauncher.injectStart.includes("maclauncher-construct-webview2.js"));
    const shimPath = path.join(wrapperDir, "maclauncher-construct-webview2.js");
    assert.ok(fs.existsSync(shimPath));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
});

test("resolveGreenworksRequirement detects steamworks usage and selects a version", () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-greenworks-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const greenworksRoot = path.join(gameRoot, "node_modules", "greenworks");
    fs.mkdirSync(greenworksRoot, { recursive: true });
    fs.writeFileSync(path.join(greenworksRoot, "greenworks.js"), "");

    const installDir = path.join(userDataDir, "runtimes", "greenworks", "0.103.1");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "greenworks.js"), "");

    const withDefault = Patched.resolveGreenworksRequirement({
      userDataDir,
      managerSettings: { greenworksDefaultVersion: "0.103.1" },
      sourceRoot: gameRoot
    });
    assert.equal(withDefault.needsGreenworks, true);
    assert.equal(withDefault.greenworksVersion, "0.103.1");
    assert.ok(withDefault.targets.length > 0);

    const withoutDefault = Patched.resolveGreenworksRequirement({
      userDataDir,
      managerSettings: {},
      sourceRoot: gameRoot
    });
    assert.equal(withoutDefault.needsGreenworks, true);
    assert.equal(withoutDefault.greenworksVersion, "0.103.1");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
});
