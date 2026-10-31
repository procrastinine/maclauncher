const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const Graphics = require("../src/modules/shared/reshade/graphics-settings");
const Plan = require("../src/modules/shared/effects/plan");

test("the static-content option of a generation row defaults on and round-trips through settings and plans", () => {
  assert.equal(Graphics.DEFAULTS.keepStaticContent, true);
  assert.equal(Graphics.normalizeSettings({}).keepStaticContent, true);
  assert.equal(Graphics.normalizeSettings({keepStaticContent: "no"}).keepStaticContent, true);
  assert.equal(Graphics.updateStageSettings({}, {frameGeneration: "lsfg", keepStaticContent: false}).keepStaticContent, false);
  assert.throws(() => Graphics.updateSettings({}, {keepStaticContent: 0}), /supported graphics settings/);
  const lsfg = Plan.validate({schema: 2, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {keepStaticContent: false}}]});
  assert.equal(lsfg.video[0].settings.keepStaticContent, false);
  assert.equal(Plan.validate({schema: 2, mode: "advanced", video: [{id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {}}]}).video[0].settings.keepStaticContent, true);
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
  assert.match(fs.readFileSync(path.join(__dirname, "../scripts/stage-reshade.mjs"), "utf8"), /generationStaticContentAPI===1&&!symbols\.includes\("ImagePairAnalysis14blendAvailable"\)/);
});
