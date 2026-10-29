const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const StoredPlan = require("../src/modules/shared/effects/stored-plan");
const Plan = require("../src/modules/shared/effects/plan"), Graphics = require("../src/modules/shared/reshade/graphics-settings");
const GameStore = require("../src/core/game-store");

// Real v0.4.0 records: legacy fields as v0.4.0 normalized and persisted them,
// with the plan its editor showed for each, captured before the upgrade.
const V040 = require("./fixtures/graphics-legacy-upgrade/v0.4.0-records.json");
const TINT = "float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target { return 1; }\ntechnique T { pass { PixelShader = main; } }\n";
const HOOK = "//!HOOK MAIN\n//!BIND HOOKED\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n";
function profile(t, extra = {}) {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stored-plan-")));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(userDataDir, "Tint.fx"), TINT);fs.writeFileSync(path.join(userDataDir, "Scale.glsl"), HOOK);
  fs.mkdirSync(path.join(userDataDir, "Local.dlssmodel"));
  return {userDataDir, graphicsHost: "window", graphicsCapabilities: V040.capabilities, graphicsInputs: null, ...extra};
}
const place = (value, directory) => JSON.parse(JSON.stringify(value).split("$DIR").join(directory));
const migrateOwnership = plan => require("../src/modules/shared/effects/edit-operations.mjs").migrateOwnership(plan);
// The rows a v0.4.0 selection implied become its helpers: the neural input
// reduction and automatic fit, and a scaling hook's final fit.
function withHelpers(plan, graphics = {}) {
  const owners = {"legacy-neural-input": {id: "legacy-neural", role: "input"}, "legacy-spatial-fit": {id: "legacy-spatial-shader", role: "fit"},
    ...(graphics.neuralMethod === "mlx-dlss" && graphics.spatialMethod === "off" && !graphics.spatialShader ? {"legacy-spatial": {id: "legacy-neural", role: "fit"}} : {})};
  return StoredPlan.accept(migrateOwnership({...plan, video: plan.video.map(row => owners[row.id] ? {...row, ownedBy: owners[row.id]} : row)}));
}
const legacy = graphics => ({schemaVersion: 1, gameId: "game", gamePath: "/Games/Example", moduleId: "mz", runtimeId: "nwjs",
  reshade: {enabled: false, preset: "crt", effectPath: null}, graphics: Graphics.normalizeSettings(graphics), effects: null});
const rows = plan => plan.video.map(row => [row.id, row.enabled]);

test("v0.4.0 Simple records upgrade to the plan the editor showed (S4)", t => {
  const options = profile(t);
  for (const [name, stored] of Object.entries(V040.records)) {
    const record = place(stored, options.userDataDir), before = structuredClone(record);
    const upgraded = StoredPlan.upgradeLegacy(record, options), editor = V040.editor[name];
    assert.equal(Object.hasOwn(upgraded, "reshade") || Object.hasOwn(upgraded, "graphics"), false, name);
    assert.deepEqual(upgraded.effects, editor && withHelpers(place(editor, options.userDataDir), record.graphics), name);
    if (editor) assert.equal(upgraded.effects.schema, 2, name);
    assert.equal(upgraded.effectsNotices, undefined, `${name}: usable selections need no attention`);
    const {reshade: _shader, graphics: _graphics, effects: _effects, ...rest} = before, {effects: _plan, ...kept} = upgraded;
    assert.deepEqual(kept, rest, `${name}: other record fields are unchanged`);assert.deepEqual(record, before, `${name}: the input is not mutated`);
  }
});

test("the upgrade is idempotent and a stored record is rewritten once, then never read as legacy", t => {
  const options = profile(t), record = place(V040.records["CRT pack shader + FSR2/FSR1/LSFG after"], options.userDataDir);
  GameStore.writeGameRecord(options.userDataDir, record);
  const file = path.join(options.userDataDir, "games", record.gameId, "game.json");
  // Loading a record upgrades it (the game-store hook); each atomic write
  // renames a new file into place.
  let writes = 0, inode = fs.statSync(file).ino;
  const load = () => {
    const games = GameStore.loadGames(options.userDataDir), next = fs.statSync(file).ino;
    if (next !== inode) {writes++;inode = next;}
    return games;
  };
  const [first] = load();
  assert.equal(writes, 1);assert.equal(StoredPlan.upgradeLegacy(first, options), first, "an upgraded record is returned unchanged");
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.hasOwn(persisted, "reshade") || Object.hasOwn(persisted, "graphics"), false, "one atomic write removes the legacy fields");
  assert.deepEqual(persisted.effects, JSON.parse(JSON.stringify(first.effects)));
  const shader = t.mock.method(require("../src/modules/shared/reshade/shader-settings"), "normalizeSettings");
  const graphics = t.mock.method(Graphics, "normalizeSettings");
  const [second] = load();
  assert.equal(writes, 1, "a later load writes nothing");
  const read = StoredPlan.read(second);
  assert.equal(read.source, "effects");assert.deepEqual(read.plan, first.effects);
  assert.equal(shader.mock.callCount() + graphics.mock.callCount(), 0, "no legacy field is read after the upgrade");
  // A stray legacy field never changes a saved graph.
  assert.deepEqual(StoredPlan.read({...second, reshade: {enabled: true, preset: "grayscale"}}).plan, read.plan);
  assert.deepEqual(StoredPlan.read({effects: null}).plan, {schema: 2, mode: "advanced", enabled: true, video: []}, "null effects is the empty plan");
});

