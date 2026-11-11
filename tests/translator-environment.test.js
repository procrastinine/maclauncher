const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Contract = require("../src/modules/shared/runtime/translator-environment.mjs");

const MODULES = path.join(__dirname, "..", "src", "modules");
function declarationFiles(dir = MODULES, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) declarationFiles(full, found);
    else if (entry.name === "translator-environment.js") found.push(full);
  }
  return found;
}

const declaration = (overrides = {}) => Contract.normalizeDeclaration({ id: "dxvk", label: "DXVK", managerIds: ["translator-dxvk"],
  keys: [{ key: "DXVK_HUD", description: "HUD elements.", launcher: "Set by DXVK HUD in Runtime Settings." },
    { key: "DXVK_CONFIG", description: "Options." }],
  locked: [{ key: "WINEPREFIX", reason: "Bottle path." }, { prefix: "DYLD_", reason: "Library paths." }],
  defaults: { DXVK_LOG_LEVEL: "none" }, ...overrides });

test("every module declaration is a valid, uniquely named translator environment", () => {
  const files = declarationFiles();
  assert.ok(files.length >= 6, files.join("\n"));
  const ids = new Set();
  for (const file of files) {
    const list = require(file);
    assert.ok(Array.isArray(list) && list.length, file);
    for (const input of list) {
      const normalized = Contract.normalizeDeclaration(input);
      assert.equal(ids.has(normalized.id), false, `${normalized.id} is declared twice`);
      ids.add(normalized.id);
      assert.ok(normalized.managerIds.length, `${normalized.id} names no runtime manager`);
      assert.deepEqual(normalized.defaults, {}, `${normalized.id} global defaults stay empty until a value is shown to help`);
      for (const key of normalized.keys) assert.doesNotMatch(key.description + (key.launcher || ""), /\byou\b|—/i);
    }
  }
  for (const id of ["crossover", "sikarugir", "dxvk", "vkd3d-proton", "dxmt", "d3dmetal", "gstreamer", "moltenvk", "kosmickrisp",
    "android-jvm", "android-art", "angle", "anyps5", "prosper"]) assert.ok(ids.has(id), id);
});

test("declarations reject malformed keys, locks, duplicates and locked defaults", () => {
  assert.throws(() => declaration({ id: "Bad Id" }), /needs an id/);
  assert.throws(() => declaration({ label: "" }), /needs a label/);
  assert.throws(() => declaration({ keys: [{ key: "1BAD", description: "x" }] }), /invalid variable/);
  assert.throws(() => declaration({ keys: [{ key: "A", description: "x" }, { key: "A", description: "y" }] }), /twice/);
  assert.throws(() => declaration({ keys: [{ key: "DYLD_INSERT_LIBRARIES", description: "x" }] }), /locked variable/);
  assert.throws(() => declaration({ locked: [{ key: "A", prefix: "B", reason: "x" }] }), /invalid locked/);
  assert.throws(() => declaration({ locked: [{ key: "A" }] }), /invalid locked/);
  assert.throws(() => declaration({ defaults: { WINEPREFIX: "/x" } }), /invalid default/);
  assert.throws(() => declaration({ defaults: { A: "two\nlines" } }), /invalid default/);
  const value = declaration();
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.keys) && Object.isFrozen(value.defaults));
  assert.equal(Contract.lockedRule([value], "DYLD_LIBRARY_PATH").reason, "Library paths.");
  assert.equal(Contract.lockedRule([value], "DXVK_HUD"), null);
});

