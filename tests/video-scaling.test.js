const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Scaling = require("../src/modules/video/scaling"), Video = require("../src/modules/video/main"), Manager = require("../src/modules/video/runtime/manager");
const recordedFilters = ["nearest", "bilinear", "bicubic", "jinc", "ewa_hanning", "ewa_lanczossharp"];
const installedFilters = () => Scaling.filtersFor({ install: { installationMetadata: { scaleFilters: recordedFilters } } });
test("new videos record no graphics and play with the native default scaler", () => {
  const entry = { gamePath: "/Movies/clip.mp4", moduleData: { container: "mp4" } }, original = structuredClone(entry);
  const merged = Video.mergeEntry(null, entry);assert.equal(merged, entry);assert.deepEqual(entry, original);
  assert.equal(Object.hasOwn(merged, "graphics") || Object.hasOwn(merged, "reshade") || Object.hasOwn(merged, "effects"), false);
  assert.equal(Video.mergeEntry(entry, entry), entry);
  const name = Scaling.DEFAULT_METHOD.replace(/^libplacebo:/, ""), args = Video.__test.playbackArguments(merged, installedFilters());
  for (const option of ["scale", "cscale", "dscale"]) assert.ok(args.includes(`--${option}=${name}`));
});
test("the v0.4.0 upgrade keeps mpv's own scaler instead of adding a graph row", () => {
  const StoredPlan = require("../src/modules/shared/effects/stored-plan");
  const record = graphics => ({ gameId: "clip", moduleId: "video", gamePath: "/Movies/clip.mp4", graphics });
  for (const method of ["nearest", "bilinear", "bicubic", "libplacebo:jinc", "libplacebo:ewa_hanning", Scaling.DEFAULT_METHOD]) {
    const saved = record({ spatialMethod: method, spatialMultiplier: 2, frameGeneration: "off" }), before = structuredClone(saved);
    const upgraded = StoredPlan.upgradeLegacy(saved, {});
    assert.equal(upgraded.effects, null, method);assert.equal(Object.hasOwn(upgraded, "graphics"), false);assert.deepEqual(saved, before);
    assert.equal(StoredPlan.upgradeLegacy(upgraded, {}), upgraded, "a second upgrade leaves the record unchanged");
    const args = Video.__test.playbackArguments(upgraded, installedFilters()), name = Scaling.DEFAULT_METHOD.replace(/^libplacebo:/, "");
    for (const option of ["scale", "cscale", "dscale"]) assert.ok(args.includes(`--${option}=${name}`));
  }
  const shared = StoredPlan.upgradeLegacy(record({ spatialMethod: "metalfx" }), {}).effects;
  assert.deepEqual(shared.video.map(row => [row.kind, row.method, row.enabled]), [["spatial", "metalfx", true]], "a shared scaler stays a graph row");
  assert.deepEqual(Scaling.legacyGraphics({ spatialMethod: "bicubic", spatialMultiplier: 2, spatialShader: { enabled: true, preset: "crt" } }),
    { spatialMethod: "off", spatialMultiplier: 2, spatialShader: { enabled: true, preset: "crt" } }, "a scaling shader keeps its source size");
  let warnings = 0;
  const args = Video.__test.playbackArguments({ gamePath: "/Movies/clip.mp4" }, ["bilinear"], {warn() {warnings++;throw new Error("Warning sink failed");}});
  for (const name of ["scale", "cscale", "dscale"]) assert.ok(args.includes(`--${name}=bilinear`));
  assert.deepEqual(args.slice(-2), ["--", "/Movies/clip.mp4"]);assert.equal(warnings, 1);
});
test("native scale registries use recorded runtime capabilities and installation inspection is optional and bounded", async () => {
  assert.deepEqual(installedFilters(), recordedFilters);assert.ok(installedFilters().includes("jinc"));assert.ok(installedFilters().includes("ewa_hanning"));
  assert.equal(installedFilters().includes("ewa_jinc"), false);
  assert.deepEqual(Scaling.filtersFor({ version: "new-version" }), ["nearest", "bilinear", "bicubic"]);
  assert.deepEqual(Scaling.filtersFor({ version: "new-version", install: { installationMetadata: { scaleFilters: ["bilinear", "hermite"] } } }), ["bilinear", "hermite"]);
  const calls = [], execute = async (...args) => { calls.push(args);return { stdout: "Available choices for scale:\n  bilinear\n  hermite\n  ewa_hanning\n" }; };
  assert.deepEqual(await Manager.inspectScaleFilters("/Runtime/mpv", {}, { execute }), ["bilinear", "hermite", "ewa_hanning"]);
  assert.deepEqual(calls[0][1], ["--no-config", "--load-scripts=no", "--scale=help"]);assert.equal(calls[0][2].timeout, 10000);
  let warnings = 0;const logger = {warn() {warnings++;throw new Error("Warning sink failed");}};
  assert.deepEqual(await Manager.inspectScaleFilters("/Runtime/mpv", {logger}, { execute: async () => { throw Error("unavailable"); } }), []);
  assert.equal(warnings, 1);
  const controller = new AbortController(), reason = new Error("Cancelled installation");controller.abort(reason);
  await assert.rejects(Manager.inspectScaleFilters("/Runtime/mpv", { signal: controller.signal, logger }, { execute: async () => { throw Error("stopped"); } }), {name: "AbortError"});
  assert.equal(warnings, 1, "cancellation remains an error and does not invoke fallback warnings");
});
test("runtime status exposes original renderer filters and source sizing capability using local metadata only", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-scaling-status-")));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = Video.actions.runtimeStatus({}, {}, { userDataDir: root, settings: {} });
  assert.equal(result.ready, false);assert.equal(result.graphicsInputs.nativeVideo, true);assert.equal(result.graphicsInputs.sourceResolution, false);
  assert.equal(result.graphicsInputs.spatialBindingsNextLaunch, false);assert.equal(result.graphicsInputs.shaderBindingsNextLaunch, false);
  assert.equal(result.graphicsInputs.presentationHold, true, "native hold support is requested separately from the included runtime feature gate");
  assert.ok(result.graphicsInputs.nativeSpatialMethods.includes("bilinear"));
  assert.equal(result.graphicsInputs.nativeSpatialMethods.includes("libplacebo:ewa_jinc"), false);
});

test("decoded GPU host keeps native conversion stable while canonical graph resizing and master bypass change",()=>{
  const base={effects:{schema:2,mode:"advanced",enabled:true,video:[{id:"scale",kind:"upscale",enabled:true,method:"metalfx",extent:{relativeTo:"presentation",factor:1},settings:{}}]}},before=structuredClone(base),options={decodedFrameProducer:true};
  const active=Scaling.argumentsFor(base,["bilinear","hermite"],undefined,options),off=Scaling.argumentsFor({...base,effects:{...base.effects,enabled:false}},["bilinear","hermite"],undefined,options);
  assert.deepEqual(active,["--scale=bilinear","--cscale=bilinear","--dscale=bilinear"]);assert.deepEqual(off,active);assert.deepEqual(base,before);
});
