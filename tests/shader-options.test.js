const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), Module = require("node:module");
const React = require("react"), {build} = require("vite");
const {react, componentHarness} = require("./helpers/renderer-component");
const Options = require("../src/modules/shared/effects/shader-options.mjs");
const {readShaderOptionsFile, register} = require("../src/modules/shared/effects/shader-options-ipc");

const fixtures = path.join(__dirname, "fixtures/shader-options");
const fixture = name => fs.readFileSync(path.join(fixtures, name), "utf8");
// The included ReShade port of RetroArch's zfast CRT shader declares the
// parameters a RetroArch preset and a ReShade preset both name. ReShade's
// compiler describes each uniform as V__<name>.
const ZFAST = path.join(__dirname, "../src/modules/shared/reshade/shader-collection/retroarch/Shaders/zfast_crt.fx");
function zfastParameters() {
  const source = fs.readFileSync(ZFAST, "utf8"), parameters = [];
  for (const [, type, name, annotations, value] of source.matchAll(/^uniform\s+(float|bool)\s+(\w+)\s*<([\s\S]*?)>\s*=\s*([^;]+);/gm)) {
    const number = key => {const match = new RegExp(`${key}\\s*=\\s*([-\\d.]+)\\s*;`).exec(annotations);return match ? Number(match[1]) : undefined;};
    parameters.push({name: `V__${name}`, label: name, type, default: [type === "bool" ? (value.trim() === "true" ? 1 : 0) : Number(value)],
      ...(number("ui_min") === undefined ? {} : {min: number("ui_min")}), ...(number("ui_max") === undefined ? {} : {max: number("ui_max")})});
  }
  return parameters;
}

test("the included zfast CRT shader declares the names the fixtures use", () => {
  assert.deepEqual(zfastParameters().map(parameter => parameter.label),
    ["FINEMASK", "BLACK_OUT_BORDER", "BLURSCALEX", "LOWLUMSCAN", "HILUMSCAN", "BRIGHTBOOST", "MASK_DARK", "MASK_FADE", "video_sizeX", "video_sizeY"]);
});

test("a RetroArch preset gives its parameter lines and leaves out passes, textures and framebuffers", () => {
  const result = Options.importShaderOptions(fixture("zfast_crt.slangp"), {parameters: zfastParameters(), effectFile: "zfast_crt.fx", source: "zfast_crt.slangp"});
  assert.deepEqual(result.values, {V__BLURSCALEX: [0.45], V__LOWLUMSCAN: [5], V__HILUMSCAN: [12], V__BRIGHTBOOST: [1.5], V__MASK_DARK: [0.3], V__MASK_FADE: [0.7]});
  assert.deepEqual(result.missing, ["CURVATURE"]);
  assert.equal(result.message, "Imported 6 options from zfast_crt.slangp; 1 not found in this shader: CURVATURE.");
});

test("a ReShade preset gives the section of the row's effect, not other effects or shortcut keys", () => {
  const result = Options.importShaderOptions(fixture("ReShadePreset.ini"), {parameters: zfastParameters(), effectFile: "zfast_crt.fx"});
  assert.deepEqual(result.values, {V__BLACK_OUT_BORDER: [1], V__BLURSCALEX: [0.45], V__BRIGHTBOOST: [1.1], V__FINEMASK: [0], V__HILUMSCAN: [12], V__LOWLUMSCAN: [5],
    V__MASK_DARK: [0.3], V__MASK_FADE: [0.7], V__video_sizeX: [256], V__video_sizeY: [224]});
  assert.deepEqual(result.missing, []);
  assert.equal(result.message, "Imported 10 options.");
  // A preset for other effects names them and changes nothing.
  assert.throws(() => Options.importShaderOptions(fixture("ReShadePreset.ini"), {parameters: zfastParameters(), effectFile: "CRTLottes.fx"}),
    {message: "These options are for CAS.fx, zfast_crt.fx, not CRTLottes.fx."});
});

test("older ReShade presets and copied lines use top-level values", () => {
  const parameters = [{name: "Strength", type: "float", default: [0.5], min: 0, max: 1}, {name: "Tint", type: "float", default: [1, 1, 1]}];
  const result = Options.importShaderOptions("Techniques=Tint@Tint.fx\nKeyTint=9,0,0,0\nstrength=0.25\nTint=0.5,0.75\n",
    {parameters, values: {Tint: [0.1, 0.2, 0.3]}, effectFile: "Tint.fx"});
  // Matching ignores case; components the text leaves out keep their current values.
  assert.deepEqual(result.values, {Strength: [0.25], Tint: [0.5, 0.75, 0.3]});
  assert.deepEqual(result.missing, []);
});

