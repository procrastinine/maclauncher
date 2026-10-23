const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Models = require("../src/modules/shared/reshade/models");
const Manager = require("../src/modules/shared/reshade/runtime/models-manager");
const {DownloadManager} = require("../src/modules/shared/runtime/download-manager");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "Lossless.dll"); fs.writeFileSync(original, Buffer.alloc(128, 65));
  const inspection = { schema: 1, version: "3.2.2.0", contentHash: crypto.createHash("sha256").update(fs.readFileSync(original)).digest("hex"),
    resourceLayoutHash: "a".repeat(64), size: 128, resourceCount: 300,
    capabilities: Object.fromEntries(Models.CAPABILITIES.map(key => [key, { compatible: true, reason: "" }])) };
  return { root, original, inspection, options: { userDataDir: path.join(root, "profile"), runtimePath: original, inspect: async () => inspection } };
}
test("graphics model import owns a verified copy, deduplicates identical resources and preserves the original", async t => {
  const { original, options, inspection } = fixture(t), before = fs.readFileSync(original);
  const first = await Models.importModel(options), second = await Models.importModel(options);
  assert.equal(first.version, second.version); assert.equal(first.inspection.contentHash, inspection.contentHash);
  assert.notEqual(first.modelPath, original); assert.deepEqual(fs.readFileSync(first.modelPath), before);
  assert.equal(Models.listInstalled(options.userDataDir).length, 1);
  assert.equal((await Models.resolveModel(options.userDataDir, first.version, "lsfgFp16Quality")).modelPath, first.modelPath);
  assert.equal(await Models.removeModel(options.userDataDir, first.version), true);
  assert.deepEqual(fs.readFileSync(original), before); assert.equal(Models.listInstalled(options.userDataDir).length, 0);
});
test("coordinated Lossless import adds another content version while active model reuse stays read-only", async t => {
  const f = fixture(t), first = await Models.importModel(f.options);
  const { instrumentRuntimeManagers, withRuntimeUse } = require('../src/core/coordinated-runtime-managers');
  const manager = { ...Manager };instrumentRuntimeManagers([manager]);
  const secondPath = path.join(f.root, 'Second.dll'), secondBytes = Buffer.alloc(128, 66);fs.writeFileSync(secondPath, secondBytes);
  const secondInspection = { ...f.inspection, contentHash: crypto.createHash('sha256').update(secondBytes).digest('hex') };
  const before = fs.statSync(first.modelPath), identity = { managerId: Manager.id, sectionId: 'default', version: first.version, sourcePath: first.installDir };
  await withRuntimeUse(identity, async use => {
    await use.bind(process.pid);
    const second = await manager.importRuntime({ ...f.options, runtimePath: secondPath, inspect: async () => secondInspection });
    assert.notEqual(second.version, first.version);assert.equal(Models.listInstalled(f.options.userDataDir).length, 2);
    assert.equal((await manager.importRuntime(f.options)).version, first.version);assert.equal(fs.statSync(first.modelPath).ino, before.ino);
    await assert.rejects(manager.uninstallRuntime({ userDataDir: f.options.userDataDir, version: first.version }), { code: 'RUNTIME_IN_USE' });
    await assert.rejects(Models.removeModel(f.options.userDataDir, first.version), { code: 'RUNTIME_IN_USE' });
    const damaged = Buffer.alloc(128, 90);fs.writeFileSync(first.modelPath, damaged);
    await assert.rejects(manager.importRuntime(f.options), { code: 'RUNTIME_IN_USE' });assert.deepEqual(fs.readFileSync(first.modelPath), damaged);
  }, { userDataDir: f.options.userDataDir });
  await manager.importRuntime(f.options);assert.deepEqual(fs.readFileSync(first.modelPath), fs.readFileSync(f.original));
  assert.ok(fs.readdirSync(path.dirname(first.installDir)).every(name => !name.startsWith('.')));
});
test("graphics models reject incompatible inspection or hash mismatch without publishing an installation", async t => {
  const { options, inspection } = fixture(t);
  await assert.rejects(Models.importModel({ ...options, inspect: async () => ({ ...inspection, contentHash: "b".repeat(64) }) }), /changed during import/);
  assert.equal(Models.listInstalled(options.userDataDir).length, 0);
  await assert.rejects(Models.importModel({ ...options, inspect: async () => ({ ...inspection,
    capabilities: Object.fromEntries(Models.CAPABILITIES.map(key => [key, { compatible: false, reason: "missing resource" }])) }) }), /no compatible/);
  assert.deepEqual(fs.readdirSync(path.join(options.userDataDir, "runtimes/lossless-models")), []);
});
test("graphics launch selection detects model corruption, repairs by import and refuses aliases or path escapes", async t => {
  const { root, original, options } = fixture(t), installed = await Models.importModel(options);
  fs.writeFileSync(installed.modelPath, Buffer.alloc(128, 66));
  await assert.rejects(Models.resolveModel(options.userDataDir, installed.version, "lsfgFp32Performance"), /has changed/);
  await Models.importModel(options); await Models.resolveModel(options.userDataDir, installed.version, "lsfgFp32Performance");
  await assert.rejects(Models.resolveModel(options.userDataDir, "../../escape", "lsfgFp32Performance"), /installed compatible/);
  const link = path.join(root, "alias.dll"); fs.symlinkSync(original, link);
  await assert.rejects(Models.importModel({ ...options, runtimePath: link }), /compatible Lossless/);
  assert.throws(() => Models.removeModel(options.userDataDir, "../../escape"), /installed graphics/);
});

