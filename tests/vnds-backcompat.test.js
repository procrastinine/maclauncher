// Released v0.5.1 VNDS save recovery; runs only on owned scratch paths.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Preparation = require("../src/modules/vnds/prepare");
const Backcompat = require("../src/modules/vnds/backcompat");

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-vnds-paths-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => path.join(root, "home"));
  const gamePath = path.join(root, "Original Novel"), context = { userDataDir: path.join(root, "profile") };
  fs.mkdirSync(gamePath);
  return { root, gamePath, context, entry: { gameId: "novel", gamePath },
    engine: () => ({ root: path.join(root, "shared-interpreter"), profile: { version: "fixture" } }) };
}

test("released v0.5.1 VNDS slots load from the new normal destination and original globals survive", async t => {
  const f = scratch(t), mod = Backcompat;
  // v0.5.1 prepare.js:13-19,74-83 and main.js:41-43.
  const releasedSaves = path.join(f.context.userDataDir, "games", f.entry.gameId, "modules", "vnds", "saves");
  const [descriptor] = mod.legacyGameMirrors(f.entry, f.context);
  assert.equal(descriptor.mirrorRoot, releasedSaves);
  const normal = path.join(os.homedir(), "Library", "Application Support", "LOVE", "VNDS-LOVE", "novels", path.basename(f.gamePath));
  assert.equal(descriptor.sourceRoot, normal);
  fs.mkdirSync(releasedSaves, { recursive: true }); fs.mkdirSync(normal, { recursive: true });
  const slot = JSON.stringify({ interpreter: { file: "main.scr", n: 2, locals: {}, globals: { released: true } } });
  fs.writeFileSync(path.join(releasedSaves, "save1.json"), slot);
  fs.writeFileSync(path.join(releasedSaves, "global.json"), JSON.stringify({ origin: "released" }));
  fs.writeFileSync(path.join(normal, "global.json"), JSON.stringify({ origin: "original" }));
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, f.context);
  assert.equal(result.complete, true);
  const prepared = await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(prepared.saveRoot, normal);
  const loaded = require("../src/modules/vnds/save").decode(fs.readFileSync(path.join(prepared.saveRoot, "save1.json"), "utf8"));
  assert.equal(JSON.parse(loaded).interpreter.globals.released, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.saveRoot, "global.json"))).origin, "original");
  const conflicts = fs.readdirSync(normal).filter(name => name.startsWith("global.json.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(normal, conflicts[0]))).origin, "released");
  assert.equal(prepared.working, f.gamePath);
  assert.equal(prepared.mountFile, path.join(path.dirname(releasedSaves), "session", "mounts.json"), "The released session remains the actual mount-plan location");
  assert.equal(fs.existsSync(releasedSaves), false);
});

test("released v0.5.1 VNDS recovery is BLOCKED when the new native destination is absent", async t => {
  const f = scratch(t), [descriptor] = Backcompat.legacyGameMirrors(f.entry, f.context);
  fs.mkdirSync(descriptor.mirrorRoot, { recursive: true });
  const slot = JSON.stringify({ interpreter: { file: "main.scr", n: 3 } });
  fs.writeFileSync(path.join(descriptor.mirrorRoot, "save1.json"), slot);
  assert.equal(fs.existsSync(descriptor.sourceRoot), false);
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(descriptor, f.context);
  assert.equal(result.complete, false, "Retained bytes are not recovered native saves");
  assert.match(result.reason, /ENOENT/);
  assert.equal(fs.existsSync(path.join(descriptor.sourceRoot, "save1.json")), false);
  assert.equal(fs.readFileSync(path.join(descriptor.mirrorRoot, "save1.json"), "utf8"), slot);
  assert.equal(result.recoveredFiles, undefined);
});

