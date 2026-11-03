const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("../src/modules/nscripter/main");
const Identity = require("../src/modules/nscripter/identity");
const Arguments = require("../src/modules/shared/runtime/launch-arguments");
const { applySaveIdentity } = require("../src/core/save-identity");
function fixture(t, gameId = "saved-game-id") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nscripter-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "0.txt"), "*define\ngame\n*start\nend\n");
  return { gameId, runtimeId: "onscripter_en", gamePath: root, contentRootDir: root };
}
const apply = (entry, games = []) => applySaveIdentity(entry, { games, describe: Module.resolveSaveIdentity });

test("EN keeps direct defaults and only shared import separates an actual length-ID collision", t => {
  const first = fixture(t), second = fixture(t, "another-game-id");
  second.launchArguments = '--fullscreen "authored value"';
  second.moduleData = { ordinaryMetadata: "preserved" };
  Module.onImport(first, {}); Module.onImport(second, {});
  assert.equal(first.launchArguments, undefined);
  assert.equal(second.launchArguments, '--fullscreen "authored value"');
  assert.equal(apply(first).launchArguments, undefined);
  const firstFact = Module.resolveSaveIdentity(first), secondFact = Module.resolveSaveIdentity(second);
  assert.equal(firstFact.identity, secondFact.identity);
  const separated = apply(second, [first]);
  assert.deepEqual(Arguments.parse(separated.launchArguments), ["--gameid", second.gameId, "--fullscreen", "authored value"]);
  assert.equal(separated.moduleData.ordinaryMetadata, "preserved");
  assert.notEqual(Module.resolveSaveIdentity(separated).identity, firstFact.identity);
  assert.equal(second.launchArguments, '--fullscreen "authored value"');
  assert.equal(apply(second, [second]).launchArguments, second.launchArguments);
});

test("EN facts preserve authored IDs, arguments and explicit save choices", t => {
  const entry = fixture(t);
  fs.writeFileSync(path.join(entry.gamePath, "game.id"), "author-game-id\n");
  assert.equal(Module.resolveSaveIdentity(entry).identity, path.join(os.homedir(), "Library", "Application Support", "author-game-id"));
  assert.equal(apply(entry).launchArguments, undefined);
  fs.rmSync(path.join(entry.gamePath, "game.id"));
  fs.writeFileSync(path.join(entry.gamePath, "0.txt"), ";mode800\n;gameid authored-script-id\n*define\ngame\n*start\nend\n");
  assert.equal(Module.resolveSaveIdentity(entry).identity, path.join(os.homedir(), "Library", "Application Support", "authored-script-id"));
  for (const launchArguments of ['--gameid "authored title" --window', "--gameid=authored-id", "--gameid ''", "--gameid"]) {
    const current = { ...entry, launchArguments };
    assert.equal(apply(current, [entry]).launchArguments, launchArguments);
  }
  fs.rmSync(path.join(entry.gamePath, "0.txt"));
  const explicit = { ...entry, saveDirOverride: path.join(os.tmpdir(), "intentional-save-choice") };
  assert.equal(Module.resolveSaveIdentity(explicit).explicit, true);
  assert.equal(Module.resolveSaveIdentity(explicit).identity, explicit.saveDirOverride);
  assert.equal(apply(explicit).saveDirOverride, explicit.saveDirOverride);
});

test("EN fallback facts use upstream CRLF normalization, numbered scripts and existing XOR decoder", t => {
  const entry = fixture(t), first = "*define\r\ngame\r\n", extra = "*start\rend\r";
  fs.writeFileSync(path.join(entry.gamePath, "0.txt"), first);
  fs.writeFileSync(path.join(entry.gamePath, "01.txt"), extra);
  const size = first.replace(/\r\n?/g, "\n").length + 1 + extra.replace(/\r\n?/g, "\n").length + 1;
  assert.equal(Module.resolveSaveIdentity(entry).identity, path.join(os.homedir(), "Library", "Application Support", "ONScripter-" + size.toString(16)));
  fs.rmSync(path.join(entry.gamePath, "0.txt")); fs.rmSync(path.join(entry.gamePath, "01.txt"));
  const encoded = Buffer.from(first); for (let i = 0; i < encoded.length; i++) encoded[i] ^= 0x84;
  fs.writeFileSync(path.join(entry.gamePath, "nscript.dat"), encoded);
  const encryptedSize = first.replace(/\r\n?/g, "\n").length + 1;
  assert.equal(Module.resolveSaveIdentity(entry).identity, path.join(os.homedir(), "Library", "Application Support", "ONScripter-" + encryptedSize.toString(16)));
});

test("unknown EN facts keep direct behavior and ordinary presentation reads only current arguments", t => {
  const entry = fixture(t);
  fs.writeFileSync(path.join(entry.gamePath, "0.txt"), ";$G4096,S800,600\n*define\ngame\n*start\nend\n");
  assert.equal(Module.resolveSaveIdentity(entry), null);
  assert.equal(apply(entry).launchArguments, undefined);
  fs.writeFileSync(path.join(entry.gamePath, "0.txt"), ";mode\n;gameid not-inferred\n*define\ngame\n");
  assert.equal(Module.resolveSaveIdentity(entry), null, "unparsed control headers do not invent a save identity");
  fs.rmSync(path.join(entry.gamePath, "0.txt"));
  assert.equal(Module.resolveSaveIdentity(entry), null);
  entry.launchArguments = "--gameid current-id";
  assert.equal(Identity.saveDirectory(entry), path.join(os.homedir(), "Library", "Application Support", "current-id"));
  assert.equal(Module.resolveSaveLocations(entry).primaryDirectory, Identity.saveDirectory(entry));
  assert.equal(Module.resolveSaveIdentity({ ...entry, runtimeId: "onsyuri_mac" }), null);
});
