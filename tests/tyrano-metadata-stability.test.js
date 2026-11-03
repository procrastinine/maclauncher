const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Tyrano = require("../src/modules/tyrano/main");
const Extraction = require("../src/modules/tyrano/extract");
const GameStore = require("../src/core/game-store");
const { createGameMetadataService } = require("../src/core/game-metadata");
const zip = require("./helpers/metadata-archive");

test("Tyrano metadata keeps the validated extraction root across warm reads and invalidates real source changes", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tyrano-metadata-stability-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gamePath = path.join(root, "original"), userDataDir = path.join(root, "profile"), gameId = "packaged-tyrano";
  fs.mkdirSync(gamePath);
  const archive = path.join(gamePath, "Game.exe"), files = [
    ["package.json", JSON.stringify({ name: "author-game", main: "index.html", window: { title: "Authored title" } })],
    ["index.html", "<html><title>Authored title</title></html>"],
    ["tyrano/plugins/kag/kag.js", 'var TYRANO_ENGINE_VERSION = "5.03";']
  ];
  zip(archive, files);
  const extractedRoot = path.join(userDataDir, "games", gameId, "modules", "tyrano", "extracted");
  for (const [relative, bytes] of files) {
    const file = path.join(extractedRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  Extraction.writeExtractionMeta(extractedRoot, { sourcePath: archive, sourceType: "zip-exe" });
  let detections = 0;
  const registry = {
    listModuleIds: () => ["tyrano"], listModules: () => [Tyrano.manifest], getModuleInfo: () => Tyrano.manifest,
    getModule: () => Tyrano, getModuleDir: () => path.dirname(require.resolve("../src/modules/tyrano/main")),
    async detectGameAsync(inputPath) {
      detections++;
      const detected = Tyrano.detectGame({ inputPath, rootDir: gamePath, stat: fs.statSync(inputPath) }, { findIndexHtml: Extraction.findIndexHtml });
      assert.ok(detected, "the real package detector must recognize the source carrier");
      assert.equal(detected.contentRootDir, gamePath, "carrier detection remains unchanged");
      return { ...detected, moduleId: "tyrano" };
    }
  };
  const service = createGameMetadataService({ userDataDir, registry,
    inputPreparation: async inputPath => ({ inputPath }) });
  const settings = { modules: { tyrano: {} }, runtimes: {} };
  let entry = { gameId, moduleId: "tyrano", runtimeId: "electron", gameType: "web", gamePath, importPath: archive,
    contentRootDir: extractedRoot, indexDir: extractedRoot, indexHtml: path.join(extractedRoot, "index.html"), name: "Custom title",
    moduleData: { packagedType: "zip-exe", packagedPath: archive, extractedRoot, extractedReady: true, version: "5.03", webMetadataName: "Authored title" },
    runtimeData: {}, notes: "keep notes" };
  GameStore.writeGameRecord(userDataDir, entry);
  for (let attempt = 0; attempt < 3; attempt++) {
    entry = await service.refreshEntry(entry, settings);
    assert.equal(entry.contentRootDir, extractedRoot);
    assert.equal(entry.indexHtml, path.join(extractedRoot, "index.html"));
    assert.equal(entry.moduleData.extractedReady, true);
    assert.equal(entry.moduleData.version, "5.03");
    assert.equal(entry.name, "Custom title"); assert.equal(entry.notes, "keep notes");
    const prepared = Tyrano.actions.refreshExtractionStatus(entry, {}, { userDataDir });
    assert.equal(prepared.extractedReady, true);
  }
  assert.equal(detections, 1, "unchanged metadata and ordinary preparation reuse the cache rather than re-read the package");
  const persisted = GameStore.readGameRecord(userDataDir, gameId);
  assert.equal(persisted.contentRootDir, extractedRoot);
  fs.writeFileSync(path.join(extractedRoot, "tyrano/plugins/kag/kag.js"), 'var TYRANO_ENGINE_VERSION = "5.04.1";');
  entry = await service.refreshEntry(entry, settings);
  assert.equal(detections, 2);
  assert.equal(entry.moduleData.version, "5.04.1", "an observed authored version change is not hidden");
  const replacement = path.join(gamePath, "Replacement.exe"); zip(replacement, files);
  entry = await service.refreshEntry({ ...entry, importPath: replacement, moduleData: { ...entry.moduleData, packagedPath: replacement } }, settings);
  assert.equal(detections, 3);
  assert.equal(entry.contentRootDir, gamePath, "an extraction bound to a different carrier cannot replace current source facts");
  assert.equal(entry.indexHtml, null);
  assert.equal(entry.moduleData.extractedReady, false);
  assert.equal(entry.name, "Custom title"); assert.equal(entry.notes, "keep notes");
});