test("a record whose one-time write failed is upgraded in memory, never rejected", t => {
  const options = profile(t), simple = {gameId: "game", effects: null, reshade: {enabled: true, preset: "grayscale"}, graphics: Graphics.normalizeSettings({spatialMethod: "fsr1"})};
  let read = StoredPlan.read(simple, options);
  assert.equal(read.source, "effects");assert.equal(read.migrated, true);
  assert.deepEqual(rows(read.plan), [["legacy-spatial", true], ["legacy-shader", true]]);
  assert.deepEqual(read.upgraded, StoredPlan.upgradeLegacy(simple, options), "the caller persists the same upgrade");
  const schema1 = place(V040.advanced["Advanced graph with local files"].effects, options.userDataDir);
  read = StoredPlan.read({gameId: "game", effects: schema1}, options);
  assert.equal(read.source, "effects");assert.equal(read.plan.schema, 2);assert.equal(read.migrated, true);
  assert.deepEqual(read.upgraded, {gameId: "game", effects: StoredPlan.accept(Plan.migrate(schema1))});
  const inspected = StoredPlan.inspect(schema1, options);
  assert.deepEqual(inspected.plan, read.plan);assert.equal(inspected.migrated, true);
  assert.deepEqual(StoredPlan.inspect({schema: 1, mode: "advanced", video: "rows"}, options).plan.video, [], "an unreadable v0.4.0 graph reads as empty");
});

test("missing and relative paths leave their rows off with a reason; other rows still convert", t => {
  const options = profile(t), dir = options.userDataDir, missing = path.join(dir, "Missing.fx");
  const cases = [
    [{reshade: {enabled: true, preset: "custom", effectPath: missing}, graphics: Graphics.normalizeSettings({temporalMethod: "fsr2"})},
      [["legacy-temporal", true], ["legacy-shader", false]], "legacy-shader", /Missing\.fx.*missing or unreadable/, plan => assert.equal(plan.video[1].shader.effectPath, missing)],
    [{reshade: {enabled: true, preset: "custom", effectPath: "shaders/Tint.fx"}, graphics: Graphics.normalizeSettings({spatialMethod: "fsr1"})},
      [["legacy-spatial", true], ["legacy-shader", false]], "legacy-shader", /shaders\/Tint\.fx.*not a supported absolute/, plan => assert.equal(plan.video[1].shader.effectPath, null)],
    [{...legacy({neuralMethod: "mlx-dlss", neuralModelPath: path.join(dir, "Gone.dlssmodel"), frameGeneration: "lsfg"})},
      [["legacy-neural-input", false], ["legacy-neural", false], ["legacy-spatial", false], ["legacy-frame-generation", true]], "legacy-neural", /Gone\.dlssmodel/,
      plan => assert.equal(plan.renderResolution, undefined, "a reduction made only for the neural row is dropped")],
    [{graphics: {...legacy({neuralMethod: "mlx-dlss", spatialMethod: "fsr1"}).graphics, neuralModelPath: "Models/Local.dlssmodel"}},
      [["legacy-neural-input", false], ["legacy-neural", false], ["legacy-spatial", true]], "legacy-neural", /not an absolute file path/,
      plan => assert.equal(plan.video[1].settings.modelPath, null)],
    [{...legacy({spatialShader: {enabled: true, preset: "custom", effectPath: path.join(dir, "Gone.glsl")}, spatialMultiplier: 2, frameGeneration: "lsfg"})},
      [["legacy-spatial-shader", false], ["legacy-spatial-fit", false], ["legacy-frame-generation", true]], "legacy-spatial-shader", /Gone\.glsl/,
      plan => assert.equal(plan.renderResolution, undefined)],
    [{reshade: {enabled: true, preset: "filter:0f8fad5b-d9cb-469f-a165-70867728950e"}, graphics: Graphics.normalizeSettings({})},
      [["legacy-shader", false]], "legacy-shader", /imported filter is unavailable/],
    [{...legacy({spatialMethod: "ls1", frameGeneration: "lsfg", modelVersion: path.join(dir, "Lossless.dll")})},
      [["legacy-spatial", false], ["legacy-frame-generation", false]], "legacy-spatial", /Lossless\.dll/],
    [{...legacy({spatialMethod: "libplacebo:retired", spatialMultiplier: 2, temporalMethod: "fsr2"})},
      [["legacy-temporal", true], ["legacy-spatial", false]], "legacy-spatial", /libplacebo filter “retired”/, plan => assert.equal(plan.renderResolution, undefined)]
  ];
  for (const [record, expected, rowId, reason, check] of cases) {
    const upgraded = StoredPlan.upgradeLegacy({gameId: "game", ...record}, options);
    assert.deepEqual(rows(upgraded.effects), expected, JSON.stringify(record));
    assert.equal(upgraded.effectsNotices.find(notice => notice.rowId === rowId)?.message.match(reason) !== null, true, JSON.stringify(upgraded.effectsNotices));
    assert.equal(StoredPlan.read(upgraded).source, "effects", "the upgraded plan is valid in this version");
    check?.(upgraded.effects);
  }
});

