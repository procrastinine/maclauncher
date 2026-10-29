const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Filters = require("../src/modules/shared/reshade/filter-library");
const ReShade = require("../src/modules/shared/reshade");
const Live = require("../src/modules/shared/reshade/live-controls");
const Effects = require("../src/modules/shared/effects/runtime"), StoredPlan = require("../src/modules/shared/effects/stored-plan");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reshade-filter-library-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile");fs.mkdirSync(userDataDir, { mode: 0o700 });
  const create = (relative, contents = "// Original local filter\n") => {
    const file = path.join(root, relative);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, contents);return file;
  };
  const metadata = path.join(userDataDir, "graphics/reshade-filters.json");
  return { root, userDataDir, create, metadata };
}
test("imports persist only private references, preserve full filenames and deduplicate real paths offline", t => {
  const f = fixture(t);t.mock.method(globalThis, "fetch", () => assert.fail("Local filters never fetch"));
  assert.deepEqual(Filters.list(f.userDataDir), []);assert.deepEqual(fs.readdirSync(f.userDataDir), []);
  const files = [f.create("A/Filter.fx"), f.create("B/filter.FX"), f.create("Else/B/Filter.fx")];
  const rows = Filters.importFiles(f.userDataDir, files);
  assert.deepEqual(rows.map(row => row.name), ["Filter.fx", "filter.FX (B)", "Filter.fx (B) 2"]);
  assert.ok(rows.every(row => row.available && Filters.isFilterId("filter:" + row.id)));
  const alias = path.join(f.root, "Alias.fx");fs.symlinkSync(files[0], alias);
  assert.deepEqual(Filters.importFiles(f.userDataDir, [alias, files[0]]), rows);
  assert.deepEqual(Filters.list(f.userDataDir), rows);
  const saved = JSON.parse(fs.readFileSync(f.metadata));
  assert.equal(saved.schema, 1);
  assert.deepEqual(saved.filters.map(({ analysis, ...row }) => row), rows.map(({ id, name, path }) => ({ id, name, path })));
  assert.ok(saved.filters.every(row => row.analysis?.sourceRevision && row.analysis?.traits), "cached recognition metadata is retained without copying shader sources");
  assert.deepEqual(fs.readdirSync(path.dirname(f.metadata)), ["reshade-filters.json"]);
  assert.equal(fs.statSync(f.metadata).mode & 0o777, 0o600);
  const before = fs.readFileSync(f.metadata, "utf8");
  assert.deepEqual(Filters.importFiles(f.userDataDir, null), rows);
  assert.deepEqual(Filters.importFiles(f.userDataDir, []), rows);
  assert.equal(fs.readFileSync(f.metadata, "utf8"), before);
  assert.ok(files.every(file => fs.readFileSync(file, "utf8") === "// Original local filter\n"));
});
test("older shader trait metadata refreshes from bounded local source once without rewriting library status", t => {
  const f = fixture(t), file = f.create("Network.hook", "//!DESC Example CNN x2\n//!HOOK MAIN\n//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >\nvec4 hook(){return vec4(1);}"), stat = fs.statSync(file);
  const id = crypto.randomUUID();fs.mkdirSync(path.dirname(f.metadata), { recursive: true });
  fs.writeFileSync(f.metadata, JSON.stringify({ schema: 1, filters: [{ id, name: "Network", path: file,
    analysis: { sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs, traits: { category: "effects", outputScale: { x: 2, y: 2 } } } }] }));
  const originalMetadata = fs.readFileSync(f.metadata, "utf8"), open = fs.openSync;let sourceReads = 0;
  t.mock.method(fs, "openSync", (...args) => { if (args[0] === file) sourceReads++;return open(...args); });
  const first = Filters.list(f.userDataDir)[0];
  assert.equal(first.traits.conditionalGeometry, true);assert.equal(first.traits.outputScale, undefined);assert.equal(first.group, "Imported upscalers");
  assert.deepEqual(Filters.list(f.userDataDir)[0], first);assert.equal(sourceReads, 1);
  assert.equal(fs.readFileSync(f.metadata, "utf8"), originalMetadata);
  Filters.importFiles(f.userDataDir, [file]);
  assert.equal(JSON.parse(fs.readFileSync(f.metadata, "utf8")).filters[0].analysis.parserVersion, require("../src/modules/shared/reshade/shader-traits").VERSION);
});
test("live recognition errors agree in library and inspector rows and recover without rewriting registrations",t=>{
  const f=fixture(t);t.mock.method(globalThis,"fetch",()=>assert.fail("Source status remains offline"));
  const descriptor=JSON.stringify({schema:1,method:"local-laplacian"}),cube="LUT_1D_SIZE 2\n0 0 0\n1 1 1\n";
  const files=[f.create("Filter.mclfilter",descriptor),f.create("Grade.cube",cube)],originals=Filters.importFiles(f.userDataDir,files);
  assert.ok(originals.every(row=>row.available));const saved=fs.readFileSync(f.metadata,"utf8");
  fs.writeFileSync(files[0],JSON.stringify({schema:1,method:"unavailable-algorithm"}));fs.writeFileSync(files[1],"LUT_1D_SIZE 2\n0 0 0\n");
  const broken=Filters.list(f.userDataDir),state=ReShade.getState({userDataDir:f.userDataDir,platform:"linux",root:"/missing"});
  assert.match(broken[0].reason,/supported compiled image algorithm/);assert.match(broken[1].reason,/entry count/);
  for(let index=0;index<broken.length;index++){
    const row=broken[index],preset=state.presets.find(item=>item.id==="filter:"+row.id);
    assert.equal(row.available,false);assert.equal(preset.available,false);assert.equal(preset.reason,row.reason);
    assert.equal(row.id,originals[index].id);assert.equal(row.path,files[index]);assert.notEqual(row.sourceRevision,originals[index].sourceRevision);
  }
  fs.writeFileSync(files[0],descriptor);fs.writeFileSync(files[1],cube);
  const restored=Filters.list(f.userDataDir);assert.ok(restored.every(row=>row.available&&!row.reason));
  assert.deepEqual(restored.map(row=>[row.id,row.path]),originals.map(row=>[row.id,row.path]));
  assert.equal(fs.readFileSync(f.metadata,"utf8"),saved,"descriptive status does not persist metadata or rewrite source");
});
test("name/path edits remain stable, reject explicit duplicates and restore filename defaults", t => {
  const f = fixture(t), first = f.create("A/Tone.fx"), second = f.create("B/Colour.fx"), replacement = f.create("C/New.fx");
  const [filter, other] = Filters.importFiles(f.userDataDir, [first, second]);
  let rows = Filters.update(f.userDataDir, filter.id, { name: " Warm tone " });
  assert.equal(rows[0].name, "Warm tone");assert.equal(rows[0].id, filter.id);
  assert.throws(() => Filters.update(f.userDataDir, filter.id, { name: "COLOUR.FX" }), /already exists.*different name/);
  assert.throws(() => Filters.update(f.userDataDir, filter.id, { path: second }), /already in the filter library/);
  rows = Filters.update(f.userDataDir, filter.id, { path: replacement });
  assert.equal(rows[0].id, filter.id);assert.equal(rows[0].name, "Warm tone");assert.equal(rows[0].path, replacement);
  assert.equal(Filters.update(f.userDataDir, filter.id, { name: " " })[0].name, "New.fx");
  fs.unlinkSync(replacement);
  rows = Filters.update(f.userDataDir, filter.id, { name: "Missing local filter" });
  assert.equal(rows[0].available, false);assert.match(rows[0].reason, /not found/);
  assert.equal(rows[1].id, other.id);
  assert.throws(() => Filters.update(f.userDataDir, filter.id, { name: "Bad\nname" }), /control characters/);
  assert.throws(() => Filters.update(f.userDataDir, filter.id, { injected: true }), /only its name/);
});
test("missing or removed filters stay explicit choices and removal never deletes original files", t => {
  const f = fixture(t), file = f.create("Filter.fx"), [filter] = Filters.importFiles(f.userDataDir, [file]);
  const preset = "filter:" + filter.id;
  assert.equal(ReShade.normalizeSettings({ enabled: true, preset }).preset, preset);
  let state = ReShade.getState({ userDataDir: f.userDataDir, platform: "linux", root: "/missing" });
  assert.equal(state.available, false);assert.equal(state.filters[0].id, filter.id);
  assert.equal(state.presets.find(row => row.id === preset).installed, true);
  fs.unlinkSync(file);state = ReShade.getState({ userDataDir: f.userDataDir, platform: "linux" });
  assert.equal(state.filters[0].available, false);assert.equal(state.presets.find(row => row.id === preset).available, false);
  assert.throws(() => Filters.resolve(f.userDataDir, preset), /not found.*Update its path/);
  fs.writeFileSync(file, "// Restored original\n");
  assert.deepEqual(Filters.remove(f.userDataDir, filter.id), []);
  assert.equal(fs.readFileSync(file, "utf8"), "// Restored original\n");
  assert.equal(ReShade.updateSettings({ enabled: true, preset }, { enabled: false }).preset, preset);
  assert.throws(() => Filters.resolve(f.userDataDir, preset), /not found in the library/);
});
test("validation and corrupt metadata never replace a prior registration or copy source files", t => {
  const f = fixture(t), file = f.create("One.fx"), second = f.create("Second.fx");
  Filters.importFiles(f.userDataDir, [file]);const before = fs.readFileSync(f.metadata, "utf8");
  assert.throws(() => Filters.importFiles(f.userDataDir, [second, path.join(f.root, "missing.fx")]), /not found/);
  const oversized = f.create("Large.fx");fs.truncateSync(oversized, Filters.LIMITS.file + 1);
  assert.throws(() => Filters.importFiles(f.userDataDir, [oversized]), /8 MiB/);
  const directory = path.join(f.root, "Folder.fx");fs.mkdirSync(directory);
  assert.throws(() => Filters.importFiles(f.userDataDir, [directory]), /instead of a folder/);
  assert.throws(() => Filters.importFiles(f.userDataDir, ["relative.fx"]), /absolute path/);
  assert.throws(() => Filters.importFiles(f.userDataDir, Array(2)), /existing shader or filter.*absolute path/);
  assert.equal(fs.readFileSync(f.metadata, "utf8"), before);
  fs.writeFileSync(f.metadata, "{broken");
  assert.throws(() => Filters.importFiles(f.userDataDir, [second]), /could not be read/);
  const state = ReShade.getState({ userDataDir: f.userDataDir, platform: "linux" });
  assert.deepEqual(state.filters, []);assert.match(state.filtersError, /could not be read/);
  assert.equal(fs.readFileSync(f.metadata, "utf8"), "{broken");
});
test("registered source identity ignores rename but invalidates path replacements and live packets", t => {
  const f = fixture(t), first = f.create("One.fx"), second = f.create("Two.fx"), [filter] = Filters.importFiles(f.userDataDir, [first]);
  const entry = { gameId: "identity", reshade: { enabled: true, preset: "filter:" + filter.id, parameters: { Amount: [0.5] } } };
  const key = Live.effectKey(entry.reshade, f.userDataDir);
  Filters.update(f.userDataDir, filter.id, { name: "Local tone" });
  assert.equal(Live.effectKey(entry.reshade, f.userDataDir), key);
  assert.deepEqual(ReShade.updateSettings(entry.reshade, { enabled: false }).parameters, { Amount: [0.5] });
  Filters.update(f.userDataDir, filter.id, { path: second });
  const updated = Live.effectKey(entry.reshade, f.userDataDir);assert.notEqual(updated, key);
  const controls = Live.write(entry, f.userDataDir, { create: true });
  assert.equal(fs.readFileSync(controls).toString("ascii", 24, 88), updated);
  assert.equal(Filters.isFilterId("filter:../outside"), false);
  assert.equal(Filters.isFilterId("filter:" + crypto.randomUUID()), true);
});
test("registered shader replacement invalidates live identity even when file size and modification time are preserved", t => {
  const f = fixture(t), shader = f.create("Stable.fx", "// first\n"), timestamp = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(shader, timestamp, timestamp);
  const [filter] = Filters.importFiles(f.userDataDir, [shader]);
  const settings = {enabled: true, preset: "filter:" + filter.id}, before = Live.effectKey(settings, f.userDataDir);
  const replacement = f.create("Replacement.fx", "// other\n");fs.utimesSync(replacement, timestamp, timestamp);fs.renameSync(replacement, shader);
  assert.notEqual(Live.effectKey(settings, f.userDataDir), before);
});
test("RetroArch formats keep stable registrations and resolve the canonical preset directory offline", t => {
  const f = fixture(t);t.mock.method(globalThis, "fetch", () => assert.fail("Local shader imports never fetch"));
  const fx = f.create("Tone.fx"), preset = f.create("Retro/Shaders/CRT.slangp", 'shaders = 1\nshader0 = "passes/crt.slang"\n');
  const shader = f.create("Retro/Shaders/passes/crt.slang", "#version 450\n");
  const glsl = f.create("MPV/Film.glsl", "//!HOOK MAIN\n//!BIND HOOKED\n"), hook = f.create("MPV/Blur.hook", "//!HOOK MAIN\n");
  const rows = Filters.importFiles(f.userDataDir, [fx, preset, shader, glsl, hook]);
  assert.deepEqual(Filters.SUPPORTED_EXTENSIONS, ["fx", "slangp", "slang", "glsl", "hook", "cube", "plfilter", "fs", "isf", "hlsl", "mclfilter"]);
  assert.deepEqual(rows.map(row => row.format), ["fx", "slangp", "slang", "libplacebo", "libplacebo"]);
  const alias = path.join(f.root, "Alias.fx");fs.symlinkSync(preset, alias);
  assert.equal(Filters.formatForPath(alias), "slangp", "canonical source controls the rendering format");
  assert.equal(Filters.importFiles(f.userDataDir, [alias]).length, 5);
  const resolved = Filters.resolve(f.userDataDir, "filter:" + rows[1].id);
  assert.equal(resolved.file, preset);assert.equal(resolved.format, "slangp");
  assert.equal(resolved.includePaths[0], path.dirname(preset));
  assert.equal(Filters.resolve(f.userDataDir, "filter:" + rows[3].id).format, "libplacebo");
  const replaced = Filters.update(f.userDataDir, rows[0].id, { path: f.create("Other.slang") });
  assert.equal(replaced[0].id, rows[0].id);assert.equal(replaced[0].format, "slang");
  assert.equal(JSON.parse(fs.readFileSync(f.metadata)).filters[0].format, undefined, "format is derived rather than trusted metadata");
});
test("legacy or disguised unsupported shader formats are rejected without changing registrations", t => {
  const f = fixture(t), file = f.create("Keep.fx");Filters.importFiles(f.userDataDir, [file]);
  const before = fs.readFileSync(f.metadata, "utf8");
  for (const extension of ["glslp", "cgp", "cgps", "dll"]) {
    assert.throws(() => Filters.importFiles(f.userDataDir, [f.create("Unsupported." + extension)]), /existing shader or filter.*absolute path/);
  }
  const unsupported = f.create("Unsupported.txt"), disguised = path.join(f.root, "Disguised.fx");fs.symlinkSync(unsupported, disguised);
  assert.equal(Filters.formatForPath(disguised), null);
  assert.throws(() => Filters.importFiles(f.userDataDir, [disguised]), /Choose a ReShade/);
  assert.equal(fs.readFileSync(f.metadata, "utf8"), before);
  fs.unlinkSync(disguised);fs.symlinkSync(file, disguised);
  const [row] = Filters.list(f.userDataDir), key = Filters.identity(f.userDataDir, "filter:" + row.id);
  assert.deepEqual(Filters.remove(f.userDataDir, row.id), []);
  assert.ok(fs.existsSync(file));assert.equal(key[2], "fx");
});
test("ordinary preparation, parameters and live snapshots resolve the registered original source", { skip: process.platform !== "darwin" }, async t => {
  const runtime = ReShade.runtimeRoot();
  if (!fs.existsSync(path.join(runtime, "fx-compile"))) return t.skip("Requires the included macOS ReShade compiler");
  const f = fixture(t), source = `#include "ReShade.fxh"
uniform bool Enabled < ui_label = "Apply tone"; ui_tooltip = "Enable the colour adjustment."; > = true;
uniform int Mode < ui_label = "Tone mode"; ui_min = 0; ui_max = 4; ui_step = 1; > = 2;
uniform float3 Tint < ui_label = "Colour balance"; ui_tooltip = "Independent colour components."; ui_min = 0.0; ui_max = 2.0; ui_step = 0.125; > = float3(0.25, 0.5, 0.75);
uniform float Amount < ui_label = "Blend amount"; ui_min = 0.0; ui_max = 1.0; ui_step = 0.0625; > = 0.5;
float4 LocalPS(float4 p:SV_Position,float2 uv:TEXCOORD):SV_Target { return Enabled ? float4(Tint * Amount * (float(Mode) + 1.0), 1.0) : float4(uv, 0.0, 1.0); }
technique LocalFilter { pass { VertexShader=PostProcessVS; PixelShader=LocalPS; } }
`;
  const first = f.create("Local Filters/One.fx", source), second = f.create("Other/Two.fx", source.replace("= 0.5;", "= 0.75;"));
  const [filter] = Filters.importFiles(f.userDataDir, [first]), preset = "filter:" + filter.id;
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games")), false, "import performs no shader preparation");
  const entry = { gameId: "registered", reshade: { enabled: true, preset } };
  const env = await ReShade.prepare(entry, { userDataDir: f.userDataDir, root: runtime, graphicsHost: "window", verify: () => true });
  const document = JSON.parse(fs.readFileSync(env.RESHADE_EFFECT_PLAN));
  assert.equal(document.nodes[0].enabled, true);assert.equal(document.nodes[0].kind, "shader");
  assert.ok(fs.statSync(document.nodes[0].file).isFile());
  assert.match(fs.readFileSync(document.nodes[0].file, "utf8"), /LocalPS/);
  assert.equal(ReShade.resolveShaderSelection(entry, {userDataDir:f.userDataDir,root:runtime}).file, first);
  assert.equal(fs.readFileSync(first, "utf8"), source);
  const parameters = await ReShade.describeParameters(entry, { userDataDir: f.userDataDir, root: runtime });
  assert.equal(parameters.key, Live.effectKey(entry.reshade, f.userDataDir));
  assert.deepEqual(parameters.parameters, [
    { name: "V__Enabled", label: "Apply tone", type: "bool", default: [1], description: "Enable the colour adjustment." },
    { name: "V__Mode", label: "Tone mode", type: "int", default: [2], min: 0, max: 4, step: 1 },
    { name: "V__Tint", label: "Colour balance", type: "float", default: [0.25, 0.5, 0.75], description: "Independent colour components.", min: 0, max: 2, step: 0.125 },
    { name: "V__Amount", label: "Blend amount", type: "float", default: [0.5], min: 0, max: 1, step: 0.0625 }
  ]);
  const LiveEffect = require("../src/modules/shared/reshade/live-effect"), { promisify } = require("node:util");
  const options = { userDataDir: f.userDataDir, root: runtime, execute: promisify(require("node:child_process").execFile) };
  const directory = await LiveEffect.prepare(entry, options), selectionFile = path.join(path.dirname(directory), "live-selection.json");
  const original = JSON.parse(fs.readFileSync(selectionFile));
  assert.equal(original.key, parameters.key);
  const values = { V__Enabled: [0], V__Mode: [3], V__Tint: [0.125, 1, 1.5], V__Amount: [0.75] };
  const configured = { ...entry, reshade: ReShade.updateSettings(entry.reshade, { parameters: values }) };
  values.V__Tint[0] = 2;
  assert.deepEqual(configured.reshade.parameters.V__Tint, [0.125, 1, 1.5], "saved settings own their parameter values");
  assert.deepEqual(ReShade.updateSettings(configured.reshade, { enabled: false }).parameters, configured.reshade.parameters);
  // Parameter edits publish the upgraded plan through ordered preparation.
  const prepare = async selected => (await Effects.prepare(StoredPlan.upgradeLegacy(selected, options),
    { ...options, graphicsHost: "window", verify: () => true })).document.nodes[0];
  const edited = await prepare(configured);
  assert.deepEqual(edited.parameters, configured.reshade.parameters, "prepared rows preserve boolean, integer and vector values");
  assert.equal(edited.file, document.nodes[0].file, "parameter changes reuse the prepared effect");
  const reset = await prepare({ ...configured, reshade: ReShade.updateSettings(configured.reshade, { parameters: null }) });
  assert.deepEqual(reset.parameters, {}, "reset selects original shader defaults");
  assert.equal(reset.file, document.nodes[0].file);
  assert.deepEqual(JSON.parse(fs.readFileSync(selectionFile)), original);
  assert.equal(fs.readFileSync(first, "utf8"), source);
  Filters.update(f.userDataDir, filter.id, { path: second });
  await LiveEffect.prepare(entry, options);
  const replaced = JSON.parse(fs.readFileSync(selectionFile));assert.notEqual(replaced.key, original.key);assert.notEqual(replaced.revision, original.revision);
  assert.ok(fs.existsSync(path.join(directory, original.revision, "effect.prepared.fx")), "the prior immutable snapshot survives replacement");
  fs.unlinkSync(second);
  await assert.rejects(LiveEffect.prepare(entry, options), /not found/);
  assert.deepEqual(JSON.parse(fs.readFileSync(selectionFile)), replaced);
  assert.equal(ReShade.normalizeSettings(entry.reshade).preset, preset);
});
