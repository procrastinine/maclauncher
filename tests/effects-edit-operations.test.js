const test = require("node:test"), assert = require("node:assert/strict"), {isDeepStrictEqual} = require("node:util");
const Ops = require("../src/modules/shared/effects/edit-operations.mjs"), Plan = require("../src/modules/shared/effects/plan.mjs");
const {implementationsFor, extentEditable} = require("../src/modules/shared/effects/contracts.mjs");

const freeze = value => {if (value && typeof value === "object" && !Object.isFrozen(value)) {Object.freeze(value);for (const item of Object.values(value)) freeze(item);}return value;};
const stage = direction => ({domain: "image", sizing: "stage", direction, extentEditable: true});
const upscaler = (method, extra = {}) => ({id: "upscale:" + method, kind: "upscale", label: method, group: "Resize", available: true, outputContract: stage("upscale"),
  template: {kind: "upscale", enabled: true, method, settings: {spatialMethod: method, spatialMultiplier: null}}, ...extra});
const downsampler = method => ({id: "downsample:" + method, kind: "downsample", label: method, group: "Resize", available: true, outputContract: stage("downsample"),
  template: {kind: "downsample", enabled: true, method, settings: {spatialMethod: method, spatialMultiplier: null}, extent: {relativeTo: "input", factor: .5}}});
const shader = (preset, extra = {}) => ({id: "shader:" + preset, kind: "shader", label: preset, group: "Image filters", available: true,
  template: {kind: "shader", enabled: true, shader: {enabled: true, preset, parameters: null}}, ...extra});
const fixed = scale => ({group: "Resize", outputContract: {scale, sizing: "stage", extentEditable: false}});
const CATALOG = freeze([
  upscaler("metalfx", {recommendationRank: 0}), upscaler("fsr1"), upscaler("bilinear"), downsampler("area"), downsampler("bilinear"),
  shader("filter:double", fixed(2)),
  shader("filter:target", {group: "Resize", traits: {resizeContext: "upscale"}, outputContract: {resizeContext: "upscale", extentEditable: true},
    template: {kind: "shader", enabled: true, extent: {relativeTo: "presentation", factor: 1}, shader: {enabled: true, preset: "filter:target", parameters: null}}}),
  shader("crt", {outputContract: {sizing: "preserve", preservesSize: true}}),
  {id: "neural:mlx-dlss", kind: "neural", label: "DLSS", group: "Image filters", available: true, intrinsicScale: 1, runtimeManagerId: "graphics-neural-models", modelOperation: "mlx-dlss",
    outputContract: {domain: "image", sizing: "preserve", scale: 1}, template: {kind: "neural", enabled: true, method: "mlx-dlss", settings: {modelPath: null, intensity: 1, temporal: false}}},
  {id: "upscale:realcugan", kind: "upscale", label: "Real-CUGAN", group: "Resize", available: true, intrinsicScale: 2, runtimeManagerId: "graphics-neural-models", modelOperation: "realcugan",
    outputContract: {domain: "image", sizing: "intrinsic", scale: 2, direction: "upscale"}, template: {kind: "upscale", enabled: true, method: "realcugan", settings: {modelPath: null}}},
  {id: "temporal:fsr2", kind: "temporal", label: "FSR 2", group: "Temporal", available: true, outputContract: {domain: "image", sizing: "scene-output"},
    template: {kind: "temporal", enabled: true, method: "fsr2", settings: {temporalMethod: "fsr2"}}},
  {id: "frame-generation:lsfg", kind: "frame-generation", label: "LSFG", group: "Temporal", available: true, outputContract: {domain: "timeline", sizing: "preserve"},
    template: {kind: "frame-generation", enabled: true, method: "lsfg", settings: {frameGeneration: "lsfg", frameMultiplier: 2}}}
]);
const IMPORTED = freeze([shader("filter:imported-double", fixed(2)), shader("filter:imported-look", {outputContract: {sizing: "preserve", preservesSize: true}}),
  shader("filter:imported-half", fixed(.5))]);
const choice = id => CATALOG.find(row => row.id === id);
const MODELS = {"/models/two": 2, "/models/four": 4};
// Models change a catalog row's intrinsic scale, as the editor's model-aware choice does.
const refine = (row, matched) => {
  const scale = matched?.modelOperation === "realcugan" && MODELS[row.settings?.modelPath];
  return scale ? {...matched, intrinsicScale: scale, outputContract: {...matched.outputContract, scale}} : matched;
};
function context(options = {}, catalog = CATALOG) {let next = 0;return Ops.createEditContext(catalog, {newId: () => "row-" + ++next, implementation: refine, ...options});}
const empty = (extra = {}) => freeze({schema: 2, mode: "advanced", enabled: true, video: [], ...extra});
const ids = plan => plan.video.map(row => row.id);
const helpersOf = (plan, id) => Object.fromEntries(plan.video.filter(row => row.ownedBy?.id === id).map(row => [row.ownedBy.role, row]));
// Plan.validate checks ownership too; check() reports the same rules as O1.
const valid = plan => Plan.validate(plan);
function clean(plan, ctx) {assert.deepEqual(Ops.check(plan, ctx), []);valid(plan);return plan;}

test("context lookup prefers per-row metadata, then the shared implementation, and caches per row object", () => {
  const row = {id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}};
  const metadata = {...choice("shader:crt"), id: "meta", nodeId: "look", selectionKey: require("../src/modules/shared/effects/selection-key.mjs").effectSelectionKey(row), outputContract: {scale: 2}};
  const ctx = Ops.createEditContext([...CATALOG, metadata]);
  assert.equal(ctx.implementation(row), metadata);assert.equal(ctx.type(row), "upscale");
  assert.equal(ctx.implementation({...row, id: "other"}), choice("shader:crt"));assert.equal(ctx.type({...row, id: "other"}), "image");
  assert.match(ctx.newId(), /^[0-9a-f-]{36}$/);assert.equal(ctx.library.includes(metadata), false);
  const model = {id: "m", kind: "upscale", enabled: true, method: "realcugan", settings: {modelPath: "/models/four"}}, refined = context().implementation(model);
  assert.equal(refined.intrinsicScale, 4);
});