test("files from another profile's managed stores are remapped to this profile", t => {
  const options = profile(t), dir = options.userDataDir, version = "sha256-" + "c".repeat(64);
  const former = "/Users/former/Library/Application Support/MacLauncher";
  const library = path.join(dir, "runtimes", "graphics-shader-library", "pack", "1");
  fs.mkdirSync(library, {recursive: true});fs.writeFileSync(path.join(library, "Tint.fx"), TINT);
  const modelPath = path.join(dir, "runtimes", "graphics-neural-models", version, "model.vsrmodel");
  t.mock.method(require("../src/modules/shared/reshade/neural/models"), "listInstalled", () => [{version, modelPath}]);
  const upgraded = StoredPlan.upgradeLegacy({gameId: "game",
    reshade: {enabled: true, preset: "custom", effectPath: former + "/runtimes/graphics-shader-library/pack/1/Tint.fx"},
    graphics: Graphics.normalizeSettings({neuralMethod: "mlx-dlss", neuralModelPath: `${former}/runtimes/graphics-neural-models/${version}/model.dlssmodel`})}, options);
  assert.equal(upgraded.effectsNotices, undefined);
  assert.equal(upgraded.effects.video.find(row => row.id === "legacy-shader").shader.effectPath, path.join(library, "Tint.fx"));
  assert.equal(upgraded.effects.video.find(row => row.id === "legacy-neural").settings.modelPath, modelPath, "a managed model maps by version to its current package");
  assert.equal(upgraded.effects.video.every(row => row.enabled), true);
});

test("unknown methods, retired presets and malformed values never throw and are reported", t => {
  const options = profile(t);
  const upgrade = record => StoredPlan.upgradeLegacy({gameId: "game", ...record}, options);
  let upgraded = upgrade({reshade: {enabled: true, preset: "shader:retired-pack:crt"}, graphics: {...Graphics.normalizeSettings({temporalMethod: "fsr2"}), spatialMethod: "dlss9", frameGeneration: 7}});
  assert.deepEqual(rows(upgraded.effects), [["legacy-temporal", true]]);
  assert.deepEqual(upgraded.effectsNotices.map(notice => notice.message), ["The saved shader “shader:retired-pack:crt” is no longer available.",
    "The saved spatial scaling method “dlss9” is no longer available.", "The saved frame generation method “7” is no longer available."]);
  upgraded = upgrade({reshade: "garbage", graphics: [1, 2]});
  assert.equal(upgraded.effects, null);assert.equal(upgraded.effectsNotices.length, 2);
  upgraded = upgrade({reshade: {enabled: true, preset: "grayscale", parameters: {Strength: "high"}}, graphics: {spatialMethod: "bilinear", spatialMultiplier: "x", targetFps: -1, neuralIntensity: 9, frameGeneration: "lsfg", lsfgFlowScale: 99}});
  assert.deepEqual(rows(upgraded.effects), [["legacy-spatial", true], ["legacy-frame-generation", true], ["legacy-shader", true]], "malformed values use their defaults");
  assert.equal(upgraded.effects.video[1].settings.lsfgFlowScale, 1);assert.equal(upgraded.effects.video[2].shader.parameters, undefined);
  upgraded = upgrade({reshade: {enabled: true}, graphics: {spatialShader: {enabled: true, preset: 42}}});
  assert.equal(upgraded.effects, null);
  assert.deepEqual(upgraded.effectsNotices.map(notice => notice.message), ["The saved shader selection could not be read.", "The saved scaling shader selection could not be read."]);
  assert.equal(upgrade({reshade: null, graphics: undefined}).effects, null);
});

test("a selection that cannot be converted is reported while the others convert; total failure clears with a notice", t => {
  const options = profile(t), record = {gameId: "game", reshade: {enabled: true, preset: "grayscale"}, graphics: Graphics.normalizeSettings({temporalMethod: "fsr2", spatialMethod: "fsr1"})};
  const compose = Plan.composeSimple;
  const mock = t.mock.method(Plan, "composeSimple", (entry, ...rest) => {
    if (entry.graphics.temporalMethod === "fsr2") throw new Error("Temporal rows are unavailable.");
    return compose(entry, ...rest);
  });
  let upgraded = StoredPlan.upgradeLegacy(record, options);
  assert.deepEqual(rows(upgraded.effects), [["legacy-spatial", true], ["legacy-shader", true]]);
  assert.deepEqual(upgraded.effectsNotices, [{message: "The saved temporal upscaling setting could not be converted: Temporal rows are unavailable."}]);
  mock.mock.mockImplementation(() => { throw new Error("broken"); });
  upgraded = StoredPlan.upgradeLegacy(record, options);
  assert.equal(upgraded.effects, null);assert.deepEqual(upgraded.effectsNotices, [{message: "The saved graphics settings could not be converted and were cleared."}]);
  assert.equal(Object.hasOwn(upgraded, "reshade"), false);
  assert.equal(StoredPlan.upgradeLegacy(upgraded, options), upgraded);
});

