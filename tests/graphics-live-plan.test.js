const test = require("node:test"), assert = require("node:assert/strict");
const {project, selectionKey} = require("../src/modules/shared/effects/live-plan");
const shader = {id: "crt", kind: "shader", enabled: true, shader: {enabled: true, preset: "crt"}};
const fg = {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: "sha256-" + "b".repeat(64)}};
const previous = {schema: 1, mode: "advanced", nodes: [
  {id: "crt", kind: "shader", enabled: true, file: "/immutable/crt.fx", requirements: {}},
  {id: "fg", kind: "frame-generation", enabled: true, method: "lsfg", settings: {modelVersion: "sha256-" + "a".repeat(64)}, modelPath: "/immutable/old.dll", requirements: {depth: false, motion: false}}
]};
previous.revision = require("node:crypto").createHash("sha256").update(JSON.stringify(previous.nodes)).digest("hex");
const requested = rows => ({schema: 1, mode: "advanced", video: rows});
const unavailable = node => node.kind === "frame-generation" ? "Model unavailable to this process." : null;

test("an unavailable model retains its exact native row while independent shader changes remain live", () => {
  const candidate = requested([{...shader, shader: {...shader.shader, parameters: {V__Strength: [.8]}}}, fg]);
  const before = structuredClone(candidate), old = structuredClone(previous), result = project(candidate, previous, unavailable);
  assert.deepEqual(result.plan.video[0].shader.parameters, {V__Strength: [.8]});
  assert.equal(result.plan.video[1].settings.modelVersion, "sha256-" + "a".repeat(64));
  assert.deepEqual(result.retained.get("fg"), previous.nodes[1]);
  assert.deepEqual(result.pending, [{id: "fg", kind: "frame-generation", method: "lsfg", reason: "Model unavailable to this process.", retained: true, requestKey: selectionKey(fg)}]);
  assert.deepEqual(candidate, before);assert.deepEqual(previous, old);
});
test("a newly unavailable stage is pending while compatible existing stages remain enabled", () => {
  const result = project(requested([shader, {...fg, id: "new-fg"}]), previous, unavailable);
  assert.equal(result.plan.video[0].enabled, true);assert.equal(result.plan.video[1].enabled, false);
  assert.equal(result.pending[0].retained, false);assert.equal(result.retained.size, 0);
});
test("retained compiled Simple placement remains native metadata and cannot leak into the saved editable settings", () => {
  const old = structuredClone(previous);
  Object.assign(old.nodes[1].settings, {simpleGenerationPlacement: "source-cost-v1", simpleSpatialNodeId: "fit"});
  old.revision = require("node:crypto").createHash("sha256").update(JSON.stringify(old.nodes)).digest("hex");
  const result = project(requested([shader, fg]), old, unavailable);
  assert.equal(result.pending[0].retained, true);
  assert.equal(result.retained.get("fg").settings.simpleGenerationPlacement, "source-cost-v1");
  assert.equal(result.plan.video[1].settings.simpleGenerationPlacement, undefined);
});
test("unchanged supported, wholly unsupported and unauthenticated previous graphs keep ordinary atomic behavior", () => {
  assert.equal(project(requested([shader]), previous, unavailable), null);
  assert.equal(project(requested([fg]), previous, unavailable), null);
  for (const old of [null, {...previous, revision: "invalid"}, {...previous, schema: 2}, {...previous, nodes: []},
    {...previous, mode: "simple", revision: require("node:crypto").createHash("sha256").update(JSON.stringify(["simple"])).digest("hex")}])
    assert.equal(project(requested([shader, fg]), old, unavailable), null);
  const off = project(requested([shader, {...fg, enabled: false}]), previous, unavailable);
  assert.equal(off, null, "turning an unsupported stage off is an ordinary live change");
});

test("a rejected pointer cannot replace the exact native-accepted document used for live projection", t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), History = require("../src/modules/shared/effects/live-plan");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-live-history-")), file = path.join(root, "effect-plan.json");
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(file, JSON.stringify(previous));
  for (let index = 0; index < 7; index++) {
    const candidate = structuredClone(previous);candidate.nodes[1].settings.modelVersion = `rejected-${index}`;
    candidate.revision = require("node:crypto").createHash("sha256").update(JSON.stringify(candidate.nodes)).digest("hex");
    assert.equal(History.recordDocument(file, candidate, {root, launchId: "current", acceptedRevision: previous.revision}), true);
    fs.writeFileSync(file, JSON.stringify(candidate));
  }
  assert.deepEqual(History.readAcceptedDocument(file, {launchId: "current", revision: previous.revision}), previous);
  const history = JSON.parse(fs.readFileSync(path.join(root, "effect-plan-history.json")));
  assert.equal(history.documents.length, 4, "failed attempts cannot grow history indefinitely");
  assert.equal(History.readAcceptedDocument(file, {launchId: "another", revision: previous.revision}), null);
  assert.equal(History.readAcceptedDocument(file, {launchId: "current", revision: "0".repeat(64)}), null);
  const accepted = history.documents.find(row => row.revision === previous.revision);accepted.nodes[1].modelPath = "/changed/model.dll";
  fs.writeFileSync(path.join(root, "effect-plan-history.json"), JSON.stringify(history));
  assert.equal(History.readAcceptedDocument(file, {launchId: "current", revision: previous.revision}), null, "changed historical bytes are never accepted by revision alone");
});