test("Simple insertion follows the shared type order and attaches scale helpers to their owner", () => {
  const ctx = context();let plan = empty({output: {motionClarity: "beam", subframes: 2, duty: .5, brightness: 1}});
  for (const [slot, id] of [["generation", "frame-generation:lsfg"], ["upscale", "upscale:fsr1"], ["temporal", "temporal:fsr2"], ["image", "shader:crt"], ["downsample", "downsample:area"]])
    plan = clean(Ops.setSlot(plan, slot, null, choice(id), ctx), ctx);
  assert.deepEqual(plan.video.filter(row => !row.ownedBy).map(row => row.kind), ["temporal", "downsample", "shader", "upscale", "frame-generation"]);
  assert.equal(plan.output.motionClarity, "beam");
  const up = Ops.setSlot(empty({video: [{id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}}]}), "upscale", null, choice("upscale:fsr1"), ctx);
  const owner = up.video.find(row => row.kind === "upscale");
  assert.deepEqual(up.video.map(row => row.ownedBy?.role || row.kind), ["shader", "input", "upscale"]);
  assert.deepEqual(helpersOf(up, owner.id).input.extent, {relativeTo: "presentation", factor: .5});
  assert.deepEqual(up.renderResolution, {multiplier: 2, managedBy: owner.id});
  assert.equal(Ops.project(up, ctx).customOrder, false, "U4: hidden helpers never make Simple order custom");
  const filter = clean(Ops.setSlot(up, "image", null, choice("shader:crt"), ctx), ctx);
  assert.deepEqual(filter.video.map(row => row.ownedBy?.role || row.kind), ["shader", "shader", "input", "upscale"], "a new filter stays outside the scaler group");
});

test("fixed-scale owners get a bidirectional fit, and manual sizing skips helpers", () => {
  const ctx = context(), plan = clean(Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), ctx), owner = plan.video[1];
  assert.deepEqual(plan.video.map(row => row.ownedBy?.role || row.kind), ["input", "shader", "fit"]);
  assert.equal(owner.extent, undefined);const {fit} = helpersOf(plan, owner.id);
  assert.equal(fit.kind, "spatial");assert.equal(fit.method, "bilinear");assert.equal(fit.settings.spatialMultiplier, null);
  const manual = Ops.setSlot(empty({renderResolution: {height: 720}}), "upscale", null, choice("upscale:metalfx"), ctx);
  assert.equal(manual.video.length, 1);assert.deepEqual(manual.renderResolution, {height: 720});
  const reduced = Ops.setSlot(empty({video: [{id: "d", kind: "downsample", enabled: false, method: "area", settings: {}}]}), "upscale", null, choice("upscale:metalfx"), ctx);
  assert.equal(reduced.video.length, 2, "an existing manual reduction, even disabled, keeps sizing manual");assert.equal(reduced.renderResolution, undefined);
});

test("U1: Off retires owned helpers and the source request whatever the row's type; reselecting restores them", () => {
  const ctx = context();
  for (const id of ["shader:filter:double", "shader:filter:target", "upscale:metalfx", "upscale:realcugan"]) {
    const plan = clean(Ops.setSlot(empty(), "upscale", null, choice(id), ctx), ctx), owner = plan.video.find(row => !row.ownedBy);
    const off = clean(Ops.setSlot(plan, "upscale", owner.id, null, ctx), ctx);
    assert.ok(off.video.every(row => !row.enabled), id);assert.equal(off.renderResolution, undefined, id);
    assert.deepEqual(Ops.setSlot(off, "upscale", owner.id, choice(id), ctx), plan, id);
  }
  const ctxLook = context(), look = {id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "filter:double", parameters: null}};
  const saved = Ops.migrateOwnership({schema: 2, mode: "advanced", enabled: true, renderResolution: {multiplier: 2, managedBy: "look"}, video: [
    {id: "auto-scale-input-look", kind: "downsample", method: "bilinear", enabled: true, extent: {relativeTo: "presentation", factor: .5}, settings: {}}, look,
    {id: "auto-scale-fit-look", kind: "spatial", method: "bicubic", enabled: true, settings: {}}]});
  const changedType = Ops.setSlot(saved, "image", "look", null, ctxLook);
  assert.deepEqual(changedType.video.map(row => [row.id, row.enabled]), [["auto-scale-input-look", false], ["look", false], ["auto-scale-fit-look", false]]);
  assert.equal(changedType.renderResolution, undefined);
});

test("U2: removing an owner removes its helpers and source request; removing its input helper removes the request it carries", () => {
  const ctx = context(), plan = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), owner = plan.video[1];
  assert.deepEqual(clean(Ops.remove(plan, owner.id, ctx), ctx), empty());
  const {input, fit} = helpersOf(plan, owner.id), withoutInput = clean(Ops.remove(plan, input.id, ctx), ctx);
  assert.equal(withoutInput.renderResolution, undefined);assert.deepEqual(ids(withoutInput), [owner.id, fit.id]);
  assert.deepEqual(clean(Ops.remove(plan, fit.id, ctx), ctx).renderResolution, {multiplier: 2, managedBy: owner.id}, "a fit helper carries no request");
  const foreign = {...plan, renderResolution: {height: 720}, video: [{id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}}, ...plan.video]};
  assert.deepEqual(Ops.remove(foreign, "look", ctx).renderResolution, {height: 720});assert.equal(Ops.remove(plan, "missing", ctx), plan);
});

test("Clear after a Simple upscale removes the owned request and keeps a game resolution set on its own", () => {
  const ctx = context(), plan = Ops.setSlot(empty(), "upscale", null, choice("upscale:metalfx"), ctx), owner = plan.video.find(row => !row.ownedBy);
  assert.equal(plan.renderResolution.managedBy, owner.id);
  assert.deepEqual(Ops.clear(plan), empty());
  const withoutInput = clean(Ops.remove(plan, helpersOf(plan, owner.id).input.id, ctx), ctx);
  assert.equal(withoutInput.renderResolution, undefined);assert.deepEqual(Ops.clear(withoutInput), empty());
  const manual = clean(Ops.setSlot(Ops.setSource(empty(), {multiplier: 2}), "upscale", null, choice("upscale:metalfx"), ctx), ctx);
  assert.deepEqual(manual.renderResolution, {multiplier: 2});assert.ok(manual.video.every(row => !row.ownedBy), "a manual request derives no input helper");
  assert.deepEqual(Ops.clear(manual), empty({renderResolution: {multiplier: 2}}));
});

test("U3: enabling follows ownership; toggling a helper adopts it", () => {
  const ctx = context(), plan = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), owner = plan.video[1], {input, fit} = helpersOf(plan, owner.id);
  const off = clean(Ops.setEnabled(plan, owner.id, false, ctx), ctx);assert.ok(off.video.every(row => !row.enabled));assert.equal(off.renderResolution, undefined);
  assert.deepEqual(clean(Ops.setEnabled(off, owner.id, true, ctx), ctx), plan);assert.equal(Ops.setEnabled(plan, owner.id, true, ctx), plan);
  const adopted = clean(Ops.setEnabled(plan, fit.id, false, ctx), ctx);
  assert.equal(adopted.video[2].ownedBy, undefined);assert.equal(adopted.video[2].enabled, false);assert.deepEqual(adopted.renderResolution, plan.renderResolution);
  const manual = clean(Ops.setEnabled(plan, input.id, false, ctx), ctx);
  assert.equal(manual.video[0].ownedBy, undefined);assert.deepEqual(manual.renderResolution, {multiplier: 2}, "an adopted input takes the source request with it");
  const replaced = Ops.setSource(off, {height: 720}), restored = clean(Ops.setEnabled(replaced, owner.id, true, ctx), ctx);
  assert.equal(helpersOf(restored, owner.id).input, undefined, "a source chosen meanwhile replaces the owned reduction");
  assert.deepEqual(restored.renderResolution, {height: 720});assert.equal(helpersOf(restored, owner.id).fit.enabled, true);
});

