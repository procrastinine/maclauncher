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
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ schema: 1, version: "test", minimumMacOS: "13.0" }));
  t.mock.method(Native, "systemVersionSync", () => "27.0");
  const options = { root, userDataDir, verify: () => true, diagnostics: false, gpuTiming: false, trace: false };
  const entry = { gameId: "chain", reshade: { enabled: true, preset: "chain", effects: ["crt", "cas"] } };
  const calls = [];
  const execute = async (_command, args, opts) => {
    calls.push(args);
    assert.equal(opts.env.RESHADE_INCLUDE_PATH, path.join(root, "include") + ":" + path.join(root, "effects"));
    const source = fs.readFileSync(args[0] === "--prepare" ? args[1] : args[0], "utf8");
    const prepared = "prepared " + entry.reshade.effects.join("-");
    if (args[0] === "--prepare") {
      assert.equal(source, Chain.source(entry.reshade.effects));
      fs.writeFileSync(args[2], prepared);
    } else {
      assert.equal(source, prepared, "validation compiles the frozen preprocessed bytes");
      assert.notEqual(args[0], calls[calls.length - 2][1], "validation does not reread the mutable combined source");
    }
  };
  const env = await ReShade.prepare(entry, { ...options, execute });
  const owned = path.dirname(env.RESHADE_EFFECT);
  assert.equal(calls.length, 2);
  assert.equal(env.RESHADE_TECHNIQUE, "MacLauncherChain");
  assert.deepEqual(fs.readdirSync(owned).sort(), ["combined.fx", "controls.bin", "launch.json", "prepared.fx", "window-state"]);
  assert.equal(fs.readFileSync(env.RESHADE_EFFECT, "utf8"), Chain.source(["crt", "cas"]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(owned, "launch.json"))).effects, ["crt", "cas"]);
  const saved = new Map(fs.readdirSync(owned).map(file => [file, fs.readFileSync(path.join(owned, file))]));
  for (const error of [new Error("invalid shader"), Object.assign(new Error("cancelled"), { name: "AbortError" })]) {
    await assert.rejects(ReShade.prepare({ ...entry, reshade: { ...entry.reshade, effects: ["cas", "cas"] } }, { ...options,
      execute: async (_command, args) => { if (args[0] === "--prepare") fs.writeFileSync(args[2], "temporary"); else throw error; } }));
    assert.deepEqual(fs.readdirSync(owned).sort(), [...saved.keys()].sort());
    for (const [file, contents] of saved) assert.deepEqual(fs.readFileSync(path.join(owned, file)), contents);
  }
  entry.reshade.effects = ["grayscale", "crt", "sharpen", "cas"];
  await ReShade.prepare(entry, { ...options, execute });
  assert.deepEqual(fs.readdirSync(owned).sort(), [...saved.keys()].sort());
  const single = await ReShade.prepare({ ...entry, reshade: { enabled: true, preset: "crt" } }, { ...options,
    execute: async (_command, args) => { if (args[0] === "--prepare") fs.writeFileSync(args[2], "single"); } });
  assert.equal(single.RESHADE_TECHNIQUE, undefined);
  assert.equal(fs.existsSync(path.join(owned, "combined.fx")), false);
  const merged = ReShade.mergeEnvironment(env, single);
  assert.equal(merged.RESHADE_TECHNIQUE, undefined);
  assert.equal(fs.readFileSync(path.join(root, "effects/crt.fx"), "utf8"), "fixture");
});
