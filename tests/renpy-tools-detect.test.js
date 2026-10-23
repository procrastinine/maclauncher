const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { detectGame, resolveRenpyVersion, resolveRenpyVersionEvidence } = require("../src/modules/renpy/detect");
const { parseSaveDirectoryLiteral } = require("../src/modules/renpy/save-location");
const Renpy = require("../src/modules/renpy/main");
const { resolveExtractionRoot, writeExtractionMeta } = require("../src/modules/renpy/extract");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "renpy-tools-detect-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), game = path.join(root, "NewGame"), gameDir = path.join(game, "game");
  fs.mkdirSync(path.join(game, "renpy"), { recursive: true });
  fs.mkdirSync(gameDir);
  fs.writeFileSync(path.join(game, "renpy", "vc_version.py"), 'version = "8.3.4"\n');
  fs.writeFileSync(path.join(game, "NewGame.sh"), "");
  const unrelated = path.join(home, "Library", "RenPy", "NewGame-OldUnrelated");
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, "1-1-LT1.save"), "other game bytes");
  t.mock.method(os, "homedir", () => home);
  return { root, home, game, gameDir, unrelated, options: path.join(gameDir, "options.rpy"), detect: () => detectGame({ rootDir: game, inputPath: game }) };
}

test("a configured Ren'Py save directory dominates unrelated existing title matches before first launch", t => {
  const f = fixture(t);
  fs.writeFileSync(f.options, '# define config.save_directory = "IgnoredComment"\ndefine config.save_directory = r"Publisher/BrandNewSave" # exact location\n');
  const detected = f.detect();
  const expected = path.join(f.home, "Library", "RenPy", "Publisher", "BrandNewSave");
  assert.equal(fs.existsSync(expected), false);
  assert.equal(detected.defaultSaveDir, expected);
  assert.equal(detected.moduleData.saveDirectoryConfidence, "exact");
  assert.equal(detected.moduleData.saveDirectorySource, f.options);
  const merged = Renpy.mergeEntry({ defaultSaveDir: f.unrelated }, { ...detected, saveDirOverride: "/explicit-user-folder" });
  assert.equal(merged.defaultSaveDir, expected);
  assert.equal(merged.saveDirOverride, "/explicit-user-folder");
  assert.equal(fs.readFileSync(path.join(f.unrelated, "1-1-LT1.save"), "utf8"), "other game bytes");
});

test("unsafe or dynamic configured save paths never fall back to another game's saves", t => {
  const f = fixture(t);
  for (const expression of ['"../OtherGame"', '"/absolute"', 'r"C:\\OtherGame"', '"A//B"', '"."', '"A/../B"', '"\\x2e\\x2e/Other"', '"A\\nB"', '"Prefix" + variable', 'f"{variable}"']) {
    fs.writeFileSync(f.options, `define config.save_directory = ${expression}\n`);
    const detected = f.detect();
    assert.equal(detected.defaultSaveDir, null, expression);
    assert.equal(detected.moduleData.saveDirectoryConfidence, "unknown", expression);
    assert.match(detected.moduleData.saveDirectoryWarning, /explicit save-folder override/, expression);
    assert.equal(Renpy.mergeEntry({ defaultSaveDir: f.unrelated }, detected).defaultSaveDir, null, expression);
  }
});

test("literal Python quoting is parsed without executing expressions; absent settings use the engine-local root", t => {
  const f = fixture(t);
  assert.equal(parseSaveDirectoryLiteral('u"Group/\\u00e9Title"'), "Group/éTitle");
  assert.equal(parseSaveDirectoryLiteral('"A\\\"B"'), 'A"B');
  assert.equal(parseSaveDirectoryLiteral('"A" + "B"'), null);
  assert.equal(parseSaveDirectoryLiteral('"A"; dangerous()'), null);
  assert.equal(parseSaveDirectoryLiteral('"A"\\ndefine config.window_icon = "icon.png"'), null);
  assert.equal(parseSaveDirectoryLiteral('"""A"""'), null);
  fs.writeFileSync(f.options, 'define config.save_directory = u"Group/\\u00e9Title"\n');
  assert.equal(f.detect().defaultSaveDir, path.join(f.home, "Library", "RenPy", "Group", "éTitle"));
  fs.writeFileSync(f.options, '# config.save_directory = "CommentOnly"\n');
  const fallback = f.detect();
  assert.equal(fallback.defaultSaveDir, path.join(f.gameDir, "saves"));
  assert.equal(fallback.moduleData.saveDirectoryConfidence, "inferred");
});