test("neural defaults reduce to the processing height, fit once and leave with their owner", () => {
  const ctx = context(), plan = clean(Ops.setSlot(empty(), "image", null, choice("neural:mlx-dlss"), ctx), ctx);
  assert.deepEqual(plan.video.map(row => row.ownedBy?.role || row.kind), ["input", "neural", "fit"]);
  assert.deepEqual(plan.video[0].extent, {height: 540});assert.equal(plan.video[2].method, "metalfx");assert.equal(plan.video[1].settings.modelPath, null);
  assert.equal(plan.renderResolution, undefined);assert.ok(plan.video.every(row => row.kind !== "frame-generation"));
  const native = context({nativeVideo: true}), video = clean(Ops.setSlot(empty(), "image", null, choice("neural:mlx-dlss"), native), native);
  assert.deepEqual(video.video.map(row => row.ownedBy?.role || row.kind), ["neural", "fit"]);
  const off = clean(Ops.setSlot(plan, "image", plan.video[1].id, null, ctx), ctx);assert.ok(off.video.every(row => !row.enabled));
  const chosen = clean(Ops.setSlot(plan, "upscale", null, choice("upscale:fsr1"), ctx), ctx);
  assert.deepEqual(chosen.video.map(row => row.ownedBy?.role || row.method), ["input", "mlx-dlss", "fsr1"], "a chosen upscaler replaces the neural fit without stacking reductions");
  assert.equal(chosen.renderResolution, undefined);
});

test("replacing a row keeps its id, position and compatible settings and re-derives helpers", () => {
  const ctx = context(), look = {id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: {Strength: [.4]}}};
  let plan = Ops.setSlot(empty({video: [look], enabled: false, output: {framePacing: "adaptive", targetFps: 90, smoothCadence: true}}), "upscale", null, choice("upscale:metalfx"), ctx);
  const owner = plan.video.find(row => row.kind === "upscale");
  plan = clean(Ops.setExtent(plan, owner.id, {height: 480}, ctx), ctx);
  const next = clean(Ops.setSlot(plan, "upscale", owner.id, choice("upscale:fsr1"), ctx), ctx);
  assert.deepEqual(ids(next), ids(plan));assert.equal(next.video[0], plan.video[0]);assert.equal(next.enabled, false);assert.deepEqual(next.output, plan.output);
  assert.deepEqual(next.video[2].extent, {height: 480});assert.equal(next.video[2].method, "fsr1");
  const neural = Ops.setSlot(empty(), "image", null, choice("neural:mlx-dlss"), ctx), nr = neural.video[1];
  const replaced = clean(Ops.setSlot(neural, "image", nr.id, choice("shader:crt"), ctx), ctx);
  assert.deepEqual(ids(replaced), [nr.id]);assert.equal(replaced.video[0].shader.preset, "crt");
  const scaled = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), doubled = scaled.video[1];
  const target = clean(Ops.setSlot(scaled, "upscale", doubled.id, choice("upscale:metalfx"), ctx), ctx);
  assert.deepEqual(target.video.map(row => row.ownedBy?.role || row.method), ["input", "metalfx"], "a target-sized scaler needs no fit");
  const model = clean(Ops.setSlot(target, "upscale", doubled.id, choice("upscale:realcugan"), ctx), ctx);
  assert.deepEqual(model.video.map(row => row.ownedBy?.role || row.method), ["input", "realcugan", "fit"]);
  const image = clean(Ops.setSlot(model, "upscale", doubled.id, choice("shader:crt"), ctx), ctx);
  assert.deepEqual(image.video.map(row => row.id), [doubled.id]);assert.equal(image.renderResolution, undefined);
});

test("moving an owner carries its helpers; moving a helper adopts it", () => {
  const ctx = context(), look = {id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}};
  const plan = Ops.setSlot(empty({video: [look]}), "upscale", null, choice("shader:filter:double"), ctx), owner = plan.video.find(row => row.kind === "shader" && row.id !== "look");
  const at = plan.video.indexOf(owner), up = clean(Ops.move(plan, owner.id, at - 1, ctx), ctx);
  assert.deepEqual(up.video.map(row => row.ownedBy?.role || row.id), ["input", owner.id, "fit", "look"]);
  assert.deepEqual(ids(clean(Ops.move(up, owner.id, 3, ctx), ctx)), ids(plan));
  assert.equal(Ops.move(plan, owner.id, at, ctx), plan);assert.equal(Ops.move(up, owner.id, 0, ctx), up, "the group is already first");
  assert.deepEqual(ids(Ops.move(plan, "look", 2, ctx)), [plan.video[1].id, owner.id, "look", plan.video[3].id], "a plain row lands as a drag places it");
  const {fit} = helpersOf(plan, owner.id), moved = clean(Ops.move(plan, fit.id, 0, ctx), ctx);
  assert.equal(moved.video[0].id, fit.id);assert.equal(moved.video[0].ownedBy, undefined);
});

test("sizes: the owner's fit option keeps ownership; other helper edits adopt; type changes re-derive", () => {
  const ctx = context(), plan = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), owner = plan.video[1], {input, fit} = helpersOf(plan, owner.id);
  const fitted = clean(Ops.setExtent(plan, fit.id, {relativeTo: "presentation", factor: .75}, ctx, {asOwner: true}), ctx);
  assert.deepEqual(fitted.video[2].ownedBy, fit.ownedBy);assert.deepEqual(fitted.video[2].extent, {relativeTo: "presentation", factor: .75});assert.equal("spatialMultiplier" in fitted.video[2].settings, false);
  const off = Ops.setSlot(fitted, "upscale", owner.id, null, ctx);assert.deepEqual(Ops.setSlot(off, "upscale", owner.id, choice("shader:filter:double"), ctx), fitted);
  const edited = clean(Ops.setExtent(plan, input.id, {height: 360}, ctx), ctx);
  assert.equal(edited.video[0].ownedBy, undefined);assert.deepEqual(edited.renderResolution, {multiplier: 2});
  assert.equal(Ops.setExtent(fitted, fit.id, {relativeTo: "presentation", factor: .75}, ctx, {asOwner: true}), fitted);
  const target = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:target"), ctx), shaderOwner = target.video[1];
  const reduced = clean(Ops.setExtent(target, shaderOwner.id, {relativeTo: "input", factor: .5}, ctx), ctx);
  assert.equal(ctx.type(reduced.video[1]), "upscale");assert.equal(reduced.video.length, 2, "a size within the same type keeps helpers");
  const temporal = Ops.add(empty(), choice("temporal:fsr2"), ctx);assert.throws(() => Ops.setExtent(temporal.plan, temporal.id, {height: 480}, ctx), /no output size/);
});

