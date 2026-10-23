const test = require("node:test");
const assert = require("node:assert/strict");
const Arguments = require("../src/modules/shared/runtime/launch-arguments");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GameStore = require("../src/core/game-store");
const { createLauncher } = require("../src/core/launcher");

test("pasted launch arguments preserve quoted values, empty arguments, paths and literal shell syntax", () => {
  assert.deepEqual(Arguments.parse(' --windowed --name "Example name" \' leading and trailing \' "" one\\ two '),
    ["--windowed", "--name", "Example name", " leading and trailing ", "", "one two"]);
  assert.deepEqual(Arguments.parse('"C:\\Games\\A Game" "a\\\"b" \'$(touch forbidden)\' $HOME *.sav ; | > #literal'),
    ["C:\\Games\\A Game", 'a"b', "$(touch forbidden)", "$HOME", "*.sav", ";", "|", ">", "#literal"]);
  assert.deepEqual(Arguments.parse("line\\\ncontinued 'inside\nquote'"), ["linecontinued", "inside\nquote"]);
  assert.deepEqual(Arguments.parse(""), []);
  assert.deepEqual(Arguments.parse("\\\n"), []);
});

test("invalid quoting and bounded argument sizes fail before launch", () => {
  for (const value of ['"unclosed', "'unclosed", "escape\\", "bad\0argument", "x".repeat(32769), "x ".repeat(257), "x".repeat(16385)])
    assert.throws(() => Arguments.parse(value), /Launch arguments/);
  for (const value of [null, "--foo", [1], ["\0"], Array(257).fill(""), Array(3).fill("x".repeat(16384))])
    assert.throws(() => Arguments.validate(value), /Launch arguments/);
});

test("game arguments survive runtime changes and concurrent notes without changing runtime settings", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-arguments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { id: "test", runtime: { supported: ["first", "second"], default: "first" } };
  const registry = { listModules: () => [manifest], getModule: () => ({ manifest }), getModuleInfo: () => manifest,
    detectGame: input => ({ moduleId: "test", gamePath: input, name: "Game" }) };
  const launcher = createLauncher({ userDataDir: root, registry });
  const entry = await launcher.resolveEntry(root);
  entry.runtimeSettings = { first: { keep: true } };
  launcher.persistEntry(entry);
  GameStore.setGameNotes(root, entry.gameId, "Keep this note");
  await launcher.runAction(entry, "setGameLaunchArguments", { launchArguments: '--name "Game name" ""' });
  let stored = GameStore.readGameRecord(root, entry.gameId);
  assert.equal(stored.notes, "Keep this note");
  assert.deepEqual(stored.runtimeSettings, { first: { keep: true } });
  for (const runtimeId of manifest.runtime.supported) {
    const context = launcher.getLaunchContext({ ...entry, runtimeId }, undefined, { gameEffects: true });
    assert.deepEqual(context.gameArguments, ["--name", "Game name", ""]);
    assert.equal((await context.applyGameEnvironment({ KEEP: "1" })).MACLAUNCHER_GAME_ARGUMENTS,
      '["--name","Game name",""]');
    assert.deepEqual(await context.applyGameEnvironment({ KEEP: "1", MACLAUNCHER_GAME_ARGUMENTS: '["old"]' }, { gameArguments: false }),
      { KEEP: "1" }, "service processes exclude game arguments");
  }
  const toolsContext = launcher.getLaunchContext(entry);
  assert.deepEqual(toolsContext.gameArguments, [], "tools receive no game arguments");
  assert.deepEqual(await toolsContext.applyGameEnvironment({ MACLAUNCHER_GAME_ARGUMENTS: '["old"]' }), {},
    "tools do not inherit another game's arguments");
  const emptyContext = launcher.getLaunchContext({ ...entry, launchArguments: "" }, undefined, { gameEffects: true });
  assert.equal((await emptyContext.applyGameEnvironment({ MACLAUNCHER_GAME_ARGUMENTS: '["old"]' })).MACLAUNCHER_GAME_ARGUMENTS, undefined);
  const rediscovered = await launcher.resolveEntry(root);
  assert.equal(rediscovered.launchArguments, entry.launchArguments);
  await assert.rejects(launcher.runAction(entry, "setGameLaunchArguments", { launchArguments: '"unclosed' }), /unclosed quote/);
  stored = GameStore.readGameRecord(root, entry.gameId);
  assert.equal(stored.launchArguments, '--name "Game name" ""');
  assert.throws(() => GameStore.setGameLaunchArguments(root, entry.gameId, undefined), /must be text/);
});