test("moved shader presets keep their selection, and earlier qUINT copies use the managed qUINT collection", t => {
  const options = profile(t), record = {gameId: "game", reshade: {enabled: true, preset: "pack:sweetfx:93ddf39b357f:tonemap", parameters: {Exposure: [1]}}, graphics: Graphics.normalizeSettings({})};
  let upgraded = StoredPlan.upgradeLegacy(record, options);
  assert.deepEqual(upgraded.effects.video[0].shader, {enabled: true, preset: "shader:sweetfx:tonemap", effectPath: null, parameters: {Exposure: [1]}});
  assert.equal(upgraded.effectsNotices, undefined);
  upgraded = StoredPlan.upgradeLegacy(place(V040.records["previously downloaded qUINT shader + FSR1"], options.userDataDir), options);
  assert.deepEqual(rows(upgraded.effects), [["legacy-spatial", true], ["legacy-shader", true]]);
  assert.equal(upgraded.effects.video[1].shader.preset, "shader:managed-quint:8973665f7db55018");
  assert.equal(upgraded.effectsNotices, undefined);
});

test("v0.4.0 Advanced graphs are kept, migrated and checked like Simple selections", t => {
  const options = profile(t), version = "sha256-" + "b".repeat(64);
  const record = place(V040.advanced["Advanced graph with local files"], options.userDataDir);
  let upgraded = StoredPlan.upgradeLegacy(record, options);
  assert.equal(upgraded.effectsNotices, undefined);
  assert.deepEqual(upgraded.effects, StoredPlan.accept(Plan.migrate(record.effects)));assert.equal(upgraded.effects.schema, 2);
  const modelPath = path.join(options.userDataDir, "runtimes", "graphics-neural-models", version, "model.dlssmodel");
  fs.mkdirSync(modelPath, {recursive: true});
  upgraded = StoredPlan.upgradeLegacy(place(V040.advanced["Advanced graph from another profile"], options.userDataDir), options);
  assert.deepEqual(rows(upgraded.effects), [["tint", false], ["fsr", true], ["dlss", true], ["gen", true]]);
  assert.equal(upgraded.effects.video[2].settings.modelPath, modelPath);
  assert.deepEqual(upgraded.effectsNotices.map(notice => notice.rowId), ["tint"]);
  // Rows and fields that no longer validate are reported; the rest is kept.
  const effects = {...record.effects, video: [...record.effects.video, {id: "retired", kind: "temporal", enabled: true, method: "dlss9", settings: {}}], renderResolution: {multiplier: "half"}};
  upgraded = StoredPlan.upgradeLegacy({...record, effects}, options);
  assert.deepEqual(rows(upgraded.effects), [["tint", true], ["fsr", true], ["dlss", true], ["gen", true]]);assert.equal(upgraded.effects.renderResolution, undefined);
  assert.deepEqual(upgraded.effectsNotices.map(notice => notice.message.split(":")[0]), ["The saved effect “retired” could not be converted", "The saved source resolution could not be converted"]);
  upgraded = StoredPlan.upgradeLegacy({...record, effects: {schema: 1, mode: "advanced", video: "rows"}}, options);
  assert.equal(upgraded.effects, null);assert.equal(upgraded.effectsNotices.length, 1);
  // The Simple fields beside a saved graph were inactive; only the graph is kept.
  const mixed = V040.advanced["Simple fields with an Advanced graph"];
  upgraded = StoredPlan.upgradeLegacy(mixed, options);
  assert.equal(Object.hasOwn(upgraded, "reshade") || Object.hasOwn(upgraded, "graphics"), false);
  assert.deepEqual(upgraded.effects, StoredPlan.accept(Plan.migrate(mixed.effects)));assert.equal(upgraded.effectsNotices, undefined);
  // Only v0.4.0 wrote schema 1. A later graph is kept byte-equivalent, valid
  // or not; an invalid one blocks editing until Clear effects (Q1).
  for (const effects of [{schema: 3, mode: "advanced", video: [], futureField: true}, {schema: 2, mode: "advanced", video: "rows"}, Plan.migrate(record.effects)]) {
    upgraded = StoredPlan.upgradeLegacy({...record, effects}, options);
    assert.equal(upgraded.effects, effects);assert.equal(upgraded.effectsNotices, undefined);assert.equal(Object.hasOwn(upgraded, "reshade"), false);
  }
  assert.equal(StoredPlan.read({effects: {schema: 3, mode: "advanced", video: []}}).error.code, StoredPlan.NEWER);
});

