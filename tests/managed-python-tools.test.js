const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const { createManagedPythonTool } = require("../src/modules/shared/runtime/managed-python-tool");

function fixture(t, extra = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-python-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "tool.zip");
  writeZipArchive(archive, [{ name: "source/main.py", data: "print('managed source tool executed')\n" },
    { name: "source/LICENSE", data: "Fixture license" }, { name: "source/tests/fixture.py", data: "never loaded" },
    { name: "source/AGENTS.md", data: "not runtime content" }, ...extra]);
  const artifact = { version: "1.0.0", url: "https://example.com/tool.zip", bytes: fs.statSync(archive).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), archivePrefix: "source" };
  let requests = 0, approvals = 0;
  const manager = createManagedPythonTool({ id: "fixture-python-tool", label: "Fixture Python tool", scriptName: "main.py",
    sourceUrl: "https://example.com/tool", discoverCatalog: async () => { requests++; return [artifact]; } });
  const context = { userDataDir: path.join(root, "profile"), settings: {}, confirmRuntimeInstall: async () => { approvals++; return true; } };
  const dependencies = { downloadToFile: async (_url, target) => fs.copyFileSync(archive, target) };
  return { root, archive, artifact, manager, context, dependencies, counts: () => ({ requests, approvals }) };
}

test("managed source tools remain offline until explicit action, omit fixtures and execute included Python", { skip: process.platform !== "darwin" }, async t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.getState(f.context).catalog.versions, []);
  assert.deepEqual(f.counts(), { requests: 0, approvals: 0 });
  const installed = await f.manager.ensureTool(f.context, {}, f.dependencies);
  assert.equal(installed.version, f.artifact.version);
  assert.deepEqual(f.counts(), { requests: 1, approvals: 1 });
  assert.deepEqual(Object.keys(installed.files).sort(), ["LICENSE", "main.py"]);
  const logPath = path.join(f.root, "tool.log");
  await f.manager.run(f.context, [], { installed, cwd: f.root, logPath });
  assert.match(fs.readFileSync(logPath, "utf8"), /managed source tool executed/);
  await f.manager.ensureTool(f.context, { version: installed.version }, { downloadToFile: () => { throw new Error("offline reuse must not download"); } });
  assert.deepEqual(f.counts(), { requests: 1, approvals: 1 });
});

test("Python tool downloads reject changed bytes and cannot escape their installation", async t => {
  const f = fixture(t);
  await assert.rejects(f.manager.ensureTool(f.context, { version: f.artifact.version }, { downloadToFile: async (_url, target) => fs.writeFileSync(target, "changed") }), /checksum/);
  assert.equal(f.manager.core.listInstalled(f.context.userDataDir).length, 0);
  const bad = fixture(t, [{ name: "source/../../escape.py", data: "unsafe" }]);
  await assert.rejects(bad.manager.ensureTool(bad.context, { version: bad.artifact.version }, bad.dependencies), /unsafe/);
  assert.equal(fs.existsSync(path.join(bad.root, "escape.py")), false);
});

test("production Python commands retain explicitly required round-trip helpers without admitting test directories", async t => {
  const f = fixture(t, [{ name: "source/test.py", data: "public production command" }]);
  const output = path.join(f.root, "extracted"); fs.mkdirSync(output);
  const manager = createManagedPythonTool({ id: "fixture-python-command", label: "Fixture", scriptName: "main.py",
    requiredFiles: ["main.py", "test.py"] });
  const files = manager.__test.extract(f.archive, output, f.artifact);
  assert.ok(files["test.py"]); assert.ok(!files["tests/fixture.py"]);
});

test("Python tools restore consented discovery, installed fallback and fill-on-first-install while retaining explicit choices", async t => {
  const f = fixture(t), events = [], dependencies = { ...f.dependencies, discoverCatalog: async () => {
    events.push("discover"); return [{ ...f.artifact, version: "1.0.0" }, { ...f.artifact, version: "2.0.0" }];
  } };
  await assert.rejects(f.manager.ensureTool({ ...f.context, confirmRuntimeInstall: async () => false }, {}, dependencies), { code: "ABORT_ERR" });
  assert.deepEqual(events, []);
  const context = { ...f.context, confirmRuntimeInstall: async () => { events.push("consent"); return true; } };
  const automatic = await f.manager.ensureTool(context, {}, dependencies);
  assert.equal(automatic.version, "2.0.0");
  assert.deepEqual(events, ["consent", "discover"]);
  const installed = await f.manager.ensureTool(context, { version: "2.0.0" }, dependencies);
  assert.equal(installed.version, "2.0.0");
  assert.deepEqual(f.manager.updateSettingsAfterInstall({}, installed), { defaultVersion: "2.0.0" });
  assert.deepEqual(f.manager.updateSettingsAfterInstall({ defaultVersion: "1.0.0" }, installed), { defaultVersion: "1.0.0" });
  assert.deepEqual(f.manager.updateSettingsAfterInstall({ defaultVersion: null }, installed), { defaultVersion: "2.0.0" });
  await f.manager.refreshCatalog(f.context, { discoverCatalog: async () => [{ ...f.artifact, version: "3.0.0" }] });
  assert.equal(f.manager.getState({userDataDir:f.context.userDataDir}).defaultVersion, "3.0.0");
  assert.equal(f.manager.getState({userDataDir:f.context.userDataDir,settings:{defaultVersion:null}}).defaultSource, "manager");
  const reused = await f.manager.ensureTool({ ...f.context, settings:{runtimes:{[f.manager.id]:{defaultVersion:"2.0.0"}}}, confirmRuntimeInstall: () => assert.fail("Saved installed default remains offline") }, {}, {});
  assert.equal(reused.version, "2.0.0");
  const exact = await f.manager.ensureTool({ ...f.context, settings: { runtimes: { [f.manager.id]: { defaultVersion: "2.0.0" } } },
    confirmRuntimeInstall: () => assert.fail("Exact installed tool stays offline") }, {}, {});
  assert.equal(exact.version, "2.0.0");
});
