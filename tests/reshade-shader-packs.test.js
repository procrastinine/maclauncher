const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Packs = require("../src/modules/shared/reshade/shader-packs");
const ReShade = require("../src/modules/shared/reshade");
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "included-shaders-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const features = { sourceTextures: true, smaa: true };
test("included shaders are available offline without a runtime manager or user-data installation", t => {
  const userDataDir = directory(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("Included shaders never fetch"));
  const managers = require("../src/modules/registry").listSharedRuntimeManagers();
  assert.equal(managers.some(item => item.id === "reshade-shaders"), false);
  const rows = Packs.listEffects(userDataDir, features);
  const fx = rows.filter(row => row.format === "fx");
  assert.equal(fx.length, 10);assert.ok(fx.every(row => row.available && row.bundled));
  assert.deepEqual(new Set(fx.map(row => row.group)), new Set(["SweetFX", "RetroArch CRT", "Accessibility"]));
  assert.deepEqual(fs.readdirSync(userDataDir), []);
  assert.equal(Packs.install, undefined);assert.equal(Packs.uninstall, undefined);
  for (const row of fx) {
    const selected = Packs.resolveEffect(userDataDir, row.id, features);
    assert.ok(fs.statSync(selected.file).isFile());
    assert.ok(selected.file.includes(path.join("reshade", "shader-collection")));
  }
});
test("CRT Royale retains its complete original source closure and license notices", () => {
  const crypto = require("node:crypto"), selected = Packs.resolveEffect(null, "shader:crt-royale:royale", features);
  const root = path.dirname(path.dirname(selected.file)), inventory = JSON.parse(fs.readFileSync(path.join(root, "source-files.json")));
  assert.equal(inventory.revision, Packs.lookup("shader:crt-royale:royale").pack.revision);
  assert.deepEqual(selected.texturePaths, []);
  assert.ok(inventory.files.some(file => file.path === "LICENSE.TXT"));
  assert.ok(inventory.files.some(file => file.path === "Shaders/crt-royale/lib/bind-shader-params.fxh"));
  for (const file of inventory.files) {
    const bytes = fs.readFileSync(path.join(root, file.path)); assert.equal(bytes.length, file.size);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  assert.match(fs.readFileSync(selected.file, "utf8"), /either version 2 of the License, or any later version/);
  assert.match(fs.readFileSync(path.join(root, "Shaders/crt-royale/lib/blur-functions.fxh"), "utf8"), /MIT LICENSE/);
});
test("saved included pack IDs migrate to stable shader IDs without losing parameters", () => {
  const legacy = "pack:sweetfx:93ddf39b357f:tonemap", parameters = { Exposure: [1] };
  const current = { enabled: true, preset: legacy, parameters };
  assert.equal(ReShade.normalizeSettings(current).preset, "shader:sweetfx:tonemap");
  assert.equal(Packs.lookup(legacy).id, "shader:sweetfx:tonemap");
  assert.deepEqual(ReShade.updateSettings(current, { enabled: false }).parameters, parameters);
  assert.deepEqual(ReShade.updateSettings(current, { preset: "shader:sweetfx:tonemap" }).parameters, parameters);
  assert.equal(ReShade.updateSettings(current, { preset: "shader:sweetfx:curves" }).parameters, undefined);
  assert.throws(() => ReShade.updateSettings({}, { preset: "pack:sweetfx:../other:tonemap" }), /supported/);
  assert.throws(() => Packs.resolveEffect(null, "shader:sweetfx:../Tonemap", features), /Unknown/);
});
test("qUINT selections, including earlier local copies, use the managed qUINT collection", t => {
  const userDataDir = directory(t), Managed = require("../src/modules/shared/reshade/managed-shaders");
  const legacy = "pack:quint:old-local-revision:bloom", current = "shader:managed-quint:8973665f7db55018";
  assert.equal(Packs.lookup(legacy), null);assert.equal(Packs.lookup("shader:quint:bloom"), null);
  assert.equal(ReShade.normalizeSettings({ enabled: true, preset: legacy }).preset, current);
  assert.equal(ReShade.normalizeSettings({ enabled: true, preset: "shader:quint:mxao" }).preset, "shader:managed-quint:fdd84443706a9275");
  assert.ok(Managed.isId(current));assert.ok(Managed.Catalog.packs.some(pack => pack.id === "quint" && pack.repository === "martymcmodding/qUINT"));
  assert.throws(() => Packs.resolveEffect(userDataDir, legacy, features), /Unknown/);
  const file = path.join(userDataDir, "runtimes/reshade-shaders/quint/old-local-revision/Shaders/qUINT_bloom.fx");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, "// Existing locally selected effect\n", { mode: 0o600 });
  assert.equal(ReShade.updateSettings({}, { preset: "custom", effectPath: file }).effectPath, file);
  assert.equal(fs.readFileSync(file, "utf8"), "// Existing locally selected effect\n");
});
test("scene requirements wait for actual frame inputs while lookup requirements follow provider features", () => {
  const effect = { requires: ["depth"] }, support = { depth: { hosts: ["window"], frameAPI: 1 } };
  assert.equal(Packs.requirements(effect, support, "window"), null);
  assert.equal(Packs.requirements(effect, support), null);
  for (const host of ["remote", "explicit", null, "unknown"]) assert.equal(Packs.requirements(effect, support, host), null);
  assert.equal(Packs.requirements(effect, { depth: { frameAPI: 1 } }, "explicit"), null);
  const Plan=require("../src/modules/shared/effects/plan");
  const context={reshadeState:{available:true,presets:[{id:"shader:native:ffx-dof",available:true,label:"FidelityFX DoF"}]},graphicsCapabilities:{}};
  const waiting=Plan.catalog(context).find(row=>row.id==="shader:native:ffx-dof");
  assert.equal(waiting.available,true);assert.deepEqual(waiting.pendingInputs,["depth","projectionMatrix"]);
  assert.match(Packs.requirements({ requires: ["sourceTextures"] }, {}), /lookup texture/);
  assert.match(Packs.requirements({ requires: ["smaa"] }, {}), /SMAA/);
  assert.equal(Packs.listEffects(null, {}).find(row => row.id === "shader:sweetfx:smaa").available, false);
  assert.equal(Packs.listEffects(null, features).find(row => row.id === "shader:sweetfx:smaa").available, true);
});
test("native collection paths use app.asar.unpacked without materialization or a user cache", t => {
  const root = directory(t), moduleRoot = path.join(root, "resources/app.asar/src/modules/shared/reshade");
  const realRoot = path.join(root, "resources/app.asar.unpacked/src/modules/shared/reshade");
  const original = Packs.resolveEffect(null, "shader:sweetfx:tonemap", features);
  const file = path.join(realRoot, "shader-collection/sweetfx/Shaders/SweetFX/Tonemap.fx");
  fs.mkdirSync(path.dirname(file), { recursive: true });fs.copyFileSync(original.file, file);
  const selected = Packs.resolveEffect(null, "pack:sweetfx:93ddf39b357f:tonemap", features, null, { moduleRoot });
  assert.equal(selected.file, file);assert.ok(fs.statSync(selected.file).isFile());
  for (const name of [selected.file, ...selected.includePaths, ...selected.texturePaths]) {
    assert.ok(name.startsWith(realRoot + path.sep));assert.equal(name.includes("app.asar/"), false);
  }
  assert.equal(fs.existsSync(moduleRoot), false);
  const compiler = path.join(ReShade.runtimeRoot(), "fx-compile");
  if (process.platform === "darwin" && fs.existsSync(compiler)) {
    const output = path.join(root, "compiled");fs.mkdirSync(output);
    execFileSync(compiler, [selected.file, output], { env: compilerEnvironment(selected), timeout: 30000 });
    assert.ok(fs.existsSync(path.join(output, "effect.json")) || fs.readdirSync(output).length > 0);
  }
});
function compilerEnvironment(selected) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DYLD_") || key.startsWith("RESHADE_")) delete env[key];
  env.RESHADE_INCLUDE_PATH = [path.join(ReShade.runtimeRoot(), "include"), ...selected.includePaths].join(path.delimiter);
  return env;
}
test("current included compiler loads every bundled shader offline with original lookup images", t => {
  const compiler = path.join(ReShade.runtimeRoot(), "fx-compile");
  if (process.platform !== "darwin" || !fs.existsSync(compiler)) return t.skip("Requires the included macOS ReShade compiler");
  const root = directory(t);
  for (const row of Packs.listEffects(null, features).filter(row => row.format === "fx")) {
    const selected = Packs.resolveEffect(null, row.id, features), output = path.join(root, row.id.replaceAll(":", "-"));
    fs.mkdirSync(output);
    execFileSync(compiler, [selected.file, output], { env: compilerEnvironment(selected), timeout: 30000, maxBuffer: 2 << 20 });
    const textures = JSON.parse(fs.readFileSync(path.join(output, "textures.json"), "utf8"));
    for (const texture of textures) assert.ok(selected.texturePaths.some(directory => fs.existsSync(path.join(directory, texture))));
  }
});
test("game preparation uses included paths and no shader runtime lease", { skip: process.platform !== "darwin" }, async t => {
  const root = directory(t), runtime = path.join(root, "runtime");fs.mkdirSync(runtime);
  for (const name of ["fx-compile", "libreshade-macos.dylib"]) fs.writeFileSync(path.join(runtime, name), "fixture");
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({ schema: 1, version: "fixture", minimumMacOS: "11.0", features: { shaders: features, graphics: { effectPlanAPI: 1 } } }));
  const userDataDir = path.join(root, "profile");fs.mkdirSync(userDataDir);
  const included = Packs.resolveEffect(null, "pack:sweetfx:93ddf39b357f:tonemap", features).file, prepared = [];
  const shader = { id: "shader", kind: "shader", enabled: true, shader: { enabled: true, preset: "pack:sweetfx:93ddf39b357f:tonemap" } };
  const env = await ReShade.prepare({ gameId: "owned-game", effects: { schema: 2, mode: "advanced", enabled: true, video: [shader] } }, {
    userDataDir, root: runtime, graphicsHost: "window", verify: () => true,
    useShaderPack: () => assert.fail("Included shaders require no runtime lease"), execute: async (_command, args, options) => {
      if (args[0] !== "--prepare") return fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
      prepared.push({ includePath: options.env.RESHADE_INCLUDE_PATH, name: path.basename(args[1]), source: fs.readFileSync(args[1], "utf8") });
      fs.writeFileSync(args[2], "prepared shader");
    }
  });
  assert.equal(prepared.length, 1);
  assert.match(prepared[0].includePath, /shader-collection\/sweetfx\/Shaders\/SweetFX/);
  assert.match(included, /shader-collection\/sweetfx\/Shaders\/SweetFX\/Tonemap.fx$/);
  assert.equal(prepared[0].name, "Tonemap.fx");assert.equal(prepared[0].source, fs.readFileSync(included, "utf8"));
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
  const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(env.RESHADE_EFFECT_PLAN), "launch.json")));
  assert.deepEqual(launch.graphicsPreparation.applied, [{ id: "shader", kind: "shader", method: "shader:sweetfx:tonemap" }]);
});