test("the upgrade discovers scaler capabilities only for selections that need them", t => {
  const {graphicsCapabilities: _known, ...options} = profile(t);
  const discover = t.mock.method(Graphics, "capabilities", () => V040.capabilities);
  for (const graphics of [{temporalMethod: "fsr2"}, {spatialMethod: "fsr1"}, {frameGeneration: "lsfg"}])
    StoredPlan.upgradeLegacy({gameId: "game", reshade: {enabled: true, preset: "grayscale"}, graphics: Graphics.normalizeSettings(graphics)}, options);
  assert.equal(discover.mock.callCount(), 0);
  StoredPlan.upgradeLegacy(legacy({neuralMethod: "mlx-dlss", spatialMultiplier: 2}), options);
  assert.equal(discover.mock.callCount(), 1, "neural fitting and its source request share one discovery");
  assert.deepEqual(discover.mock.calls[0].arguments[2].selectedMethods, {spatial: [], temporal: [], neural: ["mlx-dlss"], generation: []});
});

test("a saved schema-2 graph is read as effects", () => {
  const effects = {schema: 2, mode: "advanced", enabled: true, video: [{id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}]};
  const entry = {effects}, before = structuredClone(entry);
  const stored = StoredPlan.read(entry);
  assert.equal(stored.source, "effects");assert.equal(stored.migrated, false);assert.deepEqual(stored.plan, Plan.validate(effects));
  assert.equal(stored.revision, StoredPlan.revision(Plan.validate(effects)));assert.deepEqual(entry, before);
  stored.plan.video[0].enabled = false;
  assert.equal(StoredPlan.read(entry).plan.video[0].enabled, true, "a caller's copy never changes a later read");
  const empty = StoredPlan.read({});empty.plan.video.push({});
  assert.deepEqual(StoredPlan.read({}).plan.video, [], "the shared empty plan is copied too");
});

test("revisions are canonical: key order does not change a digest", () => {
  const left = {schema: 2, mode: "advanced", enabled: true, video: [{id: "a", kind: "shader", enabled: true, shader: {preset: "grayscale", enabled: true}}]};
  const right = {video: [{shader: {enabled: true, preset: "grayscale"}, enabled: true, kind: "shader", id: "a"}], enabled: true, mode: "advanced", schema: 2};
  assert.equal(StoredPlan.revision(left), StoredPlan.revision(right));
  assert.notEqual(StoredPlan.revision(left), StoredPlan.revision({...left, enabled: false}));
  assert.equal(StoredPlan.canonical({b: 1, a: [undefined, {d: undefined, c: 2}]}), '{"a":[null,{"c":2}],"b":1}');
});

test("an invalid stored plan is reported and survives persistence byte-equivalent (S5)", () => {
  const unknown = {schema: 2, mode: "advanced", enabled: true, video: [{id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}], extra: true};
  const newer = {schema: 3, mode: "advanced", video: [], futureField: {nested: [1, 2, 3]}};
  for (const [effects, code] of [[unknown, StoredPlan.INVALID], [newer, StoredPlan.NEWER], [{schema: 2, video: "rows"}, StoredPlan.INVALID]]) {
    const entry = {effects}, before = structuredClone(entry);
    const stored = StoredPlan.read(entry);
    assert.equal(stored.source, "invalid");assert.equal(stored.error.code, code);assert.equal(stored.raw, effects);
    assert.match(stored.error.message, /Clear effects/);
    assert.equal(JSON.stringify(StoredPlan.serialize(effects)), JSON.stringify(effects), "an unrelated record save keeps the bytes");
    assert.deepEqual(entry, before);
    const error = StoredPlan.error(stored);assert.equal(error.code, code);
  }
  const oversize = {schema: 2, mode: "advanced", video: [], padding: "x".repeat(StoredPlan.LIMIT)};
  const marker = StoredPlan.serialize(oversize);
  assert.equal(marker.error, StoredPlan.INVALID, "an unbounded value becomes an explicit invalid marker");
  assert.equal(StoredPlan.read({effects: marker}).source, "invalid");
  assert.equal(StoredPlan.serialize(null), null);assert.equal(StoredPlan.serialize(undefined), null);
});

test("an unchanged stored record is validated once and a branded plan is never validated again", t => {
  const effects = {schema: 2, mode: "advanced", enabled: true, video: [{id: "unique-" + Date.now(), kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}]};
  const validate = t.mock.method(Plan, "validate");
  const first = StoredPlan.read({effects: structuredClone(effects)});
  const calls = validate.mock.callCount();assert.equal(calls, 1);
  const again = StoredPlan.read({effects: structuredClone(effects)});
  assert.equal(validate.mock.callCount(), calls, "a reloaded record with the same bytes reuses its validation");
  assert.equal(again.revision, first.revision);assert.notEqual(again.plan, first.plan);
  assert.equal(StoredPlan.checked(again.plan), again.plan);assert.equal(StoredPlan.execution(again.plan), again.plan);
  assert.equal(validate.mock.callCount(), calls);
  const off = StoredPlan.execution({...again.plan, enabled: false});
  assert.equal(off.video.every(node => !node.enabled), true);assert.equal(validate.mock.callCount(), calls + 1, "an unbranded plan is validated");
  // Persisting a merged edit primes the next read of its record.
  const merged = StoredPlan.accept({...effects, video: [{...effects.video[0], enabled: false}]}), revision = StoredPlan.revision(merged);
  const record = StoredPlan.serialize(merged), count = validate.mock.callCount();
  const next = StoredPlan.read({effects: structuredClone(record)});
  assert.equal(validate.mock.callCount(), count);assert.equal(next.revision, revision);assert.deepEqual(next.plan, merged);
});

