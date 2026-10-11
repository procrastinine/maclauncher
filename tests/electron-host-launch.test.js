const test = require("node:test");
const assert = require("node:assert/strict");
const { createElectronHostLaunch } = require("../src/core/electron-binary");

test("a renamed development Electron host receives an application entry point", () => {
  const env = { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_START_URL: "http://127.0.0.1:5174/", KEEP: "value" };
  const launch = createElectronHostLaunch({ executable: "/cache/MacLauncher.app/Contents/MacOS/MacLauncher",
    appPath: "/project/src/main/bootstrap.js", gamePath: "/games/A game/Game.exe",
    runtimeId: "electron", userDataDir: "/state/Application Support/maclauncher", env });
  assert.deepEqual(launch.args, ["/project/src/main/bootstrap.js", "--maclauncher-runtime-host",
    "--game=/games/A game/Game.exe", "--runtime=electron", "--user-data=/state/Application Support/maclauncher"]);
  assert.deepEqual(launch.env, { PATH: "/usr/bin:/bin", KEEP: "value" });
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.ELECTRON_START_URL, "http://127.0.0.1:5174/");
});

test("packaged and plain Node hosts use the same explicit entry-point contract", () => {
  for (const appPath of ["/Applications/MacLauncher.app/Contents/Resources/app.asar/src/main/bootstrap.js",
    "/source/src/runtime/electron-game.js"]) {
    const launch = createElectronHostLaunch({ executable: "/runtime/Contents/MacOS/MacLauncher", appPath,
      gamePath: "/games/Unicode ✨/index.html", userDataDir: "/state", env: {} });
    assert.equal(launch.args[0], appPath);
    assert.equal(launch.args[1], "--maclauncher-runtime-host");
    assert(launch.args.includes("--game=/games/Unicode ✨/index.html"));
    assert(launch.args.includes("--runtime=electron"));
  }
});

test("missing host inputs fail before opening Electron's default application", () => {
  const options = { executable: "/runtime", appPath: "/source/bootstrap.js", gamePath: "/game", runtimeId: "electron", userDataDir: "/state" };
  for (const key of ["executable", "appPath", "gamePath", "userDataDir"]) {
    for (const value of [undefined, "", " ", 1]) {
      assert.throws(() => createElectronHostLaunch({ ...options, [key]: value }), { name: "TypeError" });
    }
  }
  assert.throws(() => createElectronHostLaunch({ ...options, runtimeId: "" }), { name: "TypeError" });
});
