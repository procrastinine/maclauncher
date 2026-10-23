const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Scaling = require("../src/modules/video/scaling"), Catalog = require("../src/modules/video/runtime/catalog"), Video = require("../src/modules/video/main"), Manager = require("../src/modules/video/runtime/manager");
const pinned = () => Scaling.filtersFor({ version: Catalog.DEFAULT_ENTRY.version });
test("only new videos acquire a visible native default, preserving existing records and explicit Off", () => {
  const entry = { gamePath: "/Movies/clip.mp4", moduleData: { container: "mp4" } }, original = structuredClone(entry);
  const merged = Video.mergeEntry(null, entry);assert.equal(merged.graphics.spatialMethod, Scaling.DEFAULT_METHOD);assert.equal(merged.graphics.spatialMultiplier, null);
  assert.deepEqual(entry, original);assert.equal(require("../src/modules/shared/reshade/graphics-settings").DEFAULTS.spatialMethod, "off");
  const off = { ...entry, graphics: { spatialMethod: "off" } };
  assert.equal(Video.mergeEntry(off, off), off);assert.equal(Video.mergeEntry(null, off), off);
  assert.equal(Video.mergeEntry(entry, entry), entry);
  assert.equal(merged.graphics.neuralInputScale, 1, "native video retains decoded-size neural processing by default");
  assert.equal(Video.mergeEntry(null, {...entry, graphics: {neuralInputScale: null}}).graphics.neuralInputScale, null, "explicit Auto remains selected");
});
test("native filters configure original mpv for all sampling stages and strip only Simple shared duplication", async t => {
  const filters = pinned(), original = { gamePath: "/Movies/clip.mp4", graphics: { spatialMethod: Scaling.DEFAULT_METHOD, spatialMultiplier: 2, frameGeneration: "off" } };
  const before = structuredClone(original);
  for (const method of ["nearest", "bilinear", "bicubic", "libplacebo:jinc", "libplacebo:ewa_hanning", Scaling.DEFAULT_METHOD]) {
    const entry = { ...original, graphics: { ...original.graphics, spatialMethod: method } }, name = method.replace(/^libplacebo:/, "");
    const args = Video.__test.playbackArguments(entry, filters);
    assert.ok(args.includes(`--scale=${name}`));assert.ok(args.includes(`--cscale=${name}`));assert.ok(args.includes(`--dscale=${name}`));
    const shared = Scaling.sharedEntry(entry, filters);assert.equal(shared.graphics.spatialMethod, "off");assert.equal(shared.graphics.spatialMultiplier, null);
  }
  const sharedMethod = { ...original, graphics: { spatialMethod: "metalfx" } };
  assert.equal(Scaling.sharedEntry(sharedMethod, filters), sharedMethod);assert.ok(Video.__test.playbackArguments(sharedMethod, filters).includes("--scale=bilinear"));
  const advanced = { ...original, effects: { schema: 1, mode: "advanced", video: [{ id: "reduce", kind: "spatial", method: "downsample", enabled: true, settings: { spatialMultiplier: .5 } }] } };
  assert.equal(Scaling.sharedEntry(advanced, filters), advanced);assert.deepEqual(original, before);
  let warnings = 0;
  const unsupported = { ...original, graphics: {...original.graphics, spatialMethod: "libplacebo:missing_filter"} };
  const args = Video.__test.playbackArguments(unsupported, ["bilinear"], {warn() {warnings++;throw new Error("Warning sink failed");}});
  for (const name of ["scale", "cscale", "dscale"]) assert.ok(args.includes(`--${name}=bilinear`));
  assert.deepEqual(args.slice(-2), ["--", original.gamePath]);assert.equal(warnings, 1);
  assert.equal(unsupported.graphics.spatialMethod, "libplacebo:missing_filter", "fallback preserves the saved selection");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "video-scaling-")));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await Video.prepareEffectsEntry(original, { userDataDir: root, settings: {} });
  assert.equal(prepared.graphics.spatialMethod, "off");assert.deepEqual(original, before);
});
test("native scale registries stay pin-specific and installation inspection is optional and bounded", async () => {
  assert.equal(pinned().length, 39);assert.ok(pinned().includes("jinc"));assert.ok(pinned().includes("ewa_hanning"));
  assert.equal(pinned().includes("ewa_jinc"), false);
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
  assert.ok(result.graphicsInputs.nativeSpatialMethods.includes(Scaling.DEFAULT_METHOD));
  assert.equal(result.graphicsInputs.nativeSpatialMethods.includes("libplacebo:ewa_jinc"), false);
});