test("owned helper rows validate once with their ownership kept", () => {
  const plan = {schema: 2, mode: "advanced", enabled: true, video: [
    {id: "auto-scale-input-up", kind: "downsample", enabled: true, method: "bilinear", settings: {}, extent: {relativeTo: "input", factor: .5}, ownedBy: {id: "up", role: "input"}},
    {id: "up", kind: "upscale", enabled: true, method: "metalfx", settings: {}, extent: {relativeTo: "presentation", factor: 1}}]};
  const accepted = StoredPlan.accept(plan);
  assert.deepEqual(accepted.video[0].ownedBy, {id: "up", role: "input"});assert.equal(StoredPlan.isValidated(accepted), true);
  assert.throws(() => StoredPlan.accept({...plan, video: [{...plan.video[0], ownedBy: {id: "up", role: "input", extra: 1}}, plan.video[1]]}), /unsupported fields/);
});

test("renderer edits are shape-checked before their single merged validation", () => {
  const plan = {schema: 2, mode: "advanced", enabled: true, video: [{id: "a", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}}]};
  assert.equal(StoredPlan.shape(plan), plan);
  const polluted = JSON.parse('{"schema":2,"mode":"advanced","video":[{"id":"a","kind":"shader","enabled":true,"shader":{"__proto__":{"polluted":true}}}]}');
  assert.throws(() => StoredPlan.shape(polluted), /Invalid effect settings/);
  assert.throws(() => StoredPlan.shape({...plan, video: Array.from({length: Plan.MAX_NODES + 1}, (_, index) => ({id: "r" + index}))}), /valid ordered/);
  assert.throws(() => StoredPlan.shape({...plan, video: [new Map()]}), /valid ordered/);
  assert.throws(() => StoredPlan.shape(null), /valid ordered/);
  assert.equal({}.polluted, undefined);
  // Row by row, an edit keeps the rows that can be merged and reports the rest.
  const rows = StoredPlan.shapeRows({...plan, video: [plan.video[0], polluted.video[0], "row", {kind: "shader"}]});
  assert.deepEqual(rows.value.video, [plan.video[0]]);
  assert.deepEqual(rows.dropped.map(row => row.id), ["a", "#3", "#4"]);assert.match(rows.dropped[0].reason, /Invalid effect settings/);
  assert.equal(StoredPlan.shapeRows(plan).value, plan);assert.deepEqual(StoredPlan.shapeRows(plan).dropped, []);
  assert.throws(() => StoredPlan.shapeRows({...plan, renderResolution: polluted.video[0].shader}), /Invalid effect settings/);
  assert.equal({}.polluted, undefined);
});

test("a stored plan with an unreadable row keeps its other rows and reports the skipped part", () => {
  const gray = {id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
  // The row's sizing helper and the source request it manages go with it.
  const effects = {schema: 2, mode: "advanced", enabled: true, renderResolution: {multiplier: 2, managedBy: "broken"}, video: [gray,
    {id: "input", kind: "downsample", enabled: true, method: "area", extent: {relativeTo: "input", factor: .5}, settings: {}, ownedBy: {id: "broken", role: "input"}},
    {id: "broken", kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: null}, future: 1}]};
  const entry = {effects}, before = structuredClone(entry), stored = StoredPlan.read(entry);
  assert.equal(stored.source, "effects");
  const {renderResolution: _source, ...kept} = effects;assert.deepEqual(stored.plan, Plan.validate({...kept, video: [gray]}));
  assert.deepEqual(stored.dropped.map(part => part.id), ["broken", "input", "renderResolution"]);
  assert.deepEqual(StoredPlan.notices(stored).map(notice => notice.dropped), [true, true, true]);
  assert.match(StoredPlan.notices(stored)[0].message, /^The saved effect “mlx-dlss” is skipped\. Effect rows contain unsupported fields\./);
  assert.match(StoredPlan.notices(stored)[2].message, /^The saved source resolution is skipped\./);
  assert.deepEqual(StoredPlan.read(entry).dropped, stored.dropped, "a cached read reports the same parts");
  assert.equal(JSON.stringify(StoredPlan.serialize(effects)), JSON.stringify(effects), "the saved value is kept until an edit");
  assert.deepEqual(entry, before);assert.equal(stored.revision, StoredPlan.revision(stored.plan));
  // A desired plan from an editor is salvaged the same way; its envelope is not.
  const desired = StoredPlan.salvage(effects);
  assert.deepEqual(desired.plan, stored.plan);assert.deepEqual(desired.dropped, stored.dropped);
  assert.equal(StoredPlan.salvage({schema: 3, mode: "advanced", video: []}).error.code, StoredPlan.NEWER);
  assert.equal(StoredPlan.salvage({...effects, extra: true}).error.code, StoredPlan.INVALID);
  assert.deepEqual(StoredPlan.notices({}), []);
});

