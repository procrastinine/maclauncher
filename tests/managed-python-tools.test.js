// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const { createManagedPythonTool } = require("../src/modules/shared/runtime/managed-python-tool");
const Upstream = require("../src/modules/shared/runtime/upstream");
const LIST = "https://example.com/tool/versions.json";

function fixture(t, extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-python-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "tool.zip");
  writeZipArchive(archive, [{ name: "source/main.py", data: "print('managed source tool executed')\n" },
    { name: "source/LICENSE", data: "Fixture license" }, { name: "source/tests/fixture.py", data: "never loaded" },
    { name: "source/AGENTS.md", data: "not runtime content" }, ...extra]);
  const artifact = { version: "1.0.0", url: "https://example.com/tool.zip", bytes: fs.statSync(archive).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), archivePrefix: "source" };
  // The publisher's version list names each version's archive with its size and digest.
  const listing = { versions: ["1.0.0"], served: () => fs.readFileSync(archive), events: [] };
  let requests = 0, approvals = 0;
  Harness.network.routes = { [LIST]: () => { requests++; listing.events.push("discover");
    return listing.versions.map(version => ({ version, files: [{ name: "tool.zip", url: artifact.url, bytes: artifact.bytes, digest: artifact.sha256 }] })); },
  [artifact.url]: () => { listing.events.push("download"); return listing.served(); } };
  t.after(() => { Harness.network.routes = null; });
  const manager = createManagedPythonTool({ id: "fixture-python-tool", label: "Fixture Python tool", scriptName: "main.py",
    sourceUrl: "https://example.com/tool", upstream: Upstream.index({ locations: [LIST], parse: ([document]) => JSON.parse(document.text) }) });
  const context = { userDataDir: path.join(root, "profile"), settings: {}, confirmRuntimeInstall: async () => { approvals++; return true; } };
  return { root, archive, artifact, manager, context, listing, counts: () => ({ requests, approvals }) };
}

test("managed source tools remain offline until explicit action, omit fixtures and execute included Python", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.getState(f.context).catalog.versions, []);
  assert.deepEqual(f.counts(), { requests: 0, approvals: 0 });
  const installed = await f.manager.ensureTool(f.context, {});
  assert.equal(installed.version, f.artifact.version);
  assert.deepEqual(f.counts(), { requests: 1, approvals: 1 });
  assert.deepEqual(Object.keys(installed.files).sort(), ["LICENSE", "main.py"]);
  const logPath = path.join(f.root, "tool.log");
  await f.manager.run(f.context, [], { installed, cwd: f.root, logPath });
  assert.match(fs.readFileSync(logPath, "utf8"), /managed source tool executed/);
  await f.manager.ensureTool(f.context, { version: installed.version });
  assert.deepEqual(f.counts(), { requests: 1, approvals: 1 });
  assert.deepEqual(f.listing.events, ["discover", "download"], "Offline reuse downloads nothing");
});

test("Python tool downloads reject changed bytes and cannot escape their installation", async t => {
  const f = fixture(t);
  f.listing.served = () => Buffer.from("changed");
  await assert.rejects(f.manager.ensureTool(f.context, { version: f.artifact.version }), /does not match/);
  assert.equal(f.manager.core.listInstalled(f.context.userDataDir).length, 0);
  const bad = fixture(t, [{ name: "source/../../escape.py", data: "unsafe" }]);
  await assert.rejects(bad.manager.ensureTool(bad.context, { version: bad.artifact.version }), /unsafe/);
  assert.equal(fs.existsSync(path.join(bad.root, "escape.py")), false);
});

test("production Python commands retain explicitly required round-trip helpers without admitting test directories", async t => {
  const f = fixture(t, [{ name: "source/test.py", data: "public production command" }]);
  const output = path.join(f.root, "extracted"); fs.mkdirSync(output);
  const manager = createManagedPythonTool({ id: "fixture-python-command", label: "Fixture", scriptName: "main.py",
    requiredFiles: ["main.py", "test.py"], upstream: Upstream.index({ locations: [LIST], parse: () => [] }) });
  const files = manager.__test.extract(f.archive, output, f.artifact);
  assert.ok(files["test.py"]); assert.ok(!files["tests/fixture.py"]);
});

test("Python tools restore consented discovery, installed fallback and fill-on-first-install while retaining explicit choices", async t => {
  const f = fixture(t), events = f.listing.events; f.listing.versions = ["1.0.0", "2.0.0"];
  await assert.rejects(f.manager.ensureTool({ ...f.context, confirmRuntimeInstall: async () => false }, {}), { code: "ABORT_ERR" });
  assert.deepEqual(events, []);
  const context = { ...f.context, confirmRuntimeInstall: async () => { events.push("consent"); return true; } };
  const automatic = await f.manager.ensureTool(context, {});
  assert.equal(automatic.version, "2.0.0");
  assert.deepEqual(events, ["consent", "discover", "download"]);
  const installed = await f.manager.ensureTool(context, { version: "2.0.0" });
  assert.equal(installed.version, "2.0.0");
  assert.deepEqual(f.manager.updateSettingsAfterInstall({}, installed), { defaultVersion: "2.0.0" });
  assert.deepEqual(f.manager.updateSettingsAfterInstall({ defaultVersion: "1.0.0" }, installed), { defaultVersion: "1.0.0" });
  assert.deepEqual(f.manager.updateSettingsAfterInstall({ defaultVersion: null }, installed), { defaultVersion: "2.0.0" });
  f.listing.versions = ["3.0.0"]; await f.manager.refreshCatalog({ ...f.context, force: true });
  assert.equal(f.manager.getState({userDataDir:f.context.userDataDir}).defaultVersion, "3.0.0");
  assert.equal(f.manager.getState({userDataDir:f.context.userDataDir,settings:{defaultVersion:null}}).defaultSource, "manager");
  const reused = await f.manager.ensureTool({ ...f.context, settings:{runtimes:{[f.manager.id]:{defaultVersion:"2.0.0"}}}, confirmRuntimeInstall: () => assert.fail("Saved installed default remains offline") }, {}, {});
  assert.equal(reused.version, "2.0.0");
  const exact = await f.manager.ensureTool({ ...f.context, settings: { runtimes: { [f.manager.id]: { defaultVersion: "2.0.0" } } },
    confirmRuntimeInstall: () => assert.fail("Exact installed tool stays offline") }, {}, {});
  assert.equal(exact.version, "2.0.0");
});
