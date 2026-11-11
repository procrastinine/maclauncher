const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Modules = require("../src/modules/registry");
const { publisherAppProvider } = require("../src/modules/shared/runtime/publisher-app");
const { temporary, write, mz, wad, grp, gob } = require("./helpers/engine-port-fixtures.cjs");

const ENGINES = ["uzdoom", "raze", "dreamm"];
const offered = (entry, mod = Modules.getModule("dosbox")) => mod.filterRuntimeSupport(entry, [], {}, {}).filter(id => ENGINES.includes(id));
const dosEntry = root => ({ moduleId: "dosbox", gameType: "dos", runtimeId: "dosbox-staging", gamePath: root, contentRootDir: root, gameId: "dos1" });
// Import detection records each engine's game file; the choices read only that record.
const imported = folder => { const detected = Modules.explainDetection(folder).detected; assert.equal(detected.moduleId, "dosbox", folder); return detected; };

test("UZDoom, Raze and DREAMM are runtime choices for DOS games and keep their own game types unchanged", () => {
  assert.deepEqual(Modules.getModuleInfo("dosbox").runtime.supported.filter(id => ENGINES.includes(id)).sort(), [...ENGINES].sort());
  for (const id of ENGINES) assert.deepEqual(Modules.getModuleInfo(id).runtime.supported, [id]);
  for (const id of ["crossover", "scummvm", "xash3d"]) assert.ok(!Modules.getModuleInfo(id).runtime.supported.some(item => ENGINES.includes(item)), id);
});

test("a DOS folder offers the engine whose single main game file detection recorded", t => {
  const root = temporary(t), folder = name => path.join(root, name);
  write(path.join(folder("Doom"), "DOOM.EXE"), mz()); write(path.join(folder("Doom"), "DOOM1.WAD"), wad());
  write(path.join(folder("Duke"), "DUKE3D.EXE"), mz()); write(path.join(folder("Duke"), "DUKE3D.GRP"), grp());
  write(path.join(folder("Dark Forces"), "DARK.EXE"), mz()); write(path.join(folder("Dark Forces"), "DARK.GOB"), gob());
  write(path.join(folder("Two"), "DOOM.EXE"), mz()); write(path.join(folder("Two"), "DOOM.WAD"), wad()); write(path.join(folder("Two"), "DOOM2.WAD"), wad());
  write(path.join(folder("Program"), "GAME.EXE"), mz());
  assert.deepEqual(offered(imported(folder("Doom"))), ["uzdoom"]);
  assert.deepEqual(offered(imported(folder("Duke"))), ["raze"]);
  assert.deepEqual(offered(imported(folder("Dark Forces"))), ["dreamm"]);
  assert.deepEqual(offered(imported(folder("Two"))), []);
  assert.deepEqual(offered(imported(folder("Program"))), []);
  assert.ok(Modules.getModule("dosbox").filterRuntimeSupport(imported(folder("Doom")), [], {}, {}).includes("dosbox-staging"));
  assert.deepEqual(imported(folder("Doom")).runtimeData.uzdoom, { gameFile: "DOOM1.WAD" });
  // An entry without the record, such as one imported earlier, offers none of them.
  assert.deepEqual(offered(dosEntry(folder("Doom"))), []);
});

test("a provider launch hands the engine's own hooks the folder's main game file", async t => {
  const root = temporary(t), file = write(path.join(root, "DUKE3D.GRP"), grp());
  const calls = [];
  const hooks = { normalizeRuntimeId: () => "raze", runtimeManagers: [{ id: "raze" }], ensureRuntime: () => null,
    launchRuntime: async (runtimeId, entry) => { calls.push({ runtimeId, entry }); return "child"; } };
  const provider = publisherAppProvider({ hooks, moduleId: "raze", runtime: { label: "Raze" }, gameTypes: ["dos"], candidates: () => [file],
    entryFor: (entry, found) => ({ ...entry, contentRootDir: path.dirname(found), moduleData: { gameFile: path.basename(found) } }) });
  assert.equal(provider.runtimeId, "raze");
  assert.deepEqual(provider.runtime.input, { gameTypes: ["dos"] });
  assert.equal(provider.supportsEntry({ moduleId: "raze", gameType: "dos", gamePath: root, runtimeData: { raze: { gameFile: "DUKE3D.GRP" } } }), false);
  const entry = provider.decorateEntry(dosEntry(root));
  assert.deepEqual(entry.runtimeData.raze, { gameFile: "DUKE3D.GRP" });
  assert.equal(provider.supportsEntry(entry), true);
  assert.equal(await provider.launchRuntime("raze", entry, {}), "child");
  assert.equal(calls[0].entry.moduleData.gameFile, "DUKE3D.GRP");
  assert.equal(calls[0].entry.contentRootDir, root);
  assert.equal(calls[0].entry.gameId, "dos1");
});