// Ownership migration (edit-operations). Saved shapes from effects-plan,
// effects-runtime, effects-simple-composition, effects-controls and
// graphics-plan-edits, including the U1 and U2 damaged plans.
const Ops = require("../src/modules/shared/effects/edit-operations.mjs"), PlanModel = require("../src/modules/shared/effects/plan.mjs");
const owned = plan => plan.video.filter(row => row.ownedBy).map(row => [row.id, row.ownedBy.id, row.ownedBy.role]);
const settled = (value, label) => {
  const migrated = Ops.migrateOwnership(value);
  assert.deepEqual(Ops.check(migrated), [], label);assert.equal(Ops.migrateOwnership(migrated), migrated, `${label}: migration is idempotent`);
  assert.deepEqual(PlanModel.validate(migrated).video.map(row => row.ownedBy), migrated.video.map(row => row.ownedBy), `${label}: validation keeps ownership`);
  return migrated;
};
const advanced = (video, extra = {}) => ({schema: 2, mode: "advanced", enabled: true, video, ...extra});
const resize = (id, kind, method, extra = {}) => ({id, kind, method, enabled: true, settings: {}, ...extra});
const filter = (id, preset = "filter:double", enabled = true) => ({id, kind: "shader", enabled, shader: {enabled: true, preset, parameters: null}});

test("only conventional helper ids of a schema-2 plan imply ownership", () => {
  const converted = advanced([filter("legacy-spatial-shader"), resize("legacy-spatial-fit", "spatial", "metalfx", {settings: {spatialMethod: "metalfx", spatialMultiplier: null}}),
    resize("legacy-neural-input", "downsample", "bilinear", {extent: {height: 540}}), {id: "legacy-neural", kind: "neural", method: "mlx-dlss", enabled: true, settings: {modelPath: null}}]);
  assert.equal(settled(converted, "converter ids"), converted, "rows named by the legacy converter are ordinary rows");
  const older = {schema: 1, mode: "advanced", video: [resize("auto-scale-input-up", "spatial", "downsample", {presentationScale: .5}), resize("up", "spatial", "metalfx")]};
  assert.equal(Ops.migrateOwnership(older), older, "another schema is not converted here");
});

test("saved prefix helpers gain explicit ownership and keep their owned source request", () => {
  const canonical = advanced([
    resize("auto-nr-input-nr", "downsample", "bilinear", {extent: {relativeTo: "presentation", automatic: true}}),
    {id: "nr", kind: "neural", method: "mlx-dlss", enabled: true, settings: {modelPath: null, intensity: 1, temporal: false}},
    resize("auto-nr-fit-nr", "upscale", "bilinear")], {renderResolution: {multiplier: 2, managedBy: "nr"}});
  const nr = settled(canonical, "canonical neural");
  assert.deepEqual(owned(nr), [["auto-nr-input-nr", "nr", "input"], ["auto-nr-fit-nr", "nr", "fit"]]);assert.deepEqual(nr.renderResolution, canonical.renderResolution);
  const simple = advanced([filter("look", "vibrance"), resize("auto-scale-input-up", "downsample", "bilinear", {extent: {relativeTo: "presentation", factor: .5}}),
    resize("up", "upscale", "fsr1"), resize("auto-scale-fit-up", "spatial", "bicubic")], {renderResolution: {multiplier: 2, managedBy: "up"}});
  const up = settled(simple, "Simple upscaler");
  assert.deepEqual(owned(up), [["auto-scale-input-up", "up", "input"], ["auto-scale-fit-up", "up", "fit"]]);
  assert.equal(up.video[0], simple.video[0], "unowned rows keep identity");assert.deepEqual(up.renderResolution, simple.renderResolution);
  const reordered = settled({...simple, video: [simple.video[0], simple.video[2], simple.video[1], simple.video[3]]}, "owner moved above its input");
  assert.deepEqual(reordered.video.map(row => row.id), simple.video.map(row => row.id));
});

