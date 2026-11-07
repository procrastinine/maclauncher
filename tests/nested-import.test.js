const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const D = require("../src/modules/detection");
const { findNestedGames } = require("../src/core/nested-import");
const { createGameMetadataService } = require("../src/core/game-metadata");
const { errorRecord, restoreError } = require("../src/core/backend-worker-client");
const { userImportError } = require("../src/core/import-error");

// A folder holding game.marker is a game. A folder with several .run files has
// several possible games and names each file; a selected .run file is one.
const info = { id: "fixture", label: "Fixture Game" };
const fixture = { id: info.id, manifest: info, detectGame(context) {
  if (context.stat.isFile()) return context.inputPath.endsWith(".run")
    ? { moduleId: info.id, gamePath: path.dirname(context.inputPath), name: path.basename(context.inputPath, ".run"), moduleData: { program: context.inputPath } } : null;
  const names = fs.readdirSync(context.rootDir);
  if (names.includes("game.marker")) return { moduleId: info.id, gamePath: context.rootDir, name: path.basename(context.rootDir), moduleData: {} };
  const programs = names.filter(name => name.endsWith(".run"));
  if (programs.length > 1) throw Object.assign(new Error("Several programs."), { code: "DETECTION_CONFLICT", choices: programs.map(name => path.join(context.rootDir, name)) });
  return null;
} };
const detect = (input, options) => D.explainDetectionAsync(input, [fixture], options);

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text = "fixture") => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
  };
  return { root, write };
}

test("a conflict names its choices through modules, child apps and reports, and an ambiguity at one path names none", async t => {
  const { root, write } = tree(t);
  write("Programs/One.run"); write("Programs/Two.run");
  write("Apps/A.app/game.marker"); write("Apps/B.app/game.marker"); write("Apps/notes.txt");
  write("Same/game.marker");
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    const programs = await explain(path.join(root, "Programs"), [fixture]);
    assert.equal(programs.error.code, "DETECTION_CONFLICT");
    assert.deepEqual(programs.error.choices, ["One.run", "Two.run"].map(name => path.join(root, "Programs", name)));
    const apps = await explain(path.join(root, "Apps"), [fixture]);
    assert.deepEqual(apps.error.choices, ["A.app", "B.app"].map(name => path.join(root, "Apps", name)));
    const twin = { ...fixture, id: "twin", manifest: { id: "twin", label: "Twin" } };
    const same = await explain(path.join(root, "Same"), [fixture, twin]);
    assert.equal(same.error.code, "DETECTION_CONFLICT"); assert.equal(same.error.choices, undefined);
    assert.throws(() => D.resultOrThrow(programs), error => error.code === "DETECTION_CONFLICT" && error.choices.length === 2);
  }
});

test("a folder with no game at its top level offers the games its subfolders hold, breadth first to a fixed depth", async t => {
  const { root, write } = tree(t);
  write("readme.txt");
  write("Alpha/game.marker"); write("Alpha/Inner/game.marker");
  write("Beta/game.marker");
  write(".hidden/game.marker");
  write("Bundle.app/Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  write("Bundle.app/Contents/game.marker");
  // Detection itself looks one level into a folder whose only subfolder is a
  // wrapper, so the fourth level here sits beside a second subfolder.
  write("Deep/x.txt"); write("Deep/a/x.txt"); write("Deep/a/b/d/x.txt"); write("Deep/a/b/c/game.marker");
  // A release folder whose only child leads to a build with two programs.
  write("Release/notes.txt"); write("Release/payload/build/Helper.run"); write("Release/payload/build/Release.run");
  const before = fs.readdirSync(root).sort();

  const error = D.resultOrThrow.bind(null, await detect(root));
  assert.throws(error, { code: "DETECTION_UNSUPPORTED" });
  let failure; try { error(); } catch (value) { failure = value; }
  const games = await findNestedGames(root, failure, { detect });
  assert.deepEqual(games.map(game => [game.relativePath, game.name, game.label]), [
    ["Alpha", "Alpha", "Fixture Game"], ["Beta", "Beta", "Fixture Game"],
    // The choice named in the folders that lead to it comes first.
    [path.join("Release", "payload", "build", "Release.run"), "Release", "Fixture Game"],
    [path.join("Release", "payload", "build", "Helper.run"), "Helper", "Fixture Game"]]);
  assert.equal(games[2].gamePath, games[3].gamePath, "choices for one game share its game path");
  assert.equal(games[0].inputPath, path.join(root, "Alpha"));
  assert.deepEqual(fs.readdirSync(root).sort(), before, "the search only reads");

  assert.deepEqual((await findNestedGames(root, failure, { detect, limits: { depth: 3, folders: 2, choices: 8, games: 16 } })).map(game => game.relativePath), ["Alpha", "Beta"]);
  assert.deepEqual(await findNestedGames(path.join(root, "readme.txt"), failure, { detect }), [], "a file has no subfolders");
  assert.deepEqual(await findNestedGames(root, { code: "DETECTION_LIMIT" }, { detect }), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(findNestedGames(root, failure, { detect, signal: controller.signal }), { name: "AbortError" });

  // A selected folder with several possible games offers its own choices.
  const build = path.join(root, "Release", "payload", "build");
  let conflict; try { D.resultOrThrow(await detect(build)); } catch (value) { conflict = value; }
  assert.deepEqual((await findNestedGames(build, conflict, { detect })).map(game => game.relativePath), ["Helper.run", "Release.run"]);
});

test("a failed folder import carries the nested games through the backend and the import message", async t => {
  const { root, write } = tree(t);
  write("readme.txt"); write("Alpha/game.marker"); write("Beta/game.marker");
  const userDataDir = path.join(root, ".profile"); fs.mkdirSync(path.join(userDataDir, "games"), { recursive: true });
  const registry = { listModuleIds: () => [info.id], listModules: () => [info], getModuleInfo: () => info, getModule: () => fixture,
    getModuleDir: () => path.join(root, ".module"), explainDetectionAsync: detect,
    detectGameAsync: async (input, options) => D.resultOrThrow(await detect(input, options)) };
  const service = createGameMetadataService({ userDataDir, registry });
  let failure;
  await assert.rejects(service.importEntry(root, {}), error => { failure = error; return error.code === "DETECTION_UNSUPPORTED"; });
  assert.deepEqual(failure.nestedGames.map(game => game.relativePath), ["Alpha", "Beta"]);
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, "games")), [], "the failed import adds nothing");

  const restored = restoreError(errorRecord(failure));
  assert.deepEqual(restored.nestedGames, failure.nestedGames);
  const message = userImportError(restored, root);
  assert.match(message.message, new RegExp(`“${path.basename(root)}” has no game at its top level\\. MacLauncher found 2 possible games in its subfolders\\.`));
  assert.deepEqual(message.nestedGames, failure.nestedGames);
  assert.match(userImportError({ code: "DETECTION_CONFLICT", nestedGames: [failure.nestedGames[0]] }, root).message, /more than one possible game\. MacLauncher found one game in it\./);
});