test("values are stored literally and validated by name, line and lock", () => {
  const dxvk = declaration();
  const literal = { DXVK_CONFIG: "dxvk.hud = $HOME; `echo no` 'quoted' \"double\" ~/x", EMPTY: "", SPACED: "  kept  " };
  assert.deepEqual(Contract.normalizeValues(literal, { declarations: [dxvk] }), literal);
  assert.deepEqual(Contract.normalizeValues({ DXVK_HUD: null }, { declarations: [dxvk] }), { DXVK_HUD: null });
  assert.throws(() => Contract.normalizeValues({ "BAD-NAME": "1" }), /not a valid variable name/);
  assert.throws(() => Contract.normalizeValues({ "": "1" }), /An empty name/);
  assert.throws(() => Contract.normalizeValues({ A: "x\ny" }), /one line/);
  assert.throws(() => Contract.normalizeValues({ A: "x\0" }), /one line/);
  assert.throws(() => Contract.normalizeValues({ A: 1 }), /one line/);
  assert.throws(() => Contract.normalizeValues({ WINEPREFIX: "/x" }, { declarations: [dxvk] }), /WINEPREFIX is set by MacLauncher\. Bottle path\./);
  assert.throws(() => Contract.normalizeValues({ DYLD_INSERT_LIBRARIES: "/x" }, { declarations: [dxvk] }), /set by MacLauncher/);
  assert.throws(() => Contract.normalizeValues(["A=1"]), /pairs/);
  const many = Object.fromEntries(Array.from({ length: Contract.LIMITS.entries + 1 }, (_, index) => [`V${index}`, "1"]));
  assert.throws(() => Contract.normalizeValues(many), /at most/);
  assert.deepEqual(Contract.readValues({ GOOD: "1", "BAD NAME": "1", LINES: "a\nb", NUMBER: 2, REMOVED: null }), { GOOD: "1", REMOVED: null });
  assert.deepEqual(Contract.readStore({ dxvk: { A: "1" }, "Bad Id": { A: "1" }, list: ["A=1"] }), { dxvk: { A: "1" } });
  assert.deepEqual(Contract.withValues({ dxvk: { A: "1" }, moltenvk: { B: "2" } }, "dxvk", {}), { moltenvk: { B: "2" } });
  assert.deepEqual(Contract.withValues({}, "dxvk", { A: "$X" }), { dxvk: { A: "$X" } });
  assert.throws(() => Contract.withValues({}, "../x", {}), /Unknown translator/);
});

test("launch values layer defaults, global and game values across the chosen translators", () => {
  const dxvk = declaration();
  const runtime = Contract.normalizeDeclaration({ id: "crossover", label: "CrossOver", managerIds: ["crossover"],
    keys: [{ key: "WINEDEBUG", description: "Channels." }], locked: [{ key: "CX_ROOT", reason: "Application path." }] });
  const declarations = [runtime, dxvk];
  const result = Contract.launchValues(declarations, ["crossover", "dxvk", "dxvk", "missing"], {
    global: { crossover: { WINEDEBUG: "-all", SHARED: "runtime", CX_ROOT: "/stored/before/lock" }, dxvk: { DXVK_HUD: "fps", SHARED: "dxvk", DXVK_LOG_LEVEL: null } },
    game: { dxvk: { DXVK_HUD: "full", DXVK_CONFIG: "dxvk.enableAsync = True" }, crossover: { OLD: null }, moltenvk: { MVK_CONFIG_LOG_LEVEL: "4" } }
  });
  assert.deepEqual(result.translators, ["crossover", "dxvk"]);
  assert.deepEqual(result.values, { WINEDEBUG: "-all", SHARED: "dxvk", DXVK_HUD: "full", DXVK_CONFIG: "dxvk.enableAsync = True" });
  assert.equal(result.sources.DXVK_HUD, "dxvk");
  // A game value for one translator replaces a global value of another.
  const crossed = Contract.launchValues(declarations, ["crossover", "dxvk"], { global: { dxvk: { SHARED: "dxvk" } }, game: { crossover: { SHARED: "game" } } });
  assert.equal(crossed.values.SHARED, "game");
  // Defaults apply until a layer replaces or removes them.
  assert.deepEqual(Contract.launchValues(declarations, ["dxvk"]).values, { DXVK_LOG_LEVEL: "none" });
  assert.deepEqual(Contract.launchValues(declarations, ["dxvk"], { game: { dxvk: { DXVK_LOG_LEVEL: null } } }).values, {});
  // A lock of any chosen translator applies to every chosen translator's values.
  assert.deepEqual(Contract.launchValues(declarations, ["crossover", "dxvk"], { game: { crossover: { DYLD_INSERT_LIBRARIES: "/x" } } }).values, { DXVK_LOG_LEVEL: "none" });
  assert.deepEqual(Contract.launchValues(declarations, ["crossover"], { game: { crossover: { DYLD_INSERT_LIBRARIES: "/x" } } }).values, { DYLD_INSERT_LIBRARIES: "/x" });
  assert.deepEqual(Contract.launchValues(declarations, [], { game: { crossover: { A: "1" } } }).values, {});
});

