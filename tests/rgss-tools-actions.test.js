const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Tools = require("../src/modules/rgss/tools");
const Rgss = require("../src/modules/rgss/main");
const { EXPORT_FORMAT } = require("../src/modules/rgss/script-tools");

const SCRIPTS = Buffer.from("BAhbCFsIaRFJIglzYW1lBjoGRVQiGXicKygtKVawSsssKi7hAgAeAARZWwhpEUkiCXNhbWUGOwBUIhp4nCsoLSlWsCpOTc7PS+ECACLtBK1bCGn6SSIABjsAVCIPeJz7zwAAAgABAA==", "base64");

function setup(t, variant = "RGSS3") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rgss-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "game");
  fs.mkdirSync(game);
  const entry = { gameId: "fixture_game", gamePath: game, contentRootDir: game, moduleData: { rgssVersion: variant }, runtimeData: { mkxpz: { version: "explicit-fixture-version" } } };
  const context = { userDataDir: path.join(root, "userdata"), settings: { runtimes: { mkxpz: { defaultVersion: "different-default" } } } };
  return { root, game, entry, context };
}

test("save discovery qualifies XP/VX/Ace stock names, save subdirectories and custom locations", t => {
  for (const [variant, ext] of [["RGSS1", "rxdata"], ["RGSS2", "rvdata"], ["RGSS3", "rvdata2"]]) {
    const { root, game, entry } = setup(t, variant);
    fs.writeFileSync(path.join(game, `Save01.${ext}`), Buffer.from([4, 8, 48]));
    fs.writeFileSync(path.join(game, `Actors.${ext}`), Buffer.from([4, 8, 48]));
    fs.mkdirSync(path.join(game, "sAvEs"));
    fs.writeFileSync(path.join(game, "sAvEs", `slot2.${ext}`), Buffer.from([4, 8, 48]));
    fs.writeFileSync(path.join(game, "sAvEs", "plugin.sav"), "custom encoded save");
    fs.mkdirSync(path.join(game, "Data"));
    fs.writeFileSync(path.join(game, "Data", `SaveDatabase.${ext}`), Buffer.from([4, 8, 48]));
    const custom = path.join(root, "custom");
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(custom, `slot_custom.${ext}`), Buffer.from([4, 8, 48]));
    entry.saveDirOverride = custom;
    const result = Tools.discoverSaveFiles(entry);
    assert.equal(result.files.length, 4);
    assert.equal(result.files.filter(file => file.marshal48).length, 3);
    assert.ok(result.files.filter(file => file.marshal48).every(file => file.engineVariant === variant));
    assert.ok(!result.files.some(file => file.fileName.startsWith("Actors") || file.fileName.startsWith("SaveDatabase")));
    const limited = Tools.discoverSaveFiles(entry, { maxFiles: 1 });
    assert.equal(limited.files.length, 1);
    assert.equal(limited.truncated, true);
    fs.symlinkSync(path.join(game, `Save01.${ext}`), path.join(game, `SaveLink.${ext}`));
    assert.equal(Tools.discoverSaveFiles(entry).files.length, 4);
  }
});

test("Scripts lookup handles case-insensitive paths, custom INI Scripts and encrypted/extracted roots", t => {
  const { root, game, entry } = setup(t);
  fs.mkdirSync(path.join(game, "data"));
  fs.writeFileSync(path.join(game, "data", "scripts.RVDATA2"), SCRIPTS);
  assert.equal(Tools.resolveScriptsPath(entry), path.join(game, "data", "scripts.RVDATA2"));
  fs.mkdirSync(path.join(game, "Custom"));
  fs.writeFileSync(path.join(game, "Custom", "Bundle.rvdata2"), SCRIPTS);
  fs.writeFileSync(path.join(game, "GAME.ini"), "[Game]\nScripts=custom\\bundle.rvdata2\n");
  assert.equal(Tools.resolveScriptsPath(entry), path.join(game, "Custom", "Bundle.rvdata2"));
  fs.writeFileSync(path.join(game, "GAME.ini"), "[Game]\nScripts=../outside.rvdata2\n");
  assert.equal(Tools.resolveScriptsPath(entry), path.join(game, "data", "scripts.RVDATA2"));
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(path.join(extracted, "Data"), { recursive: true });
  fs.writeFileSync(path.join(extracted, "Data", "Scripts.rvdata2"), SCRIPTS);
  entry.moduleData.decryptedRoot = extracted;
  assert.equal(Tools.resolveScriptsPath(entry), path.join(extracted, "Data", "Scripts.rvdata2"));
});