test("model changes refit owned sizing only, and parameter edits keep identity when unchanged", () => {
  for (const manual of [false, true]) {
    const ctx = context(), start = Ops.setSlot(empty(manual ? {renderResolution: {height: 720}} : {}), "upscale", null, choice("upscale:realcugan"), ctx);
    const model = start.video.find(row => row.method === "realcugan"), four = clean(Ops.setSettings(start, model.id, {settings: {modelPath: "/models/four"}}, ctx), ctx);
    if (manual) {assert.deepEqual(four.renderResolution, {height: 720});assert.equal(four.video.length, 1);continue;}
    assert.deepEqual(four.renderResolution, {multiplier: 4, managedBy: model.id});assert.deepEqual(helpersOf(four, model.id).input.extent, {relativeTo: "presentation", factor: .25});
    assert.equal(helpersOf(four, model.id).input.id, helpersOf(start, model.id).input.id);
    assert.equal(Ops.setSettings(four, model.id, {settings: {modelPath: "/models/four"}}, ctx), four);
  }
  const ctx = context(), look = Ops.setSlot(empty(), "image", null, choice("shader:crt"), ctx), id = look.video[0].id;
  const tuned = clean(Ops.setSettings(look, id, {shader: {parameters: {Strength: [.5]}}}, ctx), ctx);
  assert.deepEqual(tuned.video[0].shader.parameters, {Strength: [.5]});assert.equal(Ops.setSettings(tuned, id, {shader: {parameters: {Strength: [.5]}}}, ctx), tuned);
});

test("intrinsic model fits use the bidirectional catalog peer and normalize on refit", () => {
  const ctx = context(), old = Ops.migrateOwnership({schema: 2, mode: "advanced", enabled: true, renderResolution: {multiplier: 2, managedBy: "model"}, video: [
    {id: "auto-scale-input-model", kind: "downsample", method: "bilinear", enabled: true, settings: {}, extent: {relativeTo: "presentation", factor: .5}},
    {id: "model", kind: "upscale", method: "realcugan", enabled: true, settings: {modelPath: "/models/two"}},
    {id: "auto-scale-fit-model", kind: "upscale", method: "metalfx", enabled: true, settings: {}}]});
  const refit = clean(Ops.setSettings(old, "model", {settings: {modelPath: "/models/four"}}, ctx), ctx), fit = refit.video[2];
  assert.equal(fit.kind, "spatial");assert.equal(fit.method, "bilinear");assert.equal(fit.settings.spatialMultiplier, null);assert.deepEqual(fit.ownedBy, {id: "model", role: "fit"});
  const explicit = {...old, video: old.video.map(row => row.id === "auto-scale-fit-model" ? {...row, extent: {relativeTo: "presentation", factor: .5}} : row)};
  assert.equal(Ops.setSettings(explicit, "model", {settings: {modelPath: "/models/four"}}, ctx).video[2].method, "metalfx");
});

test("add, changeMethod and placeImported follow the view and the classifier", () => {
  const ctx = context(), advanced = Ops.add(empty(), choice("upscale:metalfx"), ctx, {view: "advanced"});
  assert.deepEqual(ids(advanced.plan), [advanced.id]);assert.equal(advanced.plan.renderResolution, undefined);
  const simple = Ops.add(empty(), choice("upscale:metalfx"), ctx, {view: "simple"});assert.equal(simple.plan.video.length, 2);assert.equal(simple.plan.renderResolution.managedBy, simple.id);
  const full = empty({video: Array.from({length: 32}, (_, index) => ({id: "r" + index, kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}}))});
  assert.throws(() => Ops.add(full, choice("shader:crt"), ctx), /at most 32/);assert.throws(() => Ops.setSlot(full, "upscale", null, choice("upscale:fsr1"), ctx), /at most 32/);
  const owner = simple.plan.video[1];assert.equal(Ops.changeMethod(simple.plan, owner.id, choice("upscale:metalfx"), ctx), simple.plan);
  const fsr = clean(Ops.changeMethod(simple.plan, owner.id, choice("upscale:fsr1"), ctx), ctx);
  assert.equal(fsr.video[1].method, "fsr1");assert.equal(fsr.video[0], simple.plan.video[0]);assert.deepEqual(fsr.renderResolution, simple.plan.renderResolution);
  const area = Ops.add(empty(), choice("downsample:area"), ctx).plan, reduce = clean(Ops.changeMethod(Ops.setExtent(area, area.video[0].id, {height: 480}, ctx), area.video[0].id, choice("downsample:bilinear"), ctx), ctx);
  assert.deepEqual(reduce.video[0].extent, {height: 480});assert.equal(reduce.video[0].settings.spatialMethod, "bilinear");
  const bare = Ops.createEditContext(CATALOG, {newId: (() => {let next = 0;return () => "imp-" + ++next;})()});
  const placed = Ops.placeImported(empty(), IMPORTED, {slot: "upscale"}, bare, "simple");
  assert.deepEqual(placed.incompatible, ["filter:imported-look", "filter:imported-half"]);
  assert.deepEqual(placed.plan.video.map(row => row.ownedBy?.role || row.shader.preset), ["input", "filter:imported-double", "fit"], "a new choice is typed by its own contract");
  const appended = Ops.placeImported(empty(), [IMPORTED[1]], {}, bare, "advanced");assert.deepEqual(appended.incompatible, []);assert.equal(appended.plan.video[0].shader.preset, "filter:imported-look");
  const swapped = Ops.placeImported(placed.plan, [IMPORTED[0], IMPORTED[1]], {rowId: placed.plan.video[1].id}, bare, "advanced");
  assert.deepEqual(swapped.plan.video.map(row => row.shader?.preset || row.ownedBy.role), ["input", "filter:imported-double", "fit", "filter:imported-look"], "the same implementation is kept and the next one appended");
});