test("shared model management imports locally, reloads without network and removes only the stored copy", async t => {
  const { options, original } = fixture(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("local model management must not fetch"));
  const installed = await Manager.importRuntime(options);
  let settings = Manager.updateSettingsAfterInstall({}, installed);
  assert.equal(settings.defaultVersion, installed.version);
  const state = Manager.getState({ ...options, settings });
  assert.equal(state.sections[0].installed.length, 1);
  assert.equal(state.catalog.installable, false);
  assert.deepEqual(state.catalog.importExtensions, ["dll"]);
  assert.deepEqual((await Manager.refreshCatalog(options)).versions, [installed.version]);
  assert.ok(require("../src/modules/registry").listSharedRuntimeManagers().some(manager => manager.id === Manager.id));
  await Manager.uninstallRuntime({ userDataDir: options.userDataDir, version: installed.version });
  settings = Manager.updateSettingsAfterUninstall(settings, {}, options);
  assert.equal(settings.defaultVersion, null);
  assert.ok(fs.existsSync(original));
});

test("stored model aliases cannot substitute a different DLL or receipt", async t => {
  const { options, original, root } = fixture(t), installed = await Models.importModel(options);
  fs.unlinkSync(installed.modelPath); fs.symlinkSync(original, installed.modelPath);
  assert.deepEqual(Models.listInstalled(options.userDataDir), []);
  fs.unlinkSync(installed.modelPath); fs.copyFileSync(original, installed.modelPath);
  const receipt = path.join(installed.installDir, "model.json"), external = path.join(root, "receipt.json");
  fs.renameSync(receipt, external); fs.symlinkSync(external, receipt);
  assert.deepEqual(Models.listInstalled(options.userDataDir), []);
});
test("damaged Lossless copies remain removable while discovery, component status and leases stay strict", async t => {
  const f = fixture(t), installed = await Models.importModel(f.options), {withRuntimeUse} = require("../src/core/coordinated-runtime-managers");
  const manager = {...Manager};require("../src/core/coordinated-runtime-managers").instrumentRuntimeManagers([manager]);
  fs.unlinkSync(installed.modelPath);fs.symlinkSync(f.original, installed.modelPath);
  const aliasVersion = "sha256-" + "d".repeat(64), alias = path.join(path.dirname(installed.installDir), aliasVersion);
  fs.symlinkSync(f.root, alias);
  const lstat = fs.lstatSync;t.mock.method(fs, "lstatSync", (file, ...options) => {
    assert.equal(String(file).startsWith(alias + path.sep), false, "management must not inspect files through a version-directory alias");
    return lstat(file, ...options);
  });
  assert.deepEqual(Models.listInstalled(f.options.userDataDir), []);
  const state = manager.getState(f.options), row = state.installed[0];
  assert.equal(state.installed.length, 1);assert.equal(row.version, installed.version);assert.equal(row.ready, false);
  assert.equal(row.installDir, installed.installDir);assert.equal(row.modelPath, undefined);assert.equal(row.inspection, undefined);
  assert.equal(state.components.find(component => component.id === "lossless").available, false);
  await assert.rejects(Models.resolveModel(f.options.userDataDir, installed.version, "ls1Quality"), /unavailable/);
  await withRuntimeUse({managerId: Manager.id, version: installed.version, sectionId: "default", sourcePath: installed.installDir}, async use => {
    await use.bind(process.pid);await assert.rejects(manager.uninstallRuntime({userDataDir: f.options.userDataDir, version: installed.version}), {code: "RUNTIME_IN_USE"});
  }, {userDataDir: f.options.userDataDir});
  assert.equal(await manager.uninstallRuntime({userDataDir: f.options.userDataDir, version: installed.version}), true);
  assert.deepEqual(Models.listManaged(f.options.userDataDir), []);assert.deepEqual(fs.readFileSync(f.original), Buffer.alloc(128, 65));
});