test("values follow the same rules as the edit controls", () => {
  const parameters = [{name: "Count", type: "int", default: [2], min: 1, max: 8}, {name: "Mode", type: "int", default: [0], options: [{value: 0, label: "A"}, {value: 2, label: "B"}]},
    {name: "Enabled", type: "bool", default: [0]}];
  const result = Options.importShaderOptions("Count=11.6\nMode=1\nEnabled=0.5\n", {parameters});
  assert.deepEqual(result.values, {Count: [8], Enabled: [1]});
  assert.deepEqual(result.rejected, ["Mode"]);
  assert.match(result.message, /1 with values this shader does not accept: Mode\.$/);
});

test("text without options for this shader changes nothing and says why", () => {
  const parameters = zfastParameters();
  assert.throws(() => Options.importShaderOptions("This is not a preset.\nshader0 = \"crt.slang\"\n", {parameters, effectFile: "zfast_crt.fx"}),
    {message: "No shader option values were found."});
  assert.throws(() => Options.importShaderOptions("Contrast=0.5\nSharpening=1\n", {parameters, effectFile: "zfast_crt.fx"}),
    {message: "None of these options are in this shader: Contrast, Sharpening."});
});

test("copied options use the row's native format and paste back unchanged", () => {
  const parameters = zfastParameters(), values = {V__BRIGHTBOOST: [1.2], V__FINEMASK: [0]};
  const ini = Options.formatShaderOptions({parameters, values, effectFile: "/Shaders/zfast_crt.fx"});
  assert.match(ini, /^\[zfast_crt\.fx\]\nFINEMASK=0\nBLACK_OUT_BORDER=0\n/);
  const slangp = Options.formatShaderOptions({parameters, values, effectFile: "crt.slangp"});
  assert.match(slangp, /^FINEMASK = "0"\nBLACK_OUT_BORDER = "0"\nBLURSCALEX = "0.3"\n/);
  const lines = Options.formatShaderOptions({parameters: [{name: "Tint", type: "float", default: [1, 0.5, 0]}], effectFile: "tint.glsl"});
  assert.equal(lines, "Tint=1,0.5,0\n");
  for (const [text, effectFile] of [[ini, "zfast_crt.fx"], [slangp, "crt.slangp"]]) {
    const result = Options.importShaderOptions(text, {parameters, effectFile});
    assert.equal(result.imported.length, parameters.length);
    assert.deepEqual(result.values.V__BRIGHTBOOST, [1.2]);assert.deepEqual(result.values.V__FINEMASK, [0]);
  }
  // Combined effects keep the described name where two stages share a source name.
  const stages = [{name: "V__MLStage0__Strength", type: "float", default: [1]}, {name: "V__MLStage1__Strength", type: "float", default: [0.5]},
    {name: "V__MLStage1__Glow", type: "float", default: [0.2]}];
  const combined = Options.formatShaderOptions({parameters: stages});
  assert.equal(combined, "V__MLStage0__Strength=1\nV__MLStage1__Strength=0.5\nGlow=0.2\n");
  assert.deepEqual(Options.importShaderOptions(combined, {parameters: stages}).values,
    {V__MLStage0__Strength: [1], V__MLStage1__Strength: [0.5], V__MLStage1__Glow: [0.2]});
});