test("an Off owner's helpers follow a method change, and an implementation without sizing drops them", () => {
  const ctx = context({}, [...CATALOG, ...IMPORTED]), scaled = Ops.setSlot(empty(), "upscale", null, choice("shader:filter:double"), ctx), owner = scaled.video[1];
  const off = clean(Ops.setEnabled(scaled, owner.id, false, ctx), ctx);
  const target = clean(Ops.changeMethod(off, owner.id, choice("upscale:metalfx"), ctx), ctx);
  assert.deepEqual(target.video.map(row => [row.ownedBy?.role || row.method, row.enabled]), [["input", false], ["metalfx", false]], "a target-sized scaler needs no fit");
  assert.equal(target.renderResolution, undefined);
  assert.deepEqual(clean(Ops.setEnabled(target, owner.id, true, ctx), ctx), Ops.changeMethod(scaled, owner.id, choice("upscale:metalfx"), ctx), "enabling restores the new implementation's sizing");
  const copy = Ops.changeMethod(off, owner.id, IMPORTED[0], ctx);
  assert.equal(copy.video[0], off.video[0]);assert.equal(copy.video[2], off.video[2], "helpers derived unchanged keep identity");
  for (const replacement of [choice("shader:crt"), IMPORTED[2], choice("downsample:area")]) {
    const plain = clean(Ops.changeMethod(off, owner.id, replacement, ctx), ctx);
    assert.deepEqual(ids(plain), [owner.id], replacement.id);assert.deepEqual(ids(Ops.setEnabled(plain, owner.id, true, ctx)), [owner.id], replacement.id);
  }
  const neural = Ops.setSlot(empty(), "image", null, choice("neural:mlx-dlss"), ctx), model = neural.video[1];
  assert.deepEqual(ids(clean(Ops.changeMethod(Ops.setEnabled(neural, model.id, false, ctx), model.id, IMPORTED[2], ctx), ctx)), [model.id]);
});

test("a fixed-pixel-size shader lands in Downsample and derives no helpers", () => {
  const sized = require("../src/modules/shared/effects/plan").catalog({reshadeState: {available: true,
    presets: [{id: "fixed", label: "Fixed", traits: {outputSize: {width: 640, height: 360}}}]}}).find(row => row.id === "shader:fixed");
  const ctx = context({}, [...CATALOG, sized]);
  for (const view of ["simple", "advanced"]) {
    const {plan, id} = Ops.add(empty(), sized, ctx, {view});
    clean(plan, ctx);assert.deepEqual(ids(plan), [id], view);assert.equal(plan.renderResolution, undefined);
    assert.equal(Ops.project(plan, ctx).slots.find(slot => slot.id === "downsample").row?.id, id);
  }
  const scaler = Ops.setSlot(empty(), "upscale", null, choice("upscale:metalfx"), ctx), owner = scaler.video[1];
  const replaced = clean(Ops.changeMethod(scaler, owner.id, sized, ctx), ctx);
  assert.deepEqual(ids(replaced), [owner.id]);assert.equal(replaced.renderResolution, undefined);
});

test("an explicit size survives a shader replacing its row; the window fit stays automatic", () => {
  const requested = shader("filter:requested", {group: "Resize",
    outputContract: {domain: "image", sizing: "stage", extentEditable: true, resizeDirections: ["downsample", "upscale"]}});
  const ctx = context({}, [...CATALOG, requested]), settings = {spatialMethod: "bilinear", spatialMultiplier: 1};
  const legacy = {id: "legacy", kind: "spatial", method: "bilinear", enabled: true, settings, outputSize: {width: 640, height: 360}};
  const scaler = {id: "scaler", kind: "upscale", method: "bilinear", enabled: true, settings: {spatialMethod: "bilinear", spatialMultiplier: null}, extent: {height: 1440}};
  for (const view of ["simple", "advanced"]) {
    for (const [row, size] of [[legacy, {width: 640, height: 360}], [scaler, {height: 1440}]]) {
      const plan = freeze(empty({video: [row]})), next = clean(Ops.placeImported(plan, [requested], {rowId: row.id, slot: "upscale"}, ctx, view).plan, ctx);
      assert.deepEqual(next.video.map(value => [value.id, value.kind, value.extent]), [[row.id, "shader", size]], `${view}: the chosen size wins`);
      assert.equal(next.renderResolution, undefined, `${view}: a fixed pixel size is Downsample and derives no helpers`);
    }
    const fitted = freeze(empty({video: [{...scaler, extent: {relativeTo: "presentation", factor: 1}}]}));
    const automatic = clean(Ops.placeImported(fitted, [requested], {rowId: "scaler", slot: "upscale"}, ctx, view).plan, ctx);
    assert.deepEqual(automatic.video.find(value => value.id === "scaler").extent, {relativeTo: "presentation", factor: 1});
    assert.deepEqual(automatic.video.map(value => value.ownedBy?.role || value.id), view === "simple" ? ["input", "scaler"] : ["scaler"],
      `${view}: the window fit keeps the view's automatic sizing`);
  }
});

test("source, output, master and clear edit only their own fields", () => {
  const ctx = context(), plan = Ops.setSlot(empty({output: {toneMapping: "reinhard"}}), "upscale", null, choice("upscale:metalfx"), ctx), owner = plan.video[1];
  const manual = clean(Ops.setSource(plan, {multiplier: 3, managedBy: owner.id}), ctx);
  assert.deepEqual(manual.renderResolution, {multiplier: 3});assert.deepEqual(ids(manual), [owner.id], "the paired input leaves with the managed request");
  assert.equal(Ops.setSource(manual, {multiplier: 3}), manual);assert.equal(Ops.setSource(manual, null).renderResolution, undefined);
  const full = clean(Ops.setSource(plan, null), ctx);assert.equal(full.renderResolution, undefined);assert.deepEqual(ids(full), [owner.id]);
  const output = Ops.setOutput(plan, {toneMapping: undefined, comparison: {mode: "wipe", position: .5, gain: 1}});
  assert.deepEqual(output.output, {comparison: {mode: "wipe", position: .5, gain: 1}});assert.equal(output.video, plan.video);
  assert.equal(Ops.setOutput(plan, {toneMapping: "reinhard"}), plan);assert.equal("output" in Ops.setOutput(plan, {toneMapping: undefined}), false);
  const bypass = Ops.setMaster(plan, false);assert.deepEqual({...bypass, enabled: true}, plan);assert.equal(bypass.video, plan.video);assert.equal(Ops.setMaster(plan, true), plan);
  assert.deepEqual(Ops.clear(plan), empty());assert.deepEqual(Ops.clear({...manual, enabled: false}), empty({renderResolution: {multiplier: 3}}));const none = empty();assert.equal(Ops.clear(none), none);
  // The game's depth input keeps only values that differ from the defaults
  // and stays with the game when its effects are cleared.
  const reversed = Ops.setDepthInput(plan, {reversed: true, farPlane: 1000});
  assert.deepEqual(reversed.depthInput, {reversed: true});assert.equal(reversed.video, plan.video);assert.deepEqual(Plan.validate(reversed).depthInput, {reversed: true});
  assert.equal(Ops.setDepthInput(reversed, {reversed: true}), reversed);assert.equal("depthInput" in Ops.setDepthInput(reversed, {reversed: false}), false);
  const far = Ops.setDepthInput(reversed, {farPlane: 300});assert.deepEqual(far.depthInput, {reversed: true, farPlane: 300});
  assert.deepEqual(Ops.clear(far).depthInput, far.depthInput);
  assert.deepEqual(Ops.rebase(far, reversed, Ops.setOutput(reversed, {toneMapping: "auto"})).depthInput, far.depthInput, "another editor's depth input survives an unrelated edit");
});

