const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Inspect = require("../src/modules/minori/inspect");
const Module = require("../src/modules/minori/main");
const manager = Module.runtimeManagers[0];
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-minori-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function header(prefix = "minori-paz", size = 32, key = 0xaa) {
  const bytes = Buffer.alloc(36); bytes.write(prefix, 0, 32); bytes.writeUInt32LE(size, 32);
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= key; return bytes;
}
function fixture(root) {
  for (const name of ["scr.paz", "sys.paz", "bg.paz"]) fs.writeFileSync(path.join(root, name), Buffer.concat([header(), Buffer.alloc(64)]));
  const executable = path.join(root, "game.exe"); fs.writeFileSync(executable, Buffer.alloc(64)); return executable;
}
function tool(t, root, result) {
  const file = path.join(root, "probe.cjs");
  fs.writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`, { mode: 0o755 });
  return { probe: file, profile: { executables: { "maclauncher-minori-probe": "fixture-tool" } }, movieDecoder: path.join(root, "movie-fixture") };
}
const verification = () => ({ schema: 1, profile: "paz-bf-slot0-rc4-v1", xorKey: 170, bootScript: "a001.sc", scriptCount: 3,
  archives: [{ group: "scr", entries: 3 }, { group: "sys", entries: 2 }, { group: "bg", entries: 2 }] });

test("Minori import gates companion files before reading only bounded headers", t => {
  const root = directory(t), executable = fixture(root); let reads = 0, bytes = 0;
  const detection = { readdir: file => fs.readdirSync(file, { withFileTypes: true }), stat: file => fs.statSync(file),
    readBytes: (file, offset, length) => { reads++; bytes += length; const fd = fs.openSync(file, "r"), buffer = Buffer.alloc(length); try { fs.readSync(fd, buffer, 0, length, offset); return buffer; } finally { fs.closeSync(fd); } } };
  const found = Module.detectGame({ rootDir: root, inputPath: executable, detection });
  assert.equal(found.moduleId, "minori"); assert.equal(found.moduleData.originalRunnerPath, executable);
  assert.equal(found.moduleData.originalEngineVersion, null); assert.equal(found.moduleData.supported, null);
  assert.equal(found.moduleData.cryptoProfile, null); assert.equal(reads, 4); assert.equal(bytes, 172);
  fs.unlinkSync(path.join(root, "sys.paz")); reads = 0;
  assert.equal(Module.detectGame({ rootDir: root, inputPath: executable, detection }), null); assert.equal(reads, 0);
});

test("PAZ-looking suffixes, truncated indexes, random labels and symlink companions do not identify Minori", t => {
  assert.equal(Inspect.parseHeader(header(), 40), null);
  assert.equal(Inspect.parseHeader(header("minori-paz", Inspect.LIMITS.indexBytes + 1), 10 * 1024 * 1024), null);
  const invalid = header(); invalid[2] = 0; assert.equal(Inspect.parseHeader(invalid, 100), null);
  const root = directory(t); fixture(root); fs.unlinkSync(path.join(root, "sys.paz"));
  fs.symlinkSync(path.join(root, "scr.paz"), path.join(root, "sys.paz")); assert.equal(Inspect.inspectGame(root), null);
});

test("Minori header profiles infer the XOR byte without inventing an engine version", () => {
  const found = Inspect.parseHeader(header("minori-paz", 48, 0x72), 100);
  assert.deepEqual(found, { xorKey: 0x72, indexBytes: 48, prefix: "minori-paz" });
  assert.equal(found.version, undefined);
});

test("PAZ edition labels may have binary header tails without weakening companion agreement", t => {
  const root = directory(t); fixture(root);
  for (const [index, name] of ["scr.paz", "sys.paz", "bg.paz"].entries()) {
    const bytes = header("sample-data", 32, 0);
    for (let offset = 12; offset < 32; offset++) bytes[offset] = (offset * 19 + index * 31) & 255;
    fs.writeFileSync(path.join(root, name), Buffer.concat([bytes, Buffer.alloc(64)]));
  }
  const found = Inspect.inspectGame(root); assert.ok(found);
  assert.equal(found.headerPrefix, "sample-data"); assert.equal(found.xorKey, 0);
  fs.writeFileSync(path.join(root, "sys.paz"), Buffer.concat([header("different-edition", 32, 0), Buffer.alloc(64)]));
  assert.equal(Inspect.inspectGame(root), null);
});

test("Minori launch preserves original files and isolates concurrent game save/cache settings", async t => {
  const root = directory(t), game = path.join(root, "original"), userData = path.join(root, "library"); fs.mkdirSync(game); fixture(game);
  const before = fs.readdirSync(game).map(name => [name, fs.readFileSync(path.join(game, name)).toString("hex")]);
  const distribution = tool(t, root, verification()), context = { userDataDir: userData, onEntryChange() {} };
  const a = { gameId: "a", gamePath: game, name: "A" }, b = { gameId: "b", gamePath: game, name: "B", saveDirOverride: path.join(root, "saves-b") };
  const [first, second] = await Promise.all([Module.__test.prepareLaunch(a, context, distribution), Module.__test.prepareLaunch(b, context, distribution)]);
  assert.deepEqual(first.args, ["--game-root", game]); assert.equal(second.saves, b.saveDirOverride);
  assert.notEqual(first.env.MACLAUNCHER_MINORI_SAVE_DIR, second.env.MACLAUNCHER_MINORI_SAVE_DIR);
  assert.notEqual(first.env.MACLAUNCHER_MINORI_CACHE_DIR, second.env.MACLAUNCHER_MINORI_CACHE_DIR);
  assert.equal(first.env.MACLAUNCHER_MINORI_TITLE, "A"); assert.equal(second.env.MACLAUNCHER_MINORI_TITLE, "B");
  assert.equal(first.env.MACLAUNCHER_MINORI_ORIGINAL_RUNNER, path.join(game, "game.exe"));
  assert.equal(process.env.MACLAUNCHER_MINORI_TITLE, undefined);
  assert.deepEqual(fs.readdirSync(game).map(name => [name, fs.readFileSync(path.join(game, name)).toString("hex")]), before);
  assert.throws(() => Module.__test.gameDirectory({ gameId: "../escape" }, context), /persisted/);
});

test("native verification rejects other crypto profiles and cache invalidates changed original archive facts", async t => {
  const root = directory(t), game = path.join(root, "original"); fs.mkdirSync(game); fixture(game);
  const entry = { gamePath: game }, context = {};
  const bad = tool(t, root, { ...verification(), profile: "unsupported-new-keys" });
  await assert.rejects(Module.__test.verifyData(entry, context, bad), /invalid profile/);
  const good = tool(t, root, verification()); await Module.__test.verifyData(entry, context, good);
  fs.writeFileSync(good.probe, `#!${process.execPath}\nprocess.exit(9);\n`, { mode: 0o755 });
  await Module.__test.verifyData(entry, context, good); // Reuses already verified data for unchanged source facts.
  fs.appendFileSync(path.join(game, "scr.paz"), Buffer.from([0]));
  await assert.rejects(Module.__test.verifyData(entry, context, good));
});