test("VNDS old writable-input records are read only by the one-time backcompat hook", async t => {
  const f = scratch(t), WritableBackcompat = require("../src/modules/shared/backcompat/writable-input");
  const sourceEntry = WritableBackcompat.sourceEntry; let legacyReads = 0;
  t.mock.method(WritableBackcompat, "sourceEntry", entry => { legacyReads++; return sourceEntry(entry); });
  const view = path.join(f.context.userDataDir, "games", f.entry.gameId, "modules", "vnds", "writable-input", "files");
  const oldEntry = { ...f.entry, contentRootDir: view, moduleData: { writableInput: {
    schemaVersion: 1, root: view, sourceRoot: f.gamePath
  } } };
  const [descriptor] = Backcompat.legacyGameMirrors(oldEntry, f.context);
  assert.equal(descriptor.sourceRoot, Preparation.defaultSaveDirectory(f.entry), "The original novel folder determines native saves");
  assert.equal(legacyReads, 1);
  require("../src/modules/vnds/main").onImport(f.entry, f.context);
  await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(legacyReads, 1, "Import and repeated ordinary preparation never read obsolete record policy");
  assert.equal(oldEntry.contentRootDir, view, "The module hook does not mutate saved records");
});

test("VNDS per-game released save recovery adopts visible current fields only through a successful entry patch", async t => {
  const f = scratch(t), other = { gameId: "other-novel", gamePath: f.gamePath };
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f.context);
  const [second] = Backcompat.legacyGameMirrors(other, f.context);
  assert.notEqual(descriptor.mirrorRoot, second.mirrorRoot, "Released private bytes belong to their recorded game IDs");
  assert.equal(descriptor.sourceRoot, second.sourceRoot, "Recovery follows the normal basename target without module-local collision policy");
  const originalFields = JSON.stringify(f.entry);
  fs.mkdirSync(descriptor.mirrorRoot, { recursive: true });
  fs.writeFileSync(path.join(descriptor.mirrorRoot, "save1.json"), '{"owner":"released-novel"}');
  assert.equal(JSON.stringify(f.entry), originalFields, "Planning recovery must not publish ordinary fields");
  const retire = require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror;
  const blocked = await retire(descriptor, f.context);
  assert.equal(blocked.complete, false);
  assert.equal(JSON.stringify(f.entry), originalFields, "A blocked result leaves visible settings unchanged");
  fs.mkdirSync(descriptor.sourceRoot, { recursive: true });
  const recovered = await retire(descriptor, f.context); assert.equal(recovered.complete, true);
  Object.assign(f.entry, descriptor.entryPatch);
  assert.equal(f.entry.saveDirOverride, null, "Successful recovery retains the normal upstream default");
  assert.equal(f.entry.defaultSaveDir, descriptor.sourceRoot);
  assert.equal(f.entry.saveLocations[0].directory, descriptor.sourceRoot);
  const prepared = await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(prepared.saveRoot, descriptor.sourceRoot);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.saveRoot, "save1.json"))).owner, "released-novel");
});

test("VNDS real one-time runner recovers released slots into a missing native folder beneath the existing engine parent", async t => {
  const f = scratch(t); f.entry.moduleId = "vnds";
  const anchor = path.join(os.homedir(), "Library", "Application Support");
  fs.mkdirSync(anchor, { recursive: true });
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f.context);
  assert.equal(descriptor.createSourceWithin, anchor);
  assert.equal(fs.existsSync(descriptor.sourceRoot), false);
  fs.mkdirSync(descriptor.mirrorRoot, { recursive: true });
  const slot = JSON.stringify({ interpreter: { file: "main.scr", n: 4, globals: { released: "owned-game" } } });
  fs.writeFileSync(path.join(descriptor.mirrorRoot, "save1.json"), slot);
  const { runDataMigrations } = require("../src/core/backcompat/data-migrations");
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [f.entry], userDataDir: f.context.userDataDir,
    registry: { getModule: () => Backcompat }, saveSettings: async () => {},
    saveEntry: async entry => { persisted = structuredClone(entry); } });
  assert.equal(result.complete, true); assert.deepEqual(result.pendingIds, []);
  assert.equal(fs.existsSync(descriptor.mirrorRoot), false);
  assert.equal(fs.readFileSync(path.join(descriptor.sourceRoot, "save1.json"), "utf8"), slot);
  assert.equal(persisted.gameId, f.entry.gameId);
  assert.equal(persisted.saveDirOverride, null, "The real runner clears an obsolete selection while retaining the upstream default");
  assert.equal(persisted.defaultSaveDir, descriptor.entryPatch.defaultSaveDir);
  assert.deepEqual(persisted.saveLocations, descriptor.entryPatch.saveLocations);
  assert.equal(f.entry.saveDirOverride, persisted.saveDirOverride, "The in-memory current entry follows successful persistence");
  const prepared = await Preparation.prepare(f.entry, f.context, { resolveEngine: f.engine });
  assert.equal(prepared.saveRoot, descriptor.sourceRoot);
  const loaded = require("../src/modules/vnds/save").decode(fs.readFileSync(path.join(prepared.saveRoot, "save1.json"), "utf8"));
  assert.equal(JSON.parse(loaded).interpreter.globals.released, "owned-game");
});

