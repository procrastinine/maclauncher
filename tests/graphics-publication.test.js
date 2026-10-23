const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {createPublication} = require("../src/modules/shared/reshade/live-publication");
const Writable = require("../src/modules/shared/writable-input");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-publication-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const files = ["controls.bin", "effect-plan.json"].map(name => path.join(root, name));
  for (const file of files) fs.writeFileSync(file, "accepted " + path.basename(file));
  const before = files.map(file => fs.readFileSync(file));
  return {root, files, before};
}
test("a synchronous publication failure restores already replaced accepted pointers", t => {
  const f = fixture(t), publication = createPublication(), original = Writable.atomicWrite;
  for (const file of f.files) publication.write(file, "candidate", {root: f.root, activation: file.endsWith("json")});
  let calls = 0;t.mock.method(Writable, "atomicWrite", (...args) => {
    if (++calls === 2) throw Error("disk write failed");return original(...args);
  });
  assert.throws(() => publication.commit(), {message: "disk write failed", publicationRestored: true});
  assert.equal(publication.rollback(), true);
  for (let i = 0; i < f.files.length; i++) assert.deepEqual(fs.readFileSync(f.files[i]), f.before[i]);
});
for (const newer of ["launch", "bytes"]) test(`rollback preserves newer ${newer} ownership after a shared commit`, t => {
  const f = fixture(t);let active = true;
  const publication = createPublication({isCurrent: () => active});
  for (const file of f.files) publication.write(file, "candidate", {root: f.root});
  publication.commit();
  if (newer === "launch") active = false;
  else fs.writeFileSync(f.files[0], "newer controls");
  const expected = f.files.map(file => fs.readFileSync(file));
  assert.equal(publication.rollback(), false);assert.equal(publication.rollback(), false);
  for (let i = 0; i < f.files.length; i++) assert.deepEqual(fs.readFileSync(f.files[i]), expected[i]);
});
test("rollback removes pointers that were absent before this publication", t => {
  const f = fixture(t), file = path.join(f.root, "source-controls.json"), publication = createPublication();
  publication.write(file, "candidate", {root: f.root});assert.equal(fs.existsSync(file), false);
  publication.commit();assert.equal(fs.readFileSync(file, "utf8"), "candidate");
  assert.equal(publication.rollback(), true);assert.equal(fs.existsSync(file), false);
});
test("next-launch deferral cannot activate otherwise valid staged files", t => {
  const f = fixture(t), publication = createPublication();
  publication.write(f.files[0], "candidate", {root: f.root});publication.defer();
  assert.equal(publication.deferred, true);
  assert.throws(() => publication.commit(), {code: "GRAPHICS_LIVE_STALE"});
  publication.rollback();assert.deepEqual(fs.readFileSync(f.files[0]), f.before[0]);
});
test("change inspection compares accepted bytes rather than staged write count", t => {
  const f = fixture(t), publication = createPublication();
  publication.observe(f.files[0], {root: f.root});
  publication.write(f.files[0], f.before[0], {root: f.root});
  assert.equal(publication.pending, 1);assert.deepEqual(publication.changedFiles, []);
  publication.write(f.files[1], "candidate", {root: f.root});
  assert.deepEqual(publication.changedFiles, [f.files[1]]);
  assert.deepEqual(publication.readOriginal(f.files[1]), f.before[1]);
  assert.equal(publication.read(f.files[1], "utf8"), "candidate");
  const original = publication.readOriginal(f.files[1]);original.fill(0);
  assert.deepEqual(publication.readOriginal(f.files[1]), f.before[1]);
  assert.deepEqual(fs.readFileSync(f.files[1]), f.before[1]);
});
test("live controls may request generation before the activation-last ordered graph becomes visible", t => {
  const f = fixture(t), publication = createPublication(), original = Writable.atomicWrite;
  const Live = require("../src/modules/shared/reshade/live-controls");
  const [controls, pointer] = f.files, resources = path.join(f.root, "live-models.json");
  const oldControls = Live.packet({graphics: {frameGeneration: "off"}});
  const oldPlan = JSON.stringify({schema: 1, mode: "simple", nodes: []});
  fs.writeFileSync(controls, oldControls);fs.writeFileSync(pointer, oldPlan);
  // Insertion order deliberately differs: activation must still occur last.
  publication.write(pointer, JSON.stringify({schema: 1, mode: "advanced", nodes: [{kind: "frame-generation", enabled: true}]}),
    {root: f.root, activation: true});
  publication.write(resources, "prepared model binding", {root: f.root});
  publication.write(controls, Live.packet({graphics: {frameGeneration: "lsfg", frameMultiplier: 4}}), {root: f.root});
  const observations = [];
  t.mock.method(Writable, "atomicWrite", (file, bytes, options) => {
    original(file, bytes, options);
    observations.push(path.basename(file));
    if (file === controls) {
      assert.equal(fs.readFileSync(resources, "utf8"), "prepared model binding");
      assert.equal(fs.readFileSync(controls).readUInt32LE(16) & 1, 1);
      assert.equal(JSON.parse(fs.readFileSync(pointer, "utf8")).mode, "simple",
        "the native reader must tolerate new controls while its accepted graph is still Simple");
    }
  });
  publication.commit();
  assert.deepEqual(observations, ["live-models.json", "controls.bin", "effect-plan.json"]);
  assert.equal(JSON.parse(fs.readFileSync(pointer, "utf8")).mode, "advanced");
});
