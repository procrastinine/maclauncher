const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const D = require("../src/modules/detection");
const { applyGameName } = require("../src/core/game-name");
const { createLauncher } = require("../src/core/launcher");

test("single-child imports share direct file detection and retain recognized folders and bundles", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "single-child-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = relative => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); return file;
  };
  const manifest = { id: "fixture", label: "Fixture", gameType: "native", settingsDefaults: { defaultRuntime: "runner" },
    runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } },
    detection: { inputKinds: ["file"], extensions: [{ extension: ".apk", exclusive: true }] } };
  const mod = { id: manifest.id, manifest, detectGame: context => ({ moduleId: manifest.id, gameType: "native",
    gamePath: context.inputPath, contentRootDir: context.rootDir, name: path.basename(context.inputPath, ".apk"),
    moduleData: { packagePath: context.inputPath } }) };
  const single = write("Single/example.apk"), nested = write("Nested/Inner/example.apk"), metadata = write("Metadata/example.apk");
  for (const name of [".DS_Store", "._example.apk", "Icon\r", ".localized"]) write("Metadata/" + name);
  write("Multiple/example.apk"); write("Multiple/notes.txt");
  write("Hidden/example.apk"); write("Hidden/.keep");
  write("Game.app/example.apk");
  const recognized = path.dirname(write("Recognized/example.apk"));
  const outer = { id: "outer", manifest: { id: "outer", detection: { inputKinds: ["directory"], allowUnmarkedDirectory: true } },
    detectGame: context => context.inputPath === recognized ? { moduleId: "outer", gamePath: recognized, name: "Outer" } : null };
  const alias = path.join(root, "Alias"); fs.mkdirSync(alias); fs.symlinkSync(single, path.join(alias, "linked.apk"));
  const cycle = path.join(root, "Cycle"); fs.mkdirSync(cycle); fs.symlinkSync(cycle, path.join(cycle, "again"));
  let deep = "Deep";
  for (let index = 0; index < D.DEFAULT_LIMITS.maxDirectories + 1; index++) deep += "/x";
  const deepFile = write(deep + "/example.apk");
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    for (const [input, inner] of [[path.dirname(single), single], [path.join(root, "Nested"), nested], [path.dirname(metadata), metadata], [alias, path.join(alias, "linked.apk")]]) {
      const report = await explain(input, [mod]), direct = await explain(inner, [mod]);
      assert.equal(report.error, undefined); assert.equal(report.input.requestedPath, input); assert.equal(report.input.resolvedPath, inner);
      assert.deepEqual(applyGameName(report.detected), applyGameName({ ...direct.detected, importPath: inner }));
      assert.equal(report.candidates[0].stage, "owned-extension");
    }
    for (const name of ["Multiple", "Hidden", "Game.app", "Cycle"]) {
      const report = await explain(path.join(root, name), [mod]);
      assert.equal(report.error.code, "DETECTION_UNSUPPORTED", name); assert.equal(report.detected, null);
    }
    const report = await explain(recognized, [mod, outer]);
    assert.equal(report.selectedModuleId, "outer"); assert.equal(report.detected.gamePath, recognized); assert.equal(report.input.resolvedPath, undefined);
    assert.equal((await explain(path.join(root, "Deep"), [mod])).detected.gamePath, deepFile);
  }
  const registry = { listModules: () => [manifest], getModule: () => mod, getModuleInfo: () => manifest,
    detectGame: input => applyGameName(D.resultOrThrow(D.explainDetection(input, [mod]))) };
  const imported = [];
  for (const [index, input] of [single, path.dirname(single)].entries()) {
    const launcher = createLauncher({ userDataDir: path.join(root, "profile-" + index), registry });
    const entry = await launcher.resolveEntry(input);
    imported.push({ gamePath: entry.gamePath, importPath: entry.importPath, name: entry.name, moduleData: entry.moduleData });
  }
  assert.deepEqual(imported[1], imported[0]); assert.equal(imported[1].gamePath, single); assert.equal(imported[1].importPath, single);
});