test("verified Minori profiles persist across workers, while explicit verification bypasses cached facts", async t => {
  const root = directory(t), game = path.join(root, "original"); fs.mkdirSync(game); fixture(game);
  const entry = { gameId: "cached", gamePath: game }, context = { userDataDir: path.join(root, "library") };
  const distribution = tool(t, root, verification());
  await Module.__test.verifyData(entry, context, distribution);
  const cached = path.join(Module.__test.gameDirectory(entry, context), "verification.json");
  assert.ok(fs.existsSync(cached)); Module.__test.verifiedData.clear();
  fs.writeFileSync(distribution.probe, `#!${process.execPath}\nprocess.exit(9);\n`, { mode: 0o755 });
  await Module.__test.verifyData(entry, context, distribution);
  await assert.rejects(Module.__test.verifyData(entry, context, distribution, { refresh: true }));
  const timestamp = fs.statSync(path.join(game, "scr.paz")).mtime;
  fs.appendFileSync(path.join(game, "scr.paz"), Buffer.from([0])); fs.utimesSync(path.join(game, "scr.paz"), timestamp, timestamp);
  Module.__test.verifiedData.clear(); await assert.rejects(Module.__test.verifyData(entry, context, distribution));
});

test("Minori catalog uses the shared explicit-refresh manager with an immutable native/source identity", t => {
  const root = directory(t), settings = manager.normalizeSettings({});
  assert.equal(settings.defaultVersion, null); assert.equal(manager.id, "reminori");
  assert.deepEqual(manager.core.listCatalog({ userDataDir: root }), []);
  assert.equal(manager.resolveSelection({ runtimeData: { reminori: { version: "fixture-choice" } } }, {}, root).version, "fixture-choice");
  assert.equal(manager.distributionRequired, false);
  const state = manager.getState({ settings, userDataDir: root });
  assert.equal(state.catalog.status, "idle"); assert.equal(Object.hasOwn(state.catalog, "recommendedVersion"), false);
  assert.equal(manager.manifest, undefined); // Manager metadata is independent of renderer code.
});

test("Minori script tools are reachable in the inspector and track owned output availability", t => {
  const root = directory(t), entry = { gameId: "scripts", moduleData: {} }, revealed = [];
  let changes = 0;
  const context = { userDataDir: root, revealInFinder: file => revealed.push(file), onEntryChange: () => changes++ };
  const ui = Module.manifest.ui, group = ui.actionGroups.find(value => value.id === "scripts");
  assert.ok(group && !group.collapsed);
  assert.deepEqual(group.actions, ["extractScripts", "revealScripts", "removeScripts"]);
  const extract = ui.actions.find(action => action.id === "extractScripts"); assert.equal(extract.kind, "primary");
  for (const id of ["revealScripts", "removeScripts"]) {
    assert.deepEqual(ui.actions.find(action => action.id === id).disabledWhen, [{ key: "moduleData.scriptsDirectory", falsy: true }]);
    assert.throws(() => Module.actions[id](entry, {}, context), /Extract scripts first/);
  }
  Module.onImport(entry, context); assert.equal(entry.moduleData.scriptsDirectory, null);
  const output = path.join(Module.__test.gameDirectory(entry, context), "scripts");
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "start.txt"), "private output");
  Module.onImport(entry, context); assert.equal(entry.moduleData.scriptsDirectory, output);
  assert.deepEqual(Module.actions.revealScripts(entry, {}, context), { directory: output }); assert.deepEqual(revealed, [output]);
  Module.actions.removeScripts(entry, {}, context);
  assert.equal(entry.moduleData.scriptsDirectory, null); assert.equal(fs.existsSync(output), false); assert.equal(changes, 1);
  fs.symlinkSync(root, output); Module.onImport(entry, context);
  assert.equal(entry.moduleData.scriptsDirectory, null); assert.throws(() => Module.actions.removeScripts(entry, {}, context), /Extract scripts first/);
});
