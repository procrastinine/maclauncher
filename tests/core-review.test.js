const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLauncher } = require("../src/core/launcher");
const GameStore = require("../src/core/game-store");
const { watchFileChanges } = require("../src/core/watch-files");
const { writeJsonAtomic } = require("../src/core/json-files");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-core-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function until(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(typeof message === "function" ? message() : message);
}

test("review: resolving an alternate input for the same game preserves identity and overrides", async t => {
  const root = fixture(t);
  const gamePath = path.join(root, "game");
  const indexHtml = path.join(gamePath, "index.html");
  fs.mkdirSync(gamePath);
  fs.writeFileSync(indexHtml, "<title>Review fixture</title>");
  const launcher = createLauncher({ userDataDir: path.join(root, "userData") });
  const first = await launcher.resolveEntry(gamePath);
  first.saveDirOverride = path.join(root, "custom-saves");
  first.runtimeSettings = { electron: { enableProtections: false } };
  launcher.persistEntry(first);

  const second = await launcher.resolveEntry(indexHtml);
  assert.equal(second.gamePath, first.gamePath);
  assert.equal(second.gameId, first.gameId, "folder and index.html must share the saved record");
  assert.equal(second.saveDirOverride, first.saveDirOverride);
  assert.deepEqual(second.runtimeSettings, first.runtimeSettings);
  assert.equal(GameStore.loadGames(launcher.userDataDir).length, 1);
});

test("review: an action that changes no settings preserves updates made while it runs", async t => {
  const userDataDir = fixture(t);
  const settingsPath = path.join(userDataDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    modules: {}, runtimes: { nwjs: { defaultVersion: "0.107.0" } },
    launcher: { showIcons: true, library: { favorites: [] } }
  }));
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const info = { id: "review" };
  const mod = { actions: { longAction: async () => { entered(); await gate; return true; } } };
  const registry = {
    listModules: () => [info], getModule: () => mod, getModuleInfo: () => info
  };
  const launcher = createLauncher({ userDataDir, registry });
  const pending = launcher.runAction({ gameId: "review", moduleId: "review", gamePath: userDataDir }, "longAction");
  await started;

  // A second launcher/CLI process saves preferences during a long extraction action.
  const updated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  updated.launcher.showIcons = false;
  updated.launcher.library.favorites = ["favorite"];
  updated.runtimes.nwjs.defaultVersion = "0.108.0";
  fs.writeFileSync(settingsPath, JSON.stringify(updated));
  finish();
  await pending;

  const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(stored.launcher.showIcons, false, "the action must not restore its stale settings snapshot");
  assert.deepEqual(stored.launcher.library.favorites, ["favorite"]);
  assert.equal(stored.runtimes.nwjs.defaultVersion, "0.108.0");
});

test("review: an action changing one runtime setting preserves concurrent preferences", async t => {
  for (const hasRuntimeConfig of [true, false]) {
    await t.test(hasRuntimeConfig ? "existing runtime configuration" : "initially absent runtime configuration", async t => {
      const userDataDir = fixture(t);
      const settingsPath = path.join(userDataDir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({
        modules: {},
        runtimes: hasRuntimeConfig ? { nwjs: { defaultVersion: "0.107.0" } } : {},
        launcher: { showIcons: true, library: { favorites: [] } }
      }));
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      let finish;
      const gate = new Promise(resolve => { finish = resolve; });
      const info = { id: "review" };
      const mod = { actions: { setVersion: async (_entry, _payload, context) => {
        entered();
        await gate;
        context.settings.runtimes.nwjs ||= {};
        context.settings.runtimes.nwjs.defaultVersion = "0.109.0";
        return true;
      } } };
      const registry = {
        listModules: () => [info], getModule: () => mod, getModuleInfo: () => info
      };
      const launcher = createLauncher({ userDataDir, registry });
      const pending = launcher.runAction({ gameId: "review", moduleId: "review", gamePath: userDataDir }, "setVersion");
      await started;

      const updated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      updated.launcher.showIcons = false;
      updated.launcher.library.favorites = ["favorite"];
      updated.runtimes.godot = { defaultVersion: "4.5" };
      updated.runtimes.nwjs = {
        ...updated.runtimes.nwjs, greenworksDefaultVersion: "0.108.0"
      };
      fs.writeFileSync(settingsPath, JSON.stringify(updated));
      finish();
      await pending;

      const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(stored.runtimes.nwjs.defaultVersion, "0.109.0", "the action's change must be persisted");
      assert.equal(stored.launcher.showIcons, false);
      assert.deepEqual(stored.launcher.library.favorites, ["favorite"]);
      assert.deepEqual(stored.runtimes.godot, { defaultVersion: "4.5" });
      assert.equal(stored.runtimes.nwjs.greenworksDefaultVersion, "0.108.0",
        "creating a runtime configuration must not replace concurrent sibling preferences");
    });
  }
});

test("review: launcher-style cheat watchers continue observing runtime writes after atomic replacement", async t => {
  if (!["darwin", "linux"].includes(process.platform)) return t.skip("inode-based file watching");
  const root = fixture(t);
  const filePath = path.join(root, "cheats.json");
  fs.writeFileSync(filePath, "{}");
  const events = [];
  // Exercise the same subscription helper used by main.js syncCheatsFiles.
  const watcher = watchFileChanges(filePath, () => events.push("change"));
  t.after(() => watcher.close());
  await delay(200);
  fs.writeFileSync(filePath, '{"value":1}');
  await until(() => events.length > 0, "baseline file write was not observed");
  await delay(250);

  writeJsonAtomic(filePath, { value: 2 });
  await delay(500);
  const beforeRuntimeWrite = events.length;
  fs.writeFileSync(filePath, '{"value":3}');
  await delay(500);
  assert.ok(events.length > beforeRuntimeWrite, "the saved watcher is still attached to the replaced inode");
});

test("review: terminating a waited native CLI game also terminates its descendants", { timeout: 10000 }, async t => {
  if (process.platform !== "darwin") return t.skip("native macOS app fixture");
  const root = fixture(t);
  const appPath = path.join(root, "Review.app");
  const macos = path.join(appPath, "Contents", "MacOS");
  const resources = path.join(appPath, "Contents", "Resources", "app.nw");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "index.html"), "<title>Review fixture</title>");
  const pidFile = path.join(root, "descendant.pid");
  fs.writeFileSync(path.join(macos, "Review"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const cli = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "run-game.mjs"),
    "--game", appPath, "--runtime", "native",
    "--user-data", path.join(root, "userData"), "--wait"
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  cli.stdout.resume();
  cli.stderr.on("data", data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", (code, signal) => resolve({ code, signal }));
  });
  let descendantPid;
  t.after(() => {
    try { if (descendantPid) process.kill(descendantPid, "SIGKILL"); } catch {}
    try { if (cli.exitCode === null) cli.kill("SIGKILL"); } catch {}
  });
  await until(() => {
    assert.equal(cli.exitCode, null, `native CLI exited before its game started: ${stderr}`);
    return fs.existsSync(pidFile);
  }, () => `native game did not start: ${stderr}`, 6000);
  descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  await delay(100);
  cli.kill("SIGTERM");
  const result = await closed;
  assert.equal(result.code, 1);
  await delay(200);
  let descendantAlive = false;
  try { process.kill(descendantPid, 0); descendantAlive = true; } catch {}
  assert.equal(descendantAlive, false, "SIGTERM reached only the direct game process, leaving its child running");
});
