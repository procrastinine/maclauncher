const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, write, mz, pe, wad, grp, gob } = require("./helpers/engine-port-fixtures.cjs");
const Registry = require("../src/modules/registry");
const Detection = require("../src/modules/detection");

const ADDED = ["uzdoom", "raze", "dreamm"];
const all = Registry.listModules().map(info => Registry.getModule(info.id));
const before = all.filter(mod => !ADDED.includes(mod.id));
const outcome = (input, modules) => {
  const report = Detection.explainDetection(input, modules);
  return { module: report.selectedModuleId, error: report.error?.code || null, choices: report.error?.choices || null };
};

// The UZDoom, Raze and DREAMM rules run after every other game type, so each
// input another module detects, or reports as ambiguous, keeps that result.
test("Doom-engine, Build-engine and LucasArts data never changes another game type's detection", t => {
  const root = temporary(t), folder = name => path.join(root, name);
  write(path.join(folder("DOS"), "GAME.EXE"), mz());
  write(path.join(folder("DOS Doom"), "DOOM.EXE"), mz()); write(path.join(folder("DOS Doom"), "DOOM.WAD"), wad());
  write(path.join(folder("DOS Duke"), "DUKE3D.EXE"), mz()); write(path.join(folder("DOS Duke"), "DUKE3D.GRP"), grp());
  write(path.join(folder("DOS Dark Forces"), "DARK.EXE"), mz()); write(path.join(folder("DOS Dark Forces"), "DARK.GOB"), gob());
  write(path.join(folder("DOS programs"), "DOOM.EXE"), mz()); write(path.join(folder("DOS programs"), "SETUP.EXE"), mz());
  write(path.join(folder("DOS programs"), "DOOM2.WAD"), wad());
  write(path.join(folder("Windows"), "Game.exe"), pe()); write(path.join(folder("Windows"), "doom2.wad"), wad());
  write(path.join(folder("ScummVM"), "GAME.EXE"), mz()); write(path.join(folder("ScummVM"), "RESOURCE.MAP"), "map");
  write(path.join(folder("ScummVM"), "RESOURCE.000"), "data"); write(path.join(folder("ScummVM"), "DOOM.WAD"), wad());
  write(path.join(folder("Half-Life"), "hl.exe"), pe());
  write(path.join(folder("Half-Life"), "valve", "liblist.gam"), 'game "Half-Life"\ngamedll "dlls\\hl.dll"\n');
  write(path.join(folder("Half-Life"), "valve", "halflife.wad"), "WAD3");
  write(path.join(folder("Half-Life"), "valve", "dlls", "hl.dll"), "MZ half-life");
  write(path.join(folder("Half-Life"), "doom.wad"), wad());
  write(path.join(folder("Web"), "index.html"), "<html></html>"); write(path.join(folder("Web"), "freedoom1.wad"), wad());
  const inputs = ["DOS", "DOS Doom", "DOS Duke", "DOS Dark Forces", "DOS programs", "Windows", "ScummVM", "Half-Life", "Web"].map(folder)
    .flatMap(input => [input, ...require("node:fs").readdirSync(input).filter(name => /\.(?:exe|map)$/i.test(name)).map(name => path.join(input, name))]);
  const expected = { DOS: "dosbox", "DOS Doom": "dosbox", "DOS Duke": "dosbox", "DOS Dark Forces": "dosbox", "Windows": "crossover",
    ScummVM: "scummvm", "Half-Life": "xash3d", Web: "web" };
  for (const input of inputs) {
    const now = outcome(input, all), earlier = outcome(input, before);
    assert.ok(earlier.module || earlier.error === "DETECTION_CONFLICT", `${path.relative(root, input)} is an input another game type handles`);
    assert.deepEqual(now, earlier, `${path.relative(root, input)} keeps its detection`);
    if (expected[path.relative(root, input)]) assert.equal(now.module, expected[path.relative(root, input)], path.relative(root, input));
    assert.ok(!ADDED.includes(now.module), `${path.relative(root, input)} stays with its existing game type`);
  }
  assert.equal(outcome(folder("DOS programs"), all).error, "DETECTION_CONFLICT", "An ambiguous DOS folder still asks for its program");
});

test("only inputs no other game type accepts select the new runtimes", t => {
  const root = temporary(t);
  const inputs = { uzdoom: write(path.join(root, "Freedoom", "freedoom1.wad"), wad()), raze: write(path.join(root, "Duke", "DUKE3D.GRP"), grp()),
    dreamm: write(path.join(root, "Dark Forces", "DARK.GOB"), gob()) };
  for (const [id, file] of Object.entries(inputs)) for (const input of [file, path.dirname(file)]) {
    assert.equal(outcome(input, before).module, null, `${path.relative(root, input)} was unsupported`);
    assert.equal(outcome(input, all).module, id);
  }
});