for (const action of ["import", "findInstalled"]) test(`Lossless ${action} remains cancellable during inspection and cleans its owned copy before settlement`, async t => {
  const f = fixture(t), downloads = new DownloadManager(), caller = new AbortController();let entered, release, combinedSignal, settled = false;
  const inspecting = new Promise(resolve => {entered = resolve;}), cleanup = new Promise(resolve => {release = resolve;});
  const context = {...f.options, downloads, signal: caller.signal, inspect: async (_file, {signal}) => {
    combinedSignal = signal;assert.equal(downloads.list()[0].kind, "import");entered();await cleanup;signal.throwIfAborted();return f.inspection;
  }};
  let original = f.original;
  if (action === "findInstalled") {
    context.home = path.join(f.root, "home");context.clientRoots = [];
    original = path.join(context.home, "Library/Application Support/Steam/steamapps/common/Lossless Scaling/Lossless.dll");
    fs.mkdirSync(path.dirname(original), {recursive: true});fs.copyFileSync(f.original, original);
    delete context.runtimePath;context.setupActionId = "findInstalled";
  }
  const sourceBytes = fs.readFileSync(original);
  const imported = (action === "import" ? Manager.importRuntime(context) : Manager.performSetupAction(context)).finally(() => {settled = true;});
  const failed = assert.rejects(imported, {name: "AbortError"});await inspecting;
  const source = fs.readFileSync(require.resolve("../src/core/backend-operations"), "utf8"), start = source.indexOf("    beginShutdown() {"),
    end = source.indexOf("\n    removeGameData,", start);assert.ok(start >= 0 && end > start);
  require("node:vm").runInNewContext("({" + source.slice(start, end) + "}).beginShutdown", {
    shuttingDown: false, downloads, importProgress: {clear() {}}, pendingImports: new Map(), launching: new Map(), moduleActions: new Map()
  })();
  assert.equal(combinedSignal.aborted, true);assert.equal(caller.signal.aborted, false);assert.equal(settled, false);
  release();await failed;assert.deepEqual(downloads.list(), []);assert.deepEqual(Models.listInstalled(context.userDataDir), []);
  assert.deepEqual(fs.readdirSync(path.join(context.userDataDir, "runtimes/lossless-models")), []);
  assert.deepEqual(fs.readFileSync(original), sourceBytes);assert.deepEqual(fs.readFileSync(f.original), sourceBytes);
});
