const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const NwjsLauncher = require("../src/modules/shared/web/runtime/nwjs-launcher");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("launchRuntime errors when NW.js runtime is not installed", async () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-launcher-");
  try {
    await assert.rejects(
      () =>
        NwjsLauncher.launchRuntime({
          entry: {},
          moduleId: "mv",
          userDataDir,
          settings: {}
        }),
      /NW\.js runtime.*not installed/i
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("buildWrapper adds protections metadata when enabled", () => {
  const prevDevtools = process.env.MACLAUNCHER_DEVTOOLS;
  process.env.MACLAUNCHER_DEVTOOLS = "1";
  const userDataDir = makeTempDir("maclauncher-nwjs-launcher-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const indexHtml = path.join(gameRoot, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>Test</title>", "utf8");
    fs.writeFileSync(
      path.join(gameRoot, "package.json"),
      JSON.stringify(
        {
          name: "test-game",
          main: "index.html",
          "chromium-args": "--custom-flag --disable-devtools",
          inject_js_start: "existing-start.js"
        },
        null,
        2
      ),
      "utf8"
    );

    const wrapperDir = NwjsLauncher.buildWrapper({
      entry: {
        gamePath: gameRoot,
        contentRootDir: gameRoot,
        indexHtml
      },
      moduleId: "mv",
      userDataDir,
      supportsCheats: false,
      toolsButtonVisible: true,
      enableProtections: true
    });

    const wrapperPkg = JSON.parse(
      fs.readFileSync(path.join(wrapperDir, "package.json"), "utf8")
    );
    assert.equal(wrapperPkg["bg-script"], "bg.js");
    assert.equal(Object.prototype.hasOwnProperty.call(wrapperPkg, "permissions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wrapperPkg, "background"), false);
    assert.equal(wrapperPkg.inject_js_start, "maclauncher-start.js");
    assert.ok(wrapperPkg.maclauncher);
    assert.equal(wrapperPkg.maclauncher.offlineEnabled, true);
    assert.ok(Array.isArray(wrapperPkg.maclauncher.injectStart));
    assert.ok(wrapperPkg.maclauncher.injectStart.includes("existing-start.js"));
    assert.ok(fs.existsSync(path.join(wrapperDir, "maclauncher-start.js")));
    const startScript = fs.readFileSync(path.join(wrapperDir, "maclauncher-start.js"), "utf8");
    assert.ok(startScript.includes("maclauncher:devtools-keybinding"));
    assert.ok(fs.existsSync(path.join(wrapperDir, "maclauncher-offline.js")));
    assert.ok(wrapperPkg["chromium-args"].includes("--custom-flag"));
    assert.equal(wrapperPkg["chromium-args"].includes("--disable-devtools"), false);
    assert.ok(wrapperPkg["chromium-args"].includes("--disable-background-networking"));
    assert.ok(wrapperPkg["chromium-args"].includes("--disable-component-update"));
    assert.ok(wrapperPkg["chromium-args"].includes("--disable-domain-reliability"));
    assert.ok(wrapperPkg["chromium-args"].includes("--dns-prefetch-disable"));
    assert.ok(wrapperPkg["chromium-args"].includes("--proxy-server=127.0.0.1:9"));
    assert.ok(wrapperPkg["chromium-args"].includes("--proxy-bypass-list=<-loopback>"));
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

test("buildWrapper strips protections when disabled", () => {
  const prevDevtools = process.env.MACLAUNCHER_DEVTOOLS;
  process.env.MACLAUNCHER_DEVTOOLS = "1";
  const userDataDir = makeTempDir("maclauncher-nwjs-launcher-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const indexHtml = path.join(gameRoot, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>Test</title>", "utf8");
    fs.writeFileSync(
      path.join(gameRoot, "package.json"),
      JSON.stringify(
        {
          name: "test-game",
          main: "index.html",
          "bg-script": "bg.js"
        },
        null,
        2
      ),
      "utf8"
    );

    const wrapperDir = NwjsLauncher.buildWrapper({
      entry: {
        gamePath: gameRoot,
        contentRootDir: gameRoot,
        indexHtml
      },
      moduleId: "mv",
      userDataDir,
      supportsCheats: false,
      toolsButtonVisible: true,
      enableProtections: false
    });

    const wrapperPkg = JSON.parse(
      fs.readFileSync(path.join(wrapperDir, "package.json"), "utf8")
    );
    assert.equal(Object.prototype.hasOwnProperty.call(wrapperPkg, "bg-script"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(wrapperPkg, "background"), false);
    assert.equal(wrapperPkg.inject_js_start, "maclauncher-devtools.js");
    assert.ok(fs.existsSync(path.join(wrapperDir, "maclauncher-devtools.js")));
    const chromiumArgs = String(wrapperPkg["chromium-args"] || "");
    assert.equal(chromiumArgs.includes("--disable-background-networking"), false);
    assert.equal(chromiumArgs.includes("--proxy-server=127.0.0.1:9"), false);
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

test("buildWrapper preserves injected start files", () => {
  const userDataDir = makeTempDir("maclauncher-nwjs-launcher-");
  const gameRoot = makeTempDir("maclauncher-nwjs-game-");
  try {
    const indexHtml = path.join(gameRoot, "index.html");
    fs.writeFileSync(indexHtml, "<!doctype html><title>Test</title>", "utf8");
    fs.writeFileSync(
      path.join(gameRoot, "package.json"),
      JSON.stringify(
        {
          name: "test-game",
          main: "index.html"
        },
        null,
        2
      ),
      "utf8"
    );

    const wrapperDir = NwjsLauncher.buildWrapper({
      entry: {
        gamePath: gameRoot,
        contentRootDir: gameRoot,
        indexHtml
      },
      moduleId: "construct",
      userDataDir,
      supportsCheats: false,
      toolsButtonVisible: true,
      enableProtections: false,
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