test("Import options reads the chosen preset as text and cancelling reads nothing", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shader-options-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const binary = path.join(directory, "binary.ini");fs.writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
  const calls = [], replies = [{canceled: false, filePaths: [path.join(fixtures, "zfast_crt.slangp")]}, {canceled: true, filePaths: []},
    {canceled: false, filePaths: [binary]}, {canceled: false, filePaths: [path.join(directory, "missing.ini")]}];
  const dialog = {showOpenDialog: async (...args) => {calls.push(args);return replies.shift();}}, owner = {};
  const handlers = new Map(), clipboard = {text: "", readText() {return this.text;}, writeText(text) {this.text = text;}};
  register({ipcMain: {handle: (name, handler) => handlers.set(name, handler)}, dialog, clipboard, owner: () => owner});
  assert.deepEqual(await handlers.get("launcher:importShaderOptions")(), {name: "zfast_crt.slangp", text: fixture("zfast_crt.slangp")});
  assert.equal(calls[0][0], owner);
  assert.deepEqual(calls[0][1].filters, [{name: "RetroArch and ReShade presets", extensions: ["slangp", "ini"]}]);
  assert.equal(await readShaderOptionsFile({dialog}), null);
  await assert.rejects(readShaderOptionsFile({dialog}), {message: "binary.ini is not a text preset."});
  await assert.rejects(readShaderOptionsFile({dialog}), {message: "missing.ini could not be read."});
  assert.equal(await handlers.get("launcher:writeClipboardText")({}, "BRIGHTBOOST=1\n"), true);
  assert.equal(await handlers.get("launcher:readClipboardText")(), "BRIGHTBOOST=1\n");
  assert.throws(() => handlers.get("launcher:writeClipboardText")({}, 1), {message: "Choose text to copy."});
});

let ShaderParameters;
test.before(async () => {
  const result = await build({configFile: false, logLevel: "silent", build: {ssr: path.join(__dirname, "../src/renderer/src/ui/components/ShaderParameters.tsx"), write: false,
    rollupOptions: {external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: {format: "cjs", codeSplitting: false}}}});
  const compiled = new Module(path.join(__dirname, "shader-options.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);({ShaderParameters} = compiled.exports);
});
function elements(value) {return React.isValidElement(value) ? [value, ...React.Children.toArray(value.props.children).flatMap(elements)] : [];}
const text = value => typeof value === "string" ? value : React.isValidElement(value) ? React.Children.toArray(value.props.children).map(text).join("") : "";

test("the options panel imports, copies and pastes through the ordinary parameter edit", async () => {
  const writes = [], clipboard = {text: ""}, files = [{name: "zfast_crt.slangp", text: fixture("zfast_crt.slangp")}, {name: "CAS.ini", text: "[CAS.fx]\nSharpening=1\n"}];
  const transfer = {importFile: async () => files.shift() || null, readText: async () => clipboard.text, writeText: async value => {clipboard.text = value;}};
  const harness = componentHarness(ShaderParameters, {gamePath: "/Game", settings: {parameters: {V__MASK_DARK: [0.5]}}, live: false, disclosure: false, transfer,
    onChange: async (_, patch) => {writes.push(structuredClone(patch));}, loadParameters: async () => ({parameters: zfastParameters(), effectFile: "zfast_crt.fx"})});
  harness.render();await harness.settle();await harness.settle();
  // The three controls are text buttons; the folder icon means Show in Finder.
  const button = label => elements(harness.render()).find(node => node.type === "button" && text(node) === label);
  assert.deepEqual(["Import options…", "Copy options", "Paste options"].map(label => button(label)?.props.className), ["btn small", "btn small", "btn small"]);
  const status = () => elements(harness.render()).flatMap(node => node.props.role === "status" ? [text(node)] : typeof node.props.error === "string" && node.props.error ? [node.props.error] : []);
  button("Import options…").props.onClick();await harness.settle();
  assert.deepEqual(writes.at(-1).parameters, {V__MASK_DARK: [0.3], V__BLURSCALEX: [0.45], V__LOWLUMSCAN: [5], V__HILUMSCAN: [12], V__BRIGHTBOOST: [1.5], V__MASK_FADE: [0.7]});
  assert.ok(status().includes("Imported 6 options from zfast_crt.slangp; 1 not found in this shader: CURVATURE."));
  // A preset for another effect changes nothing.
  button("Import options…").props.onClick();await harness.settle();
  assert.equal(writes.length, 1);
  assert.ok(status().some(line => line.includes("These options are for CAS.fx, not zfast_crt.fx.")));
  button("Copy options").props.onClick();await harness.settle();
  assert.match(clipboard.text, /^\[zfast_crt\.fx\]\nFINEMASK=1\n[\s\S]*BRIGHTBOOST=1\.5\n/);
  clipboard.text = "HILUMSCAN = \"20.000000\"\n";
  button("Paste options").props.onClick();await harness.settle();
  assert.deepEqual(writes.at(-1).parameters.V__HILUMSCAN, [20]);
  assert.deepEqual(writes.at(-1).parameters.V__BRIGHTBOOST, [1.5]);
  harness.close();
});