test("U1 and U2 damage is repaired: helpers follow their owner and orphaned sizing returns to full resolution", () => {
  const input = resize("auto-scale-input-look", "downsample", "bilinear", {extent: {relativeTo: "presentation", factor: .5}}), fit = resize("auto-scale-fit-look", "spatial", "bicubic");
  const u1 = settled(advanced([input, filter("look", "filter:double", false), fit], {renderResolution: {multiplier: 2, managedBy: "look"}}), "U1");
  assert.deepEqual(u1.video.map(row => [row.id, row.enabled]), [[input.id, false], ["look", false], [fit.id, false]]);assert.equal(u1.renderResolution, undefined);
  const u2 = settled(advanced([filter("other", "vibrance"), input, fit], {renderResolution: {multiplier: 2, managedBy: "look"}}), "U2");
  assert.deepEqual(u2.video.map(row => row.id), ["other"]);assert.equal(u2.renderResolution, undefined);
  const missing = settled(advanced([filter("a", "custom")], {renderResolution: {multiplier: 2, managedBy: "upscale"}}), "rebase fixture");
  assert.equal(missing.renderResolution, undefined);
  const chained = settled(advanced([resize("x", "upscale", "metalfx"), resize("auto-nr-fit-x", "upscale", "bilinear"), resize("auto-scale-fit-auto-nr-fit-x", "spatial", "bilinear")]), "helper of a helper");
  assert.deepEqual(chained.video.map(row => row.id), ["x", "auto-nr-fit-x"]);
});

test("inert or adopted pairings migrate without changing what runs", () => {
  const adopted = settled(advanced([resize("8a6c1f9e-uuid", "downsample", "bilinear", {extent: {height: 360}}), resize("up", "upscale", "metalfx")],
    {renderResolution: {multiplier: 2, managedBy: "up"}}), "adopted input");
  assert.deepEqual(adopted.renderResolution, {multiplier: 2}, "the render size stays and becomes a manual choice");assert.deepEqual(owned(adopted), []);
  const inert = settled(advanced([resize("auto-scale-input-up", "downsample", "bilinear", {enabled: false, extent: {relativeTo: "presentation", factor: .5}}),
    resize("up", "upscale", "metalfx"), resize("auto-scale-fit-up", "spatial", "bilinear", {enabled: false})], {renderResolution: {height: 720}}), "disabled helpers of an enabled owner");
  assert.deepEqual(inert.video.map(row => row.id), ["up"]);assert.deepEqual(inert.renderResolution, {height: 720});
  const both = settled(advanced([resize("auto-nr-input-x", "downsample", "bilinear", {enabled: false, extent: {height: 540}}),
    resize("auto-scale-input-x", "downsample", "bilinear", {extent: {relativeTo: "presentation", factor: .5}}), resize("x", "upscale", "metalfx")],
    {renderResolution: {multiplier: 2, managedBy: "x"}}), "two inputs for one owner");
  assert.deepEqual(owned(both), [["auto-scale-input-x", "x", "input"]]);
});

test("values that are not readable plans are returned for validation to report", () => {
  for (const value of [null, "plan", {schema: 3, mode: "advanced", video: []}, {schema: 2, video: "rows"}, {schema: 2, video: [null]}, {schema: 1, mode: "advanced", video: [{id: "x"}]}, {schema: 1, mode: "advanced", video: []}])
    assert.equal(Ops.migrateOwnership(value), value);
  const malformed = advanced([resize("h", "downsample", "bilinear", {ownedBy: {id: "up"}}), resize("up", "upscale", "metalfx")]);
  assert.equal(Ops.migrateOwnership(malformed), malformed);assert.equal(Ops.check(malformed)[0].code, "O1");
  assert.throws(() => PlanModel.validate(malformed), /owner's row ID/);
  const dangling = advanced([resize("h", "downsample", "bilinear", {ownedBy: {id: "gone", role: "input"}}), resize("up", "upscale", "metalfx")]);
  assert.throws(() => PlanModel.validate(dangling), /not in the plan/, "validation reports a dangling owner");
  assert.deepEqual(settled(dangling, "dangling owner").video.map(row => row.id), ["up"], "migration retires it");
});

test("an upgraded Simple selection is stored in Simple order", () => {
  const options = {graphicsHost: "remote", graphicsInputs: {sourceResolution: false},
    graphicsCapabilities: {spatial: true, temporal: true, spatialMethods: ["metalfx", "bilinear"], temporalMethods: ["metalfx"], resolutionMultipliers: []}};
  const record = preset => ({gameId: "order", moduleId: "example", gamePath: "/Games/Order", reshade: {enabled: true, preset},
    graphics: Graphics.normalizeSettings({temporalMethod: "metalfx", spatialMethod: "bilinear"})});
  // A scene-input shader reads the renderer's depth before any geometry change.
  const scene = StoredPlan.upgradeLegacy(record("shader:native:xegtao"), options);
  assert.deepEqual(scene.effects.video.map(row => row.id), ["legacy-shader", "legacy-temporal", "legacy-spatial"]);
  // An ordinary display shader follows the scaling stages.
  const display = StoredPlan.upgradeLegacy(record("grayscale"), options);
  assert.deepEqual(display.effects.video.map(row => row.id), ["legacy-temporal", "legacy-spatial", "legacy-shader"]);
  assert.equal(StoredPlan.upgradeLegacy(display, options), display, "the upgrade is idempotent");
  assert.doesNotThrow(() => StoredPlan.upgradeLegacy({gameId: "broken", graphics: "unreadable", reshade: 7}, options), "the upgrade never throws");
});
