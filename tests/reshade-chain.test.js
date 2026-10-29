const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ReShade = require("../src/modules/shared/reshade");
const Chain = require("../src/modules/shared/reshade/effect-chain");
const Native = require("../src/modules/shared/runtime/bundled-native");

test("ordered effects preserve existing choices and reject unbounded or custom stages", () => {
  const original = { enabled: true, preset: "custom", effectPath: "/Effects/Original.fx" };
  const combined = ReShade.updateSettings(original, { preset: "chain" });
  assert.deepEqual(combined, { ...original, preset: "chain", effects: ["cas", "crt"] });
  const effects = ["crt", "cas", "cas", "vibrance"];
  const selected = ReShade.updateSettings(combined, { effects });
  effects.reverse();
  assert.deepEqual(selected.effects, ["crt", "cas", "cas", "vibrance"]);
  assert.deepEqual(ReShade.updateSettings(selected, { preset: "custom" }), { ...selected, preset: "custom" });
  assert.deepEqual(ReShade.updateSettings(selected, { preset: "custom", effects: null }), original);
  assert.deepEqual(ReShade.updateSettings(selected, { effects: null }).effects, ["cas", "crt"]);
  assert.throws(() => Chain.source(null), /two to four/);
  for (const value of ["crt", [], ["crt"], Array(2), Array(5).fill("crt"), ["crt", "custom"], ["crt", "chain"], ["crt", "../escape"], ["crt", "constructor"], ["crt", 42]]) {
    assert.throws(() => ReShade.updateSettings(selected, { effects: value }), /two to four/);
    assert.throws(() => Chain.source(value), /two to four/);
  }
  assert.deepEqual(ReShade.normalizeSettings({ preset: "chain", effects: ["stale"] }).effects, ["cas", "crt"]);
});

test("generated technique references every stage in order and isolates repeated shader symbols", () => {
  const source = Chain.source(["cas", "crt", "cas", "vibrance"]);
  const passes = [...source.matchAll(/PixelShader = ([^;]+);/g)].map(match => match[1]);
  assert.deepEqual(passes, ["MLStage0::CASPass", "MLStage1::CRT", "MLStage2::CASPass", "MLStage3::Colour"]);
  assert.equal((source.match(/#include "ReShade.fxh"/g) || []).length, 1);
  assert.equal((source.match(/#undef pixel/g) || []).length, 4);
  assert.match(source, /technique MacLauncherChain/);
  assert.doesNotMatch(source, /VertexShader = MLStage\d::PostProcessVS/);
});

test("combined preparation publishes one bounded selection and cleans failed or cancelled attempts", { skip: process.platform !== "darwin" }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-chain-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "runtime"), userDataDir = path.join(base, "profile");
  fs.mkdirSync(path.join(root, "effects"), { recursive: true });
  for (const file of ["libreshade-macos.dylib", "fx-compile", "effects/crt.fx"]) fs.writeFileSync(path.join(root, file), "fixture");
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "13.0", features: { graphics: { effectPlanAPI: 1 } } }));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const options = { root, userDataDir, graphicsHost: "window", verify: () => true, diagnostics: false, gpuTiming: false, trace: false };
  const selection = shader => ({ gameId: "chain", effects: { schema: 2, mode: "advanced", enabled: true, video: [{ id: "shader", kind: "shader", enabled: true, shader: { enabled: true, ...shader } }] } });
  const node = environment => JSON.parse(fs.readFileSync(environment.RESHADE_EFFECT_PLAN)).nodes.find(row => row.id === "shader");
  let effects = ["crt", "cas"];
  const calls = [];
  const execute = async (_command, args, opts) => {
    calls.push(args);
    assert.ok(opts.env.RESHADE_INCLUDE_PATH.startsWith(path.join(root, "include") + ":" + path.join(root, "effects") + ":"));
    const source = fs.readFileSync(args[0] === "--prepare" ? args[1] : args[0], "utf8");
    const prepared = "prepared " + effects.join("-");
    if (args[0] === "--prepare") {
      assert.equal(source, Chain.source(effects));
      fs.writeFileSync(args[2], prepared);
    } else {
      assert.equal(source, prepared, "validation compiles the frozen preprocessed bytes");
      assert.notEqual(args[0], calls[calls.length - 2][1], "validation does not reread the mutable combined source");
      fs.writeFileSync(path.join(args[1], "textures.json"), "[]");
    }
  };
  const env = await ReShade.prepare(selection({ preset: "chain", effects }), { ...options, execute });
  const owned = path.join(userDataDir, "games/chain/effects/reshade/plan-nodes/shader");
  assert.equal(calls.length, 2);
  assert.equal(node(env).technique, "MacLauncherChain");
  assert.deepEqual(fs.readdirSync(owned).sort(), ["live-effects", "live-selection.json"]);
  assert.equal(fs.readFileSync(node(env).file, "utf8"), "prepared crt-cas");
  const snapshot = () => new Map([["live-selection.json", fs.readFileSync(path.join(owned, "live-selection.json"))],
    ...fs.readdirSync(path.join(owned, "live-effects")).sort().map(file => [file, null])]);
  const saved = snapshot();
  for (const error of [new Error("invalid shader"), Object.assign(new Error("cancelled"), { name: "AbortError" })]) {
    const attempt = ReShade.prepare(selection({ preset: "chain", effects: ["cas", "cas"] }), { ...options,
      execute: async (_command, args) => { if (args[0] === "--prepare") fs.writeFileSync(args[2], "temporary"); else throw error; } });
    if (error.name === "AbortError") await assert.rejects(attempt, { name: "AbortError" });
    else assert.deepEqual(node(await attempt), { id: "shader", kind: "shader", enabled: false }, "a failed optional shader is skipped at launch");
    assert.deepEqual(snapshot(), saved);
    assert.deepEqual(fs.readdirSync(owned).sort(), ["live-effects", "live-selection.json"]);
  }
  effects = ["grayscale", "crt", "sharpen", "cas"];
  assert.equal(fs.readFileSync(node(await ReShade.prepare(selection({ preset: "chain", effects }), { ...options, execute })).file, "utf8"), "prepared grayscale-crt-sharpen-cas");
  assert.deepEqual(fs.readdirSync(owned).sort(), ["live-effects", "live-selection.json"]);
  const single = await ReShade.prepare(selection({ preset: "crt" }), { ...options,
    execute: async (_command, args) => { if (args[0] === "--prepare") fs.writeFileSync(args[2], "single"); else fs.writeFileSync(path.join(args[1], "textures.json"), "[]"); } });
  assert.equal(node(single).technique, undefined);
  assert.equal(fs.readFileSync(node(single).file, "utf8"), "single");
  assert.equal(ReShade.mergeEnvironment(env, single).RESHADE_TECHNIQUE, undefined);
  assert.equal(fs.readFileSync(path.join(root, "effects/crt.fx"), "utf8"), "fixture");
});