test("module script actions are usable headlessly and store immutable exports under per-game data", async t => {
  const { game, entry, context } = setup(t);
  fs.mkdirSync(path.join(game, "Data"));
  fs.writeFileSync(path.join(game, "Data", "Scripts.rvdata2"), SCRIPTS);
  const status = Rgss.actions.refreshRgssTools(entry, {}, context);
  assert.ok(status.scriptArchivePath);
  assert.equal(entry.moduleData.scriptsAvailable, true);
  assert.equal(entry.moduleData.scriptsExportReady, false);
  const result = await Rgss.actions.exportScripts(entry, {}, context);
  assert.ok(result.outputDir.startsWith(path.join(context.userDataDir, "games", entry.gameId, "modules", "rgss", "tools")));
  assert.equal(entry.moduleData.scriptsExportReady, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outputDir, "manifest.json")));
  assert.equal(manifest.format, EXPORT_FORMAT);
  assert.equal(manifest.runtime.configuredVersion, "explicit-fixture-version");
  assert.equal(manifest.runtime.runtimeLoadValidated, false);
  const repacked = Rgss.actions.repackScripts(entry, {}, context);
  assert.equal(repacked.changedCount, 0);
  assert.deepEqual(fs.readFileSync(repacked.outputPath), SCRIPTS);
  const next = Rgss.actions.exportScripts(entry, {}, context);
  assert.notEqual(next.outputDir, result.outputDir);
  assert.equal(fs.existsSync(path.join(result.outputDir, "manifest.json")), true);
  let revealed;
  Rgss.actions.revealScripts(entry, {}, { ...context, ui: { shell: { showItemInFolder: value => { revealed = value; } } } });
  assert.equal(revealed, next.outputDir);
  assert.throws(() => Tools.toolsRoot({ ...entry, gameId: "../outside" }, context), /valid per-game/);
  assert.equal(Rgss.manifest.supports.saveEditing, false);
  assert.equal(Rgss.manifest.supports.saveLocation, false);
});

test("read-only inspection accepts sequential save streams and writes bounded graph reports without Electron", async t => {
  const { game, entry, context } = setup(t, "RGSS1");
  const filePath = path.join(game, "Save1.rxdata");
  const bytes = Buffer.from("BAhbBkkiDHByZXZpZXcGOgZFVAQIewY6CWdvbGRpDA==", "base64");
  fs.writeFileSync(filePath, bytes);
  const result = await Rgss.actions.inspectRgssFile(entry, { filePath }, context);
  assert.equal(result.streamCount, 2);
  const graph = JSON.parse(fs.readFileSync(result.outputPath));
  assert.equal(graph.readOnly, true);
  assert.equal(graph.engineVariant, "RGSS1");
  assert.equal(graph.runtime.configuredVersion, "explicit-fixture-version");
  assert.equal(graph.streams.length, 2);
  assert.equal(graph.parserFormat, "ruby-marshal-4.8-static-v1");
  assert.deepEqual(fs.readFileSync(filePath), bytes);
  const discovered = Rgss.actions.discoverSaves(entry, {}, context);
  assert.equal(discovered.saveFileCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(discovered.outputPath)).files[0].marshal48, true);
  const canceled = await Rgss.actions.inspectRgssFile(entry, {}, { ...context, ui: { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } } });
  assert.deepEqual(canceled, { canceled: true });
});

test("RGSS retains one report per kind and migrates timestamped reports without touching exports or saves", t => {
  const { game, entry, context } = setup(t);
  const root = path.join(Tools.toolsRoot(entry, context), "reports");
  fs.mkdirSync(root, { recursive: true });
  const stamp = "2026-01-01T01-02-03-004Z-aabbccdd";
  fs.writeFileSync(path.join(root, stamp + "-saves.json"), "old saves");
  fs.writeFileSync(path.join(root, stamp + ".json"), "old inspection");
  fs.writeFileSync(path.join(root, "notes.json"), "keep");
  const first = Tools.writeSaveDiscoveryReport(entry, context);
  assert.equal(fs.existsSync(path.join(root, stamp + "-saves.json")), false);
  assert.equal(fs.existsSync(path.join(root, stamp + ".json")), true);
  const savePath = path.join(game, "Save01.rvdata2");
  fs.writeFileSync(savePath, Buffer.from([4, 8, 48]));
  const next = Tools.writeSaveDiscoveryReport(entry, context);
  assert.equal(first.outputPath, next.outputPath);
  assert.equal(JSON.parse(fs.readFileSync(next.outputPath)).files.length, 1);
  Tools.writeInspectionReport(entry, savePath, context);
  assert.deepEqual(fs.readdirSync(root).sort(), ["inspection.json", "notes.json", "saves.json"]);
  assert.deepEqual(fs.readFileSync(savePath), Buffer.from([4, 8, 48]));
});