test("projection hides helpers under their owner and reports custom order from visible rows", () => {
  const ctx = context(), look = {id: "look", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt", parameters: null}};
  const plan = Ops.setSlot(empty({video: [look, {...look, id: "second", shader: {...look.shader, preset: "crt"}}]}), "upscale", null, choice("upscale:fsr1"), ctx);
  const projection = Ops.project(plan, ctx), image = projection.slots.find(slot => slot.id === "image"), upscale = projection.slots.find(slot => slot.id === "upscale");
  assert.equal(projection, Ops.project(plan, ctx));assert.deepEqual(projection.slots.map(slot => slot.id), [...Ops.SIMPLE_ORDER]);
  assert.equal(image.custom, true);assert.equal(image.row, undefined);assert.equal(projection.imageRows, image.rows);
  assert.equal(upscale.row.method, "fsr1");assert.deepEqual(projection.helpers.get(upscale.row.id).map(row => row.ownedBy.role), ["input"]);
  assert.equal(projection.customOrder, false);assert.equal(Ops.project(Ops.move(plan, "look", 3, ctx), ctx).customOrder, true);
});

test("check reports each ownership invariant", () => {
  const ctx = context(), row = (id, extra = {}) => ({id, kind: "downsample", method: "bilinear", enabled: true, settings: {}, ...extra});
  const owner = {id: "up", kind: "upscale", method: "fsr1", enabled: true, settings: {}}, codes = video => Ops.check({schema: 2, mode: "advanced", enabled: true, ...video}, ctx).map(item => item.code);
  assert.deepEqual(codes({video: [row("h", {ownedBy: {id: "gone", role: "input"}})]}), ["O1"]);
  assert.deepEqual(codes({video: [row("a", {ownedBy: {id: "up", role: "input"}}), row("b", {ownedBy: {id: "up", role: "input"}}), owner]}), ["O1"]);
  assert.deepEqual(codes({video: [row("h", {ownedBy: {id: "up", role: "input"}}), {...owner, enabled: false}]}), ["O2"]);
  assert.deepEqual(codes({video: [owner], renderResolution: {multiplier: 2, managedBy: "up"}}), ["O3"]);
  assert.deepEqual(codes({video: [owner, row("h", {ownedBy: {id: "up", role: "input"}})], renderResolution: {multiplier: 2, managedBy: "up"}}), ["O4"]);
  assert.deepEqual(codes({video: [row("auto-scale-input-up"), owner]}), ["O5"]);
  assert.deepEqual(codes({video: [{...owner, method: "Bad Method"}]}), ["O7"]);
  assert.deepEqual(codes({video: [row("h", {ownedBy: {id: "up", role: "input"}}), owner], renderResolution: {multiplier: 2, managedBy: "up"}}), []);
});

const row = (id, parameters = {}) => ({id, kind: "shader", enabled: true, shader: {enabled: true, preset: "custom", parameters}});
const graph = (...video) => ({schema: 2, mode: "advanced", enabled: true, video});
test("rebase keeps independent shader parameters and enabled changes", () => {
  const base = graph(row("a", {strength: [1], exposure: [0]}), row("b"));
  const current = structuredClone(base);current.video[0].shader.parameters.strength = [2];
  const desired = structuredClone(base);desired.video[0].shader.parameters.exposure = [1];desired.video[1].enabled = false;
  const merged = Ops.rebase(current, base, desired);
  assert.deepEqual(merged.video[0].shader.parameters, {strength: [2], exposure: [1]});assert.equal(merged.video[1].enabled, false);
});
test("rebase never resurrects a row removed in another window", () => {
  const base = graph(row("a", {strength: [1]}), row("b")), desired = structuredClone(base);desired.video[0].shader.parameters.strength = [2];
  assert.deepEqual(ids(Ops.rebase(graph(row("b")), base, desired)), ["b"]);
});
test("rebase reorder and removal preserve independent new rows and settings", () => {
  const result = Ops.rebase(graph(row("a"), row("x"), row("b", {value: [3]}), row("c")), graph(row("a"), row("b"), row("c")), graph(row("b"), row("a")));
  assert.deepEqual(ids(result), ["b", "a", "x"]);assert.deepEqual(result.video[0].shader.parameters, {value: [3]});
});
test("rebase global bypass preserves independent edits and never mutates its inputs", () => {
  const base = graph(row("a")), desired = {...base, enabled: false}, current = freeze(graph(row("a", {strength: [2]}), row("new")));
  const result = Ops.rebase(current, base, desired);
  assert.equal(result.enabled, false);assert.equal(result.video.length, 2);assert.deepEqual(result.video[0].shader.parameters, {strength: [2]});
  assert.equal(result.video, current.video, "unchanged rows keep identity");assert.equal(Ops.rebase(current, current, desired), desired);
});
test("rebase: convenience sizing cannot overwrite a concurrent manual choice", () => {
  const base = graph(row("a")), current = {...base, renderResolution: {multiplier: 3}};
  assert.deepEqual(Ops.rebase(current, base, {...base, renderResolution: {multiplier: 2, managedBy: "upscale"}}).renderResolution, {multiplier: 3});
  assert.deepEqual(Ops.rebase(current, {...base, renderResolution: {multiplier: 2, managedBy: "upscale"}}, base).renderResolution, {multiplier: 3});
});
test("rebase repairs ownership after concurrent edits", () => {
  const ctx = context(), base = Ops.setSlot(empty({video: [row("a")]}), "upscale", null, choice("upscale:metalfx"), ctx), owner = base.video.find(item => item.kind === "upscale");
  const removed = Ops.remove(base, owner.id, ctx), desired = Ops.move(base, "a", 2, ctx);
  const merged = clean(Ops.rebase(removed, base, desired), ctx);assert.deepEqual(ids(merged), ["a"]);
  const enabled = Ops.setEnabled(base, owner.id, false, ctx), legacy = {...base, video: base.video.map(item => item.ownedBy ? {...item, id: "auto-scale-input-" + owner.id, ownedBy: undefined} : item)};
  const prefixed = clean(Ops.rebase(enabled, enabled, Ops.setEnabled(Ops.migrateOwnership(JSON.parse(JSON.stringify(legacy))), owner.id, false, ctx)), ctx);
  assert.deepEqual(prefixed.video[1].ownedBy, {id: owner.id, role: "input"});
});

test("operations never stringify plans for comparison", t => {
  const ctx = context(), spy = t.mock.method(JSON, "stringify");
  let plan = Ops.setSlot(empty(), "image", null, choice("neural:mlx-dlss"), ctx);
  plan = Ops.setSlot(plan, "upscale", null, choice("shader:filter:double"), ctx);
  plan = Ops.setEnabled(plan, plan.video[1].id, false, ctx);plan = Ops.move(plan, plan.video.at(-1).id, 0, ctx);
  plan = Ops.rebase(plan, plan, Ops.setOutput(plan, {toneMapping: "reinhard"}));Ops.project(plan, ctx);
  assert.equal(spy.mock.callCount(), 0);
});

// Seeded property test: random edit sequences over the synthetic catalog.
function prng(seed) {
  return () => {seed = seed + 0x6D2B79F5 | 0;let t = Math.imul(seed ^ seed >>> 15, 1 | seed);t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;return ((t ^ t >>> 14) >>> 0) / 4294967296;};
}
const pick = (random, list) => list[Math.floor(random() * list.length)];
const EXTENTS = {downsample: [{relativeTo: "input", factor: .5}, {height: 480}, {relativeTo: "presentation", factor: .5}, null],
  upscale: [{relativeTo: "presentation", factor: 1}, {relativeTo: "input", factor: 2}, {width: 1280, height: 720}, null],
  spatial: [{relativeTo: "presentation", factor: .75}, {height: 720}, null], shader: [{relativeTo: "presentation", factor: 1}, {relativeTo: "input", factor: .5}, null]};
const SOURCES = [null, {multiplier: 2}, {height: 720}, {multiplier: 1.5, method: "bilinear"}];
function operations(random, plan, ctx, history, catalog = CATALOG) {
  const rows = plan.video, visible = rows.filter(item => !item.ownedBy), projection = Ops.project(plan, ctx), any = () => rows.length ? pick(random, rows) : undefined;
  const menu = type => implementationsFor(type, catalog);
  return [
    [6, () => {
      const slot = pick(random, Ops.SIMPLE_ORDER), entry = projection.slots.find(item => item.id === slot);
      if (entry.custom && slot !== "image") return null;
      const current = slot === "image" ? pick(random, [...entry.rows, undefined]) : entry.row, selected = pick(random, menu(slot));
      return {name: "setSlot", target: current?.id, run: () => Ops.setSlot(plan, slot, current?.id ?? null, selected, ctx)};
    }],
    [3, () => {const target = visible.length && pick(random, visible);return target && {name: "off", target: target.id, run: () => Ops.setSlot(plan, ctx.type(target), target.id, null, ctx)};}],
    [3, () => {const target = any(), enabled = random() < .5;return target && {name: "setEnabled", target: target.id, run: () => Ops.setEnabled(plan, target.id, enabled, ctx)};}],
    [2, () => {const target = any();return target && {name: "remove", target: target.id, run: () => Ops.remove(plan, target.id, ctx)};}],
    [3, () => {
      const target = any();if (!target) return null;
      const from = rows.indexOf(target), to = random() < .5 ? from + (random() < .5 ? -1 : 1) : Math.floor(random() * rows.length);
      return {name: "move", target: target.id, run: () => Ops.move(plan, target.id, to, ctx)};
    }],
    [3, () => {
      const target = any(), choices = target && (target.kind === "shader" ? extentEditable(ctx.implementation(target)) ? EXTENTS.shader : null : EXTENTS[target.kind]);
      if (!choices) return null;
      const extent = pick(random, choices), asOwner = random() < .5;
      return {name: "setExtent", target: target.id, run: () => Ops.setExtent(plan, target.id, extent, ctx, {asOwner})};
    }],
    [3, () => {
      const target = any();if (!target) return null;
      const patch = target.kind === "shader" ? {shader: {parameters: {Strength: [Math.round(random() * 4) / 4]}}} : target.method === "realcugan" ? {settings: {modelPath: pick(random, ["/models/two", "/models/four", null])}} :
        {settings: {sharpness: Math.round(random() * 4)}};
      return {name: "setSettings", target: target.id, run: () => Ops.setSettings(plan, target.id, patch, ctx)};
    }],
    [2, () => {const selected = pick(random, catalog), view = random() < .5 ? "simple" : "advanced";return {name: "add", run: () => Ops.add(plan, selected, ctx, {view}).plan};}],
    [2, () => {const target = any(), selected = target && pick(random, menu(ctx.type(target)));return selected && {name: "changeMethod", target: target.id, run: () => Ops.changeMethod(plan, target.id, selected, ctx)};}],
    [2, () => {
      const choices = IMPORTED.filter(() => random() < .6), slot = random() < .5 ? pick(random, Ops.SIMPLE_ORDER) : undefined, target = random() < .5 && visible.length ? pick(random, visible) : undefined;
      const view = random() < .5 ? "simple" : "advanced";
      return {name: "placeImported", target: target?.id, run: () => Ops.placeImported(plan, choices, {...(slot ? {slot} : {}), ...(target ? {rowId: target.id} : {})}, ctx, view).plan};
    }],
    [2, () => {const source = pick(random, SOURCES), owner = plan.renderResolution?.managedBy;return {name: "setSource", target: owner, run: () => Ops.setSource(plan, source)};}],
    [2, () => {
      const target = any(), patch = pick(random, [{toneMapping: "reinhard"}, {toneMapping: undefined}, {comparison: {mode: "wipe", position: .5, gain: 1}},
        ...(target ? [{adaptiveQuality: {enabled: true, nodeId: target.id, budgetMs: 8, minScale: .5, maxScale: 1}}] : [])]);
      return {name: "setOutput", run: () => Ops.setOutput(plan, patch)};
    }],
    [1, () => {const enabled = random() < .5;return {name: "setMaster", run: () => Ops.setMaster(plan, enabled)};}],
    [.3, () => ({name: "clear", run: () => Ops.clear(plan)})],
    [1, () => {
      const base = pick(random, history), edit = choose(random, base, ctx, history, true, catalog);
      if (!edit) return null;
      let desired;try {desired = edit.run();} catch (error) {if (/at most 32/.test(error.message)) return null;throw error;}
      return {name: "rebase", detail: () => `${edit.name}\nbase ${JSON.stringify(base)}\ndesired ${JSON.stringify(desired)}`, run: () => Ops.rebase(plan, base, desired)};
    }]
  ];
}
function choose(random, plan, ctx, history, nested = false, catalog = CATALOG) {
  const options = operations(random, plan, ctx, history, catalog).filter((_, index, list) => !nested || index < list.length - 1);
  for (let attempt = 0; attempt < 20; attempt++) {
    const total = options.reduce((sum, [weight]) => sum + weight, 0);let roll = random() * total;
    const [, build] = options.find(([weight]) => (roll -= weight) < 0) || options.at(-1), operation = build();
    if (operation) return operation;
  }
  return null;
}
function normalized(plan) {
  const names = new Map(plan.video.filter(item => item.ownedBy).map(item => [item.id, `${item.ownedBy.id}:${item.ownedBy.role}`]));
  const video = plan.video.map(item => names.has(item.id) ? {...item, id: names.get(item.id)} : item);
  const quality = plan.output?.adaptiveQuality;
  return {...plan, video, ...(quality && names.has(quality.nodeId) ? {output: {...plan.output, adaptiveQuality: {...quality, nodeId: names.get(quality.nodeId)}}} : {})};
}
function related(plan, operation) {
  const values = new Set([operation.target]);
  for (const item of plan.video) if (item.ownedBy?.id === operation.target) values.add(item.id);
  return values;
}
function assertUnrelated(before, after, operation) {
  if (["clear", "rebase"].includes(operation.name)) return;
  const touched = related(before, operation), byId = new Map(after.video.map(item => [item.id, item]));
  const kept = before.video.filter(item => !touched.has(item.id) && byId.has(item.id));
  for (const item of kept) assert.equal(byId.get(item.id), item, `${operation.name} replaced unrelated row ${item.id}`);
  const keptIds = new Set(kept.map(item => item.id));
  assert.deepEqual(after.video.filter(item => keptIds.has(item.id)).map(item => item.id), kept.map(item => item.id), `${operation.name} reordered unrelated rows`);
}
function assertRoundTrip(plan, ctx, random, label) {
  const candidates = plan.video.filter(item => !item.ownedBy && item.enabled && ctx.implementation(item));
  if (!candidates.length) return;
  const target = pick(random, candidates), selected = ctx.implementation(target), slot = ctx.type(target);
  const off = Ops.setSlot(plan, slot, target.id, null, ctx), back = Ops.setSlot(off, slot, target.id, selected, ctx);
  assert.deepEqual(Ops.check(off, ctx), []);assert.deepEqual(normalized(back), normalized(plan), `${label}: Off and reselect of ${target.id} restores the chain`);
}
test("seeded edit sequences keep every ownership invariant, Off/reselect round trips and unrelated identity", () => {
  const counts = {};
  for (let sequence = 0; sequence < 500; sequence++) {
    const random = prng(0x5eed + sequence), ctx = context({nativeVideo: sequence % 7 === 0}, [...CATALOG, ...IMPORTED]);
    let plan = empty();const history = [plan];
    for (let step = 0; step < 30; step++) {
      const operation = choose(random, plan, ctx, history);if (!operation) continue;
      const before = freeze(plan);let after;
      try {after = operation.run();}
      catch (error) {if (/at most 32/.test(error.message)) continue;throw new Error(`sequence ${sequence} step ${step} ${operation.name}: ${error.stack}`);}
      counts[operation.name] = (counts[operation.name] || 0) + 1;
      const violations = Ops.check(after, ctx);
      if (violations.length) assert.fail(`sequence ${sequence} step ${step} ${operation.name}: ${JSON.stringify(violations)}\n${operation.detail?.() || ""}\ncurrent ${JSON.stringify(before)}\nresult ${JSON.stringify(after)}`);
      valid(after);
      if (isDeepStrictEqual(after, before)) assert.equal(after, before, `${operation.name} returns an unchanged plan as itself`);
      assertUnrelated(before, after, operation);
      assertRoundTrip(after, ctx, random, `sequence ${sequence} step ${step} ${operation.name}`);
      plan = after;history.push(plan);
    }
  }
  for (const name of ["setSlot", "off", "setEnabled", "remove", "move", "setExtent", "setSettings", "add", "changeMethod", "placeImported", "setSource", "setOutput", "setMaster", "clear", "rebase"])
    assert.ok(counts[name] > 100, `${name} ran ${counts[name] || 0} times`);
});

// Origin equivalence: each catalog shader duplicated as an imported
// implementation with the same geometry contract but another identity and
// origin. Lockstep sequences differ only in that identity.
const COPIES = new Map(CATALOG.filter(row => row.kind === "shader").map(row => [row.template.shader.preset, "filter:copy-" + row.template.shader.preset.replace(/^filter:/, "")]));
const COPIED = freeze(CATALOG.map(row => {
  if (row.kind !== "shader") return row;
  const preset = COPIES.get(row.template.shader.preset);
  return {...row, id: "shader:" + preset, label: "Imported " + row.label, origin: "imported", template: {...row.template, shader: {...row.template.shader, preset}}};
}));
test("imported copies of catalog shaders yield the same plans, types, helpers and source requests", () => {
  const renamed = plan => ({...plan, video: plan.video.map(item => item.kind === "shader" && COPIES.has(item.shader.preset) ? {...item, shader: {...item.shader, preset: COPIES.get(item.shader.preset)}} : item)});
  const copies = new Set(COPIES.values());let compared = 0;
  for (let sequence = 0; sequence < 120; sequence++) {
    const sides = [CATALOG, COPIED].map(catalog => ({catalog, random: prng(0xc0de + sequence), ctx: context({nativeVideo: sequence % 5 === 0}, [...catalog, ...IMPORTED]), plan: empty()}));
    for (const side of sides) side.history = [side.plan];
    for (let step = 0; step < 30; step++) {
      const results = sides.map(side => {
        const operation = choose(side.random, side.plan, side.ctx, side.history, false, side.catalog);
        if (!operation) return {name: null, plan: side.plan};
        try {return {name: operation.name, plan: operation.run()};}
        catch (error) {if (/at most 32/.test(error.message)) return {name: operation.name, plan: side.plan};throw error;}
      });
      const label = `sequence ${sequence} step ${step} ${results[0].name}`;
      assert.equal(results[1].name, results[0].name, label);
      assert.deepEqual(results[1].plan, renamed(results[0].plan), label);
      assert.deepEqual(results[1].plan.video.map(item => sides[1].ctx.type(item)), results[0].plan.video.map(item => sides[0].ctx.type(item)), label);
      sides.forEach((side, index) => {side.plan = results[index].plan;side.history.push(side.plan);});
      if (results[1].plan.video.some(item => copies.has(item.shader?.preset))) compared++;
    }
  }
  assert.ok(compared > 1000, `${compared} compared plans hold an imported copy`);
});