test("VNDS released-save facts use the original baseline and preserve an ambiguous original location as pending", t => {
  const f = scratch(t), old = path.join(f.context.userDataDir, "games", f.entry.gameId, "modules", "vnds", "saves");
  f.entry.defaultSaveDir = old;
  const [descriptor] = Backcompat.legacyGameMirrors(f.entry, f.context);
  assert.deepEqual(descriptor.releasedSaveRoute, { directory: old, entryPatch: { saveDirOverride: old }, proven: true, explicit: false });
  const generated = { ...f.entry, saveDirOverride: path.join(f.root, "generated-current-choice") };
  const [planned] = Backcompat.legacyGameMirrors(generated, { ...f.context, games: [f.entry] });
  assert.equal(planned.releasedSaveRoute.explicit, false, "Generated working-copy choices cannot hide the released baseline facts");
  const [pending] = Backcompat.legacyGameMirrors({ ...f.entry, gamePath: null }, f.context);
  assert.equal(pending.sourceRoot, null);
  assert.deepEqual(pending.releasedSaveRoute, descriptor.releasedSaveRoute);
  const [fresh] = Backcompat.legacyGameMirrors({ ...f.entry, gameId: "fresh", defaultSaveDir: null }, f.context);
  assert.equal(fresh.releasedSaveRoute.proven, false);
});

test("VNDS released-save facts protect only the consumed save override, not replaced environment or unrelated arguments", t => {
  const f = scratch(t), old = path.join(f.context.userDataDir, "games", f.entry.gameId, "modules", "vnds", "saves");
  fs.mkdirSync(old, { recursive: true });
  for (const [authored, explicit] of [[f.entry, false], [{ ...f.entry, saveDirOverride: path.join(f.root, "Chosen Saves") }, true], [{ ...f.entry, launchArguments: "--fullscreen" }, false]]) {
    const [descriptor] = Backcompat.legacyGameMirrors(authored, { ...f.context, gameArguments: ["--fullscreen"] });
    assert.equal(descriptor.releasedSaveRoute.directory, descriptor.mirrorRoot);
    assert.equal(descriptor.releasedSaveRoute.proven, true);
    assert.equal(descriptor.releasedSaveRoute.explicit, explicit);
    assert.deepEqual(descriptor.releasedSaveRoute.entryPatch, { saveDirOverride: old });
  }
  const previous = process.env.MACLAUNCHER_VNDS_SAVES;
  t.after(() => { if (previous === undefined) delete process.env.MACLAUNCHER_VNDS_SAVES; else process.env.MACLAUNCHER_VNDS_SAVES = previous; });
  process.env.MACLAUNCHER_VNDS_SAVES = path.join(f.root, "Environment Saves");
  assert.equal(Backcompat.legacyGameMirrors(f.entry, f.context)[0].releasedSaveRoute.explicit, false, "Current launch overwrites this variable with prepared.saveRoot");
});
