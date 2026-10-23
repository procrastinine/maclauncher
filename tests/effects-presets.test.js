const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const Presets = require("../src/modules/shared/effects/presets");
const empty = () => ({ schema: 1, mode: "advanced", video: [] });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "effects-presets-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root;
}
test("presets preserve chain snapshots and independent application copies across edits and removal", t => {
  const root = fixture(t), plan = { ...empty(), renderResolution: { height: 480 }, video: [
    { id: "shrink", kind: "spatial", method: "downsample", enabled: true, outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: .5 } },
    { id: "model", kind: "neural", method: "mlx-dlss", enabled: false, settings: { modelPath: "/Models/Local.dlssmodel", temporal: false, intensity: .75 } }
  ] };
  const saved = Presets.save(root, { name: "Low resolution", plan }), applied = structuredClone(saved.plan);
  plan.video[0].outputSize.width = 1;saved.plan.video[1].settings.intensity = 0;
  const stored = Presets.list(root)[0];assert.equal(stored.plan.video[0].outputSize.width, 854);assert.equal(stored.plan.video[1].settings.intensity, .75);
  const edited = Presets.save(root, { ...stored, name: "Revised", plan: empty() });
  assert.equal(edited.id, stored.id);assert.ok(edited.updatedAt > stored.updatedAt);
  assert.equal(applied.video.length, 2);assert.equal(applied.renderResolution.height, 480);
  Presets.remove(root, edited.id, edited.updatedAt);assert.deepEqual(Presets.list(root), []);assert.equal(applied.video.length, 2);
});
test("preset writes reject stale concurrent edits, malformed chains and duplicate names without changing saved data", t => {
  const root = fixture(t), saved = Presets.save(root, { name: "Film", plan: empty() });
  assert.throws(() => Presets.save(root, { name: "Ｆｉｌｍ", plan: empty() }), /already exists/);
  assert.throws(() => Presets.save(root, { name: "Bad", plan: { ...empty(), unexpected: true } }), /valid ordered effects plan/);
  const revised = Presets.save(root, { ...saved, name: "Cinema" });
  assert.throws(() => Presets.save(root, { ...saved, name: "Old" }), /another window/);
  assert.throws(() => Presets.remove(root, saved.id, saved.updatedAt), /another window/);
  assert.deepEqual(Presets.list(root), [revised]);
});
test("preset storage rejects symlinked or corrupt metadata and does not replace it", t => {
  const root = fixture(t), file = Presets.location(root);
  fs.mkdirSync(path.dirname(file));const target = path.join(root, "original.json");fs.writeFileSync(target, "private");fs.symlinkSync(target, file);
  assert.throws(() => Presets.save(root, { name: "A", plan: empty() }), /could not be read/);
  assert.equal(fs.readFileSync(target, "utf8"), "private");fs.unlinkSync(file);fs.writeFileSync(file, "invalid");
  assert.throws(() => Presets.list(root), /could not be read/);assert.equal(fs.readFileSync(file, "utf8"), "invalid");
});
test("preset IPC is local draft storage and publishes no game plan; preload invokes only explicit requests", async t => {
  const root = fixture(t), handlers = new Map(), { register } = require("../src/modules/shared/effects/presets-ipc");
  register({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, userDataDir: root, app: {}, loadSettings: () => ({}), pickFile: async () => null });
  const saved = handlers.get("launcher:saveEffectsPreset")(null, { name: "Copy", plan: empty() });
  assert.equal(handlers.get("launcher:listEffectsPresets")(null)[0].id, saved.id);
  assert.equal(fs.existsSync(path.join(root, "games")), false);assert.equal(await handlers.get("launcher:pickEffectsPresetFile")(null), null);
  let api;const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => api = value.launcher }, ipcRenderer: { invoke: async (...args) => calls.push(args) }, webUtils: {} })
  });
  assert.deepEqual(calls, []);await api.listEffectsPresets();await api.saveEffectsPreset({ name: "Copy", plan: empty() });
  await api.deleteEffectsPreset(saved.id, saved.updatedAt);await api.getEffectsPresetParameters("node", empty());
  assert.deepEqual(calls.map(row => row[0]), ["launcher:listEffectsPresets", "launcher:saveEffectsPreset", "launcher:deleteEffectsPreset", "launcher:getEffectsPresetParameters"]);
});
