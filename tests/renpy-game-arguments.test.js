const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const Renpy = require("../src/modules/renpy/main");

test("Ren'Py SDK and patched games preserve quoted arguments after their project and run parameters", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "renpy-game-arguments-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "data"), gameRoot = path.join(root, "game-source");
  const sdk = path.join(userDataDir, "runtimes/sdk/8/8.5.3");
  const source = '#!/bin/sh\nprintf "%s\\0" "$@"\n';
  for (const runtimeRoot of [gameRoot, sdk]) {
    const lib = path.join(runtimeRoot, "lib/py3-mac-universal");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, "renpy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(runtimeRoot, runtimeRoot === sdk ? "renpy.sh" : "Game.sh"), source, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(gameRoot, "game"));
  fs.writeFileSync(path.join(gameRoot, "game/script.rpy"), "label start:\n    return\n");
  const gameArguments = ["--title", "  A quoted game  ", "", "$(touch unexpected)", "first\nsecond", "'literal'"];
  for (const runtimeId of ["sdk", "patched"]) {
    const entry = { gameId: `arguments-${runtimeId}`, moduleId: "renpy", gamePath: gameRoot, contentRootDir: gameRoot,
      runtimeId, runtimeData: { sdk: { version: "8.5.3" } },
      moduleData: { major: 8, version: "8.5.3", baseName: "Game" } };
    let received;
    const result = await Renpy.launchRuntime(runtimeId, entry, { userDataDir, settings: {}, gameArguments,
      spawnDetachedChecked(command, args, options) {
        received = { command, args, options };
        return spawnSync(command, args, { ...options, encoding: "utf8" });
      } });
    assert.equal(result.status, 0, result.stderr);
    const observed = result.stdout.split("\0").slice(0, -1);
    assert.deepEqual(observed.slice(-gameArguments.length), gameArguments, runtimeId);
    if (runtimeId === "sdk") {
      assert.deepEqual(observed.slice(0, 2), [received.options.cwd, "run"]);
      assert.equal(received.command, path.join(sdk, "renpy.sh"));
    } else {
      assert.deepEqual(observed, gameArguments);
      assert.equal(received.options.cwd, gameRoot);
      assert.equal(received.command, path.join(gameRoot, "Game.sh"));
    }
    assert.equal(fs.existsSync(path.join(received.options.cwd, "unexpected")), false);
  }
});
