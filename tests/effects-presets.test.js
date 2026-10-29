const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const Presets = require("../src/modules/shared/effects/presets");
const empty = () => ({ schema: 1, mode: "advanced", video: [] });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "effects-presets-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root;
}
test("a fresh preset library lists no presets or notices without creating files", t => {
  const root = fixture(t);
  assert.deepEqual(Presets.list(root), []);
  assert.deepEqual(Presets.notices(root), []);
  assert.equal(fs.existsSync(Presets.location(root)), false);
});
test("presets preserve chain snapshots and independent application copies across edits and removal", t => {
  const root = fixture(t), plan = { ...empty(), renderResolution: { height: 480 }, video: [
    { id: "shrink", kind: "spatial", method: "downsample", enabled: true, outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: .5 } },
    { id: "model", kind: "neural", method: "mlx-dlss", enabled: false, settings: { modelPath: "/Models/Local.dlssmodel", temporal: false, intensity: .75 } }
  ] };
  const saved = Presets.save(root, { name: "Low resolution", plan }), applied = structuredClone(saved.plan);
  plan.video[0].outputSize.width = 1;saved.plan.video[1].settings.intensity = 0;
  const stored = Presets.list(root)[0];assert.equal(stored.plan.schema, 2);assert.equal(stored.plan.video[0].extent.width, 854);assert.equal(stored.plan.video[1].settings.intensity, .75);
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
test("one unreadable preset or row leaves the rest of the library readable and is kept byte for byte", t => {
  const root = fixture(t), kept = Presets.save(root, { name: "Kept", plan: empty() }), file = Presets.location(root);
  const data = JSON.parse(fs.readFileSync(file, "utf8")), broken = { id: "not-a-preset", name: 7 };
  const partial = { id: "00000000-0000-4000-8000-000000000002", name: "Partial", updatedAt: 5, plan: { schema: 2, mode: "advanced", enabled: true, video: [
    { id: "gray", kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }, { id: "warp", kind: "warp", enabled: true }] } };
  fs.writeFileSync(file, JSON.stringify({ schema: 1, presets: [...data.presets, broken, partial] }));
  const listed = Presets.list(root);
  assert.deepEqual(listed.map(row => row.name), ["Kept", "Partial"]);
  assert.deepEqual(listed[1].plan.video.map(row => row.id), ["gray"]);assert.match(listed[1].notices[0].message, /skipped/);
  assert.deepEqual(Presets.notices(root).map(notice => notice.message), ["Saved preset number 2 could not be read and is not listed. This graphics preset could not be read."]);
  // Saving another preset rewrites neither the unreadable preset nor the
  // stored rows of the salvaged one.
  Presets.save(root, { name: "Added", plan: empty() });
  const after = JSON.parse(fs.readFileSync(file, "utf8")).presets;
  assert.deepEqual(after.find(row => row.id === broken.id), broken);assert.deepEqual(after.find(row => row.id === partial.id), partial);
  assert.deepEqual(Presets.list(root).map(row => row.name), ["Kept", "Partial", "Added"]);
  Presets.remove(root, kept.id, kept.updatedAt);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).presets.find(row => row.id === broken.id), broken);
});
test("preset IPC is local draft storage and publishes no game plan; preload invokes only explicit requests", async t => {
  const root = fixture(t), handlers = new Map(), { register } = require("../src/modules/shared/effects/presets-ipc");
  const picked=[],changed=[];register({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, userDataDir: root, app: {}, loadSettings: () => ({}), pickFile: async (...args) => {picked.push(args);return null;},changed:rows=>changed.push(rows) });
  const saved = handlers.get("launcher:saveEffectsPreset")(null, { name: "Copy", plan: empty() });
  assert.equal(handlers.get("launcher:listEffectsPresets")(null)[0].id, saved.id);
  assert.deepEqual(changed,[[saved]]);assert.deepEqual(handlers.get('launcher:deleteEffectsPreset')(null,saved.id,saved.updatedAt),[]);assert.deepEqual(changed[1],[]);
  assert.equal(fs.existsSync(path.join(root, "games")), false);assert.equal(await handlers.get("launcher:pickEffectsPresetFile")(null), null);
  assert.equal(await handlers.get('launcher:pickEffectsPresetFile')(null,'neural-model','rife'),null);assert.deepEqual(picked,[[undefined],['neural-model','rife']]);
  let api;const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/launcher.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => api = value.launcher }, ipcRenderer: { invoke: async (...args) => calls.push(args) }, webUtils: {} })
  });
  assert.deepEqual(calls, []);await api.listEffectsPresets();await api.saveEffectsPreset({ name: "Copy", plan: empty() });
  await api.deleteEffectsPreset(saved.id, saved.updatedAt);await api.getEffectsPresetParameters("node", empty());
  assert.deepEqual(calls.map(row => row[0]), ["launcher:listEffectsPresets", "launcher:saveEffectsPreset", "launcher:deleteEffectsPreset", "launcher:getEffectsPresetParameters"]);
});
test('preset event subscriptions push exact rows and unsubscribe without IPC reads',()=>{
 let api;const listeners=new Map(),received=[];
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/shared/web/preload/launcher.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_,value)=>api=value.launcher},ipcRenderer:{invoke:()=>assert.fail('Subscribing is offline'),on:(name,fn)=>listeners.set(name,fn),removeListener:(name,fn)=>{assert.equal(listeners.get(name),fn);listeners.delete(name);}},webUtils:{}})});
 const stop=api.onEffectsPresetsChanged(rows=>received.push(rows)),rows=[{id:'one',plan:empty()}];listeners.get('launcher:effectsPresetsChanged')(null,rows);assert.deepEqual(received,[rows]);stop();assert.equal(listeners.size,0);
});
