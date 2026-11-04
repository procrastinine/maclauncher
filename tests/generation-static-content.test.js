const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const Plan = require("../src/modules/shared/effects/plan");

test("G8: game generation defaults static-content off and preserves explicit choices", () => {
  assert.equal(Graphics.DEFAULTS.keepStaticContent, false);
  assert.equal(Graphics.normalizeSettings({}).keepStaticContent, false);
  assert.equal(Graphics.normalizeSettings({keepStaticContent: "no"}).keepStaticContent, false);
  assert.equal(Graphics.updateStageSettings({}, {frameGeneration: "lsfg", keepStaticContent: true}).keepStaticContent, true);
  assert.throws(() => Graphics.updateSettings({}, {keepStaticContent: 0}), /supported graphics settings/);
  const lsfg = Plan.validate({schema: 2, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {keepStaticContent: false}}]});
  assert.equal(lsfg.video[0].settings.keepStaticContent, false);
  assert.equal(Plan.validate({schema: 2, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {}}]}).video[0].settings.keepStaticContent, false);
  // Neural image-pair providers keep the shared schedule option beside their model settings.
  const rife = Plan.catalog({neuralProvider: {supportedMethods: ["rife"]}}).find(row => row.template.method === "rife");
  assert.equal(rife.inputContract.domain, "image-pair");
  const neural = Plan.validate({schema: 2, mode: "advanced", video: [{...rife.template, id: "rife", settings: {...rife.template.settings, keepStaticContent: false}}]});
  assert.equal(neural.video[0].settings.keepStaticContent, false);
});

test("the static-content row control appears only for packages that declare blend-back", () => {
  const features = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/features.json"), "utf8"));
  assert.equal(features.graphics.generationStaticContentAPI, 1);
  const controls = fs.readFileSync(path.join(__dirname, "../src/renderer/src/ui/components/EffectRowControls.tsx"), "utf8");
  assert.match(controls, /staticContent && choice\?\.inputContract\?\.domain === "image-pair"/);
  assert.match(fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/graphics-settings.js"), "utf8"), /staticContent:graphics\?\.generationStaticContentAPI===1/);
});

test("G8: window stacks explicitly opt into static-content without changing a saved false choice", t => {
  const os = require("node:os"), Stacks = require("../src/modules/shared/effects/application-stacks"), Actions = require("../src/modules/window/app-actions");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "window-static-content-"));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const row = settings => ({id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings});
  let pid = 77;
  // Each case uses its own running app: a target that already has window graphics refuses a second entry.
  for (const [settings, expected] of [[{}, true], [{keepStaticContent: false}, false], [{keepStaticContent: true}, true]]) {
    const file = Stacks.location(root);fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({schema: 1, stacks: {"bundle:com.example.window": {effects: {schema: 2, mode: "advanced", video: [row(settings)]}}}}));
    const entry = Actions.applyGraphics.createEntry({kind: "application", pid: pid++, name: "Window", bundleIdentifier: "com.example.window"}, {userDataDir: root});
    assert.equal(entry.effects.video[0].settings.keepStaticContent, expected);
    assert.equal(Plan.validate({schema: 2, mode: "advanced", video: [row({})]}).video[0].settings.keepStaticContent, false);
  }
  const inputs = require("../src/modules/window/main").resolveGraphicsInputs({});
  const defaults = graphicsInputs => Plan.catalog({graphicsInputs, neuralProvider: {supportedMethods: ["rife"]}}).filter(row => row.kind === "frame-generation");
  for (const row of defaults(inputs)) assert.equal(row.template.settings.keepStaticContent, true, row.id);
  for (const row of defaults(null)) assert.equal(Plan.validate({schema: 2, mode: "advanced", video: [{...row.template, id: "fg"}]}).video[0].settings.keepStaticContent, false, row.id);
  const native = name => fs.readFileSync(path.join(__dirname, "../src/modules/shared/reshade/native", name), "utf8");
  assert.match(native("effects-execution.hpp"), /keepStaticContent=false/);
  assert.match(native("effects-execution.mm"), /boolean\("keepStaticContent",false\)/);
});