test("applying launch values keeps the consumer's required names", () => {
  const base = { PATH: "/usr/bin", WINEPREFIX: "/bottle", DXVK_HUD: "launcher" };
  assert.deepEqual(Contract.applyEnvironment(base, { DXVK_HUD: "fps", WINEPREFIX: "/elsewhere", NEW: "$PATH" }, { required: ["WINEPREFIX"] }),
    { PATH: "/usr/bin", WINEPREFIX: "/bottle", DXVK_HUD: "fps", NEW: "$PATH" });
  assert.deepEqual(base.DXVK_HUD, "launcher");
});

test("editor rows show inherited, changed, added and removed values with their sources", () => {
  const dxvk = declaration();
  const global = Contract.editorRows(dxvk, { scope: "global", global: { DXVK_HUD: "fps", DXVK_LOG_LEVEL: "info" } });
  assert.deepEqual(global.map(row => [row.name, row.state, row.value, row.inheritedSource]), [
    ["DXVK_LOG_LEVEL", "changed", "info", "default"], ["DXVK_HUD", "added", "fps", undefined]]);
  assert.equal(global[1].known.launcher, "Set by DXVK HUD in Runtime Settings.");
  const game = Contract.editorRows(dxvk, { scope: "game", global: { DXVK_HUD: "fps", DXVK_CONFIG: "a", OLD: "1" },
    game: { DXVK_HUD: "full", DXVK_CONFIG: null, EXTRA: "x" } });
  assert.deepEqual(game.map(row => [row.name, row.state, row.value, row.inheritedValue, row.inheritedSource]), [
    ["DXVK_LOG_LEVEL", "inherited", "none", "none", "default"],
    ["DXVK_HUD", "changed", "full", "fps", "global"],
    ["DXVK_CONFIG", "removed", null, "a", "global"],
    ["OLD", "inherited", "1", "1", "global"],
    ["EXTRA", "added", "x", undefined, undefined]]);
  const locked = Contract.editorRows(dxvk, { scope: "global", global: { WINEPREFIX: "/stored" } });
  assert.equal(locked.find(row => row.name === "WINEPREFIX").locked.reason, "Bottle path.");
});

test('KosmicKrisp emulation suggestions match the documented source contract and preserve per-game values', () => {
  const input = require('../src/modules/shared/vulkan/translator-environment').find(row => row.id === 'kosmickrisp');
  const kk = Contract.normalizeDeclaration(input);
  const suggestion = kk.keys.find(row => row.key === 'KK_EMULATION');
  assert.ok(suggestion, 'The existing editor declaration suggests KK_EMULATION');
  assert.doesNotMatch(kk.keys.find(row => row.key === 'MESA_KK_DEBUG').description, /\bnir\b/);
  assert.deepEqual(kk.defaults, {}, 'The suggestion introduces no global default or feature policy');
  const doc = fs.readFileSync(path.join(__dirname, '../docs/runtimes/TRANSLATOR_ENVIRONMENT.md'), 'utf8');
  const row = doc.split('\n').find(line => line.startsWith('| `KK_EMULATION` |'));
  assert.ok(row);assert.match(row, /KOSMICKRISP\.md#performance-and-conformance/);
  for (const syntax of ['performance','conformance','+name','-name','-VK_extension_name','apple7','apple11','mode=7','mode=11']) {
    assert.ok(suggestion.description.includes(syntax), syntax);
    assert.ok(row.includes(syntax), syntax);
  }
  // Unset and performance select the fast set of the detected GPU generation; conformance names its Direct3D 12 level.
  for (const text of [suggestion.description, row]) {
    assert.match(text, /Unset or `?performance`?: the fast set for this Mac's Apple GPU generation, (?:which the driver detects|detected) automatically/);
    assert.match(text, /`?conformance`?: every emulated feature \(Direct3D 12 feature level 12_2, shader model 6\.9\)/);
    assert.match(text, /runs natively/, 'a chip preset adds that generation\'s native features');
  }
  assert.ok(suggestion.description.length <= 512, 'the description fits the declaration limit');
  const debugRow = doc.split('\n').find(line => line.startsWith('| `MESA_KK_DEBUG` |'));
  assert.doesNotMatch(debugRow, /\bnir\b/);
  const value = 'conformance,+float64,-denorm_preserve,-VK_EXT_mesh_shader,apple10,mode=11';
  const values = Contract.normalizeValues({KK_EMULATION:value}, {declarations:[kk]});
  assert.deepEqual(Contract.launchValues([kk], ['kosmickrisp'], {
    global:{kosmickrisp:{KK_EMULATION:'performance'}},game:{kosmickrisp:values}
  }).values, {KK_EMULATION:value}, 'The generic environment path keeps the user value literal and lets the game override the global value');
});
