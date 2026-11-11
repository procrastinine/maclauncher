const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const GameData = require("../src/modules/shared/game-data");
const { processStopBinding } = require("../src/core/process-lifecycle");
const { publisherAppHooks } = require("../src/modules/shared/runtime/publisher-app");

test("a publisher app runs with the game's engine home in the launcher data and stops through a native Quit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-app-"));
  try {
    const userDataDir = path.join(root, "profile"), gameFolder = path.join(root, "game"), executablePath = path.join(root, "Engine.app", "engine");
    fs.mkdirSync(gameFolder); fs.mkdirSync(path.dirname(executablePath)); fs.writeFileSync(executablePath, "");
    const manager = { id: "engine", resolveSelection: () => ({ ready: true, install: { executablePath, needsRosetta: false } }) };
    const hooks = publisherAppHooks({ manager, moduleId: "dreamm", launchArguments: entry => ({ args: ["-run", entry.gamePath], cwd: entry.gamePath }) });
    const spawned = [], originalSpawn = async () => {};
    const context = { userDataDir, settings: {}, platform: "darwin", gameArguments: ["-extra"], onProcessSpawn: originalSpawn,
      async spawnDetachedChecked(file, args, options, needsRosetta) {
        // An exited child keeps activation and identity queries offline.
        const child = Object.assign(new EventEmitter(), { pid: 424242, exitCode: 0, signalCode: null });
        spawned.push({ file, args, options, needsRosetta, child });
        await context.onProcessSpawn(child);
        return child;
      } };
    await hooks.launchRuntime("dreamm", { gameId: "game1", gamePath: gameFolder }, context);
    const [{ file, args, options, child }] = spawned;
    const home = path.join(GameData.resolveGameModuleDir(userDataDir, "game1", "dreamm"), "home");
    assert.equal(file, executablePath);
    assert.deepEqual(args, ["-run", gameFolder, "-extra"]);
    assert.equal(options.env.HOME, home);
    assert.equal(options.env.CFFIXED_USER_HOME, home);
    for (const folder of ["Library/Preferences", "Library/Application Support", "Documents"]) assert.ok(fs.statSync(path.join(home, folder)).isDirectory(), folder);
    assert.ok(processStopBinding(child), "Stop is bound to a native Quit");
    assert.equal(context.onProcessSpawn, originalSpawn);
    await assert.rejects(hooks.launchRuntime("dreamm", { gamePath: gameFolder }, context), /saved game entry/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