test("extracted options apply the same exact-location and traversal rules", t => {
  const f = fixture(t), userDataDir = path.join(f.root, "data");
  const entry = { ...f.detect(), gameId: "test-game", defaultSaveDir: f.unrelated };
  const extractedRoot = resolveExtractionRoot({ entry, userDataDir });
  fs.mkdirSync(extractedRoot, { recursive: true });
  writeExtractionMeta(extractedRoot, { sourcePath: f.gameDir, extractedAt: 123, state: "complete" });
  fs.writeFileSync(path.join(extractedRoot, "options.rpy"), 'define config.save_directory = r"Publisher/Extracted"\n');
  Renpy.actions.refreshExtractionStatus(entry, {}, { userDataDir });
  assert.equal(entry.defaultSaveDir, path.join(f.home, "Library", "RenPy", "Publisher", "Extracted"));
  assert.equal(entry.moduleData.saveDirectoryConfidence, "exact");
  fs.writeFileSync(path.join(extractedRoot, "options.rpy"), 'define config.save_directory = "../../OtherGame"\n');
  Renpy.actions.refreshExtractionStatus(entry, {}, { userDataDir });
  assert.equal(entry.defaultSaveDir, null);
  assert.equal(entry.moduleData.saveDirectoryConfidence, "unknown");
});

test("runtime version reports identify the chosen literal source and avoid unresolved Python branches", t => {
  const f = fixture(t);
  let detected = f.detect();
  assert.equal(detected.moduleData.versionSource, "renpy/vc_version.py version");
  assert.equal(detected.moduleData.versionConfidence, "exact");
  assert.equal(resolveRenpyVersion(f.game), "8.3.4");
  fs.writeFileSync(path.join(f.game, "renpy", "vc_version.py"), "# no literal version\n");
  fs.writeFileSync(path.join(f.game, "renpy", "__init__.py"), "# version_tuple = (6, 0, 0)\nversion_tuple = VersionTuple(8, 2, 1, 123)\n");
  assert.deepEqual(resolveRenpyVersionEvidence(f.game), { version: "8.2.1", versionSource: "renpy/__init__.py version_tuple", versionConfidence: "exact" });
  fs.writeFileSync(path.join(f.game, "renpy", "__init__.py"), "if PY2:\n    compatibility_flag = True\nversion_tuple = (8, 2, 1)\n");
  assert.equal(resolveRenpyVersion(f.game), "8.2.1");
  fs.writeFileSync(path.join(f.game, "renpy", "__init__.py"), "if PY2:\n    version_tuple = (7, 7, 3)\nelse:\n    version_tuple = (8, 2, 1)\n");
  assert.equal(f.detect().moduleData.version, null);
  fs.mkdirSync(path.join(f.game, "lib", "py3-mac-universal"), { recursive: true });
  detected = f.detect();
  assert.equal(detected.moduleData.version, "8.2.1");
  assert.equal(detected.moduleData.versionConfidence, "exact");
  fs.writeFileSync(path.join(f.game, "renpy", "vc_version.py"), 'version = "7.7.3"\n');
  assert.equal(f.detect().moduleData.versionSource, "renpy/__init__.py version_tuple");
});

test("game-only script-version metadata distinguishes complete reports from a major inference", t => {
  const f = fixture(t), standalone = path.join(f.root, "Standalone", "game");
  fs.mkdirSync(standalone, { recursive: true });
  fs.writeFileSync(path.join(standalone, "script.rpy"), "label start:\n    return\n");
  const detect = () => detectGame({ rootDir: standalone, inputPath: standalone });
  fs.writeFileSync(path.join(standalone, "script_version.txt"), "7, 7, 3");
  assert.equal(detect().moduleData.versionSource, "script_version.txt");
  assert.equal(detect().moduleData.versionConfidence, "reported");
  fs.writeFileSync(path.join(standalone, "script_version.txt"), "7");
  assert.equal(detect().moduleData.version, "7");
  assert.equal(detect().moduleData.versionConfidence, "inferred");
});
