const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const Projector = require("../src/modules/flash/runtime/projector-manager");
const Flash = require("../src/modules/flash/main");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flash-projector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function native(cpu) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(cpu, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

function universal() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32BE(0xcafebabe);
  bytes.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    const start = 8 + index * 20, offset = 64 + index * 32;
    bytes.writeUInt32BE(cpu, start);
    bytes.writeUInt32BE(offset, start + 8);
    bytes.writeUInt32BE(32, start + 12);
    native(cpu).copy(bytes, offset);
  }
  return bytes;
}

function app(root, { version = Projector.__test.VERSION, binary = universal() } = {}) {
  const appPath = path.join(root, "Flash Player.app");
  const executablePath = path.join(appPath, "Contents", "MacOS", "Flash Player");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, binary, { mode: 0o755 });
  fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<plist><dict><key>CFBundleExecutable</key><string>Flash Player</string><key>CFBundleIdentifier</key><string>com.macromedia.Flash Player.app</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return { appPath, executablePath };
}

test("included universal player reports its actual version without network or management actions", t => {
  const network = t.mock.method(https, "get", () => { throw new Error("unexpected network"); });
  const root = temporary(t), state = Projector.getState({ userDataDir: root });
  assert.equal(state.defaultVersion, "35.0.0.60");
  assert.deepEqual(state.catalog.versions, ["35.0.0.60"]);
  assert.equal(state.catalog.installable, false);
  assert.equal(state.installed[0].ready, true);
  assert.deepEqual(state.installed[0].architectures, ["x86_64", "arm64"]);
  assert.equal(state.installed[0].source, "bundled");
  assert.equal(state.installed[0].bundledExecution, "direct");
  assert.equal(state.installed[0].needsRosetta, false);
  assert.equal(state.installed[0].removable, false);
  for (const method of ["installRuntime", "importRuntime", "uninstallRuntime", "refreshCatalog"]) assert.equal(typeof Projector[method], "undefined");
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(network.mock.callCount(), 0);
});

test("ordinary first Play uses the included player with no dependency prompt or runtime copy", async t => {
  const root = temporary(t), originalSettings = { runtimes: {} }, settings = structuredClone(originalSettings);
  const forbid = () => { throw new Error("Included player must not request setup"); };
  const result = await prepareForLaunch({
    entry: { gameType: "scripted", runtimeId: "projector" }, mod: Flash, info: Flash.manifest,
    context: { runtimeId: "projector", userDataDir: root, settings, confirmRuntimeInstall: forbid, ensureRosetta: forbid },
    registry: { listModuleIds: () => ["flash"], getModule: () => Flash }, install: forbid
  });
  assert.equal(result, true);
  assert.deepEqual(settings, originalSettings);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("packaged player resolves from app.asar.unpacked before the development resource", t => {
  const root = temporary(t);
  const nativeRoot = path.join(root, "app.asar.unpacked", path.dirname(Projector.__test.PROJECTOR_APP_RELATIVE));
  const original = app(nativeRoot);
  const candidates = Projector.__test.listProjectorAppCandidates(root);
  assert.equal(candidates[0], original.appPath);
  const selection = Projector.__test.createManager({ appPaths: candidates }).resolveSelection();
  assert.equal(selection.ready, true);
  assert.equal(selection.install.executablePath, original.executablePath);
  assert.equal(selection.install.needsRosetta, false);
});

test("obsolete downloader settings cannot downgrade the fixed universal player", t => {
  const source = app(temporary(t)), manager = Projector.__test.createManager({ appPaths: [source.appPath] });
  const settings = { runtimes: { [manager.id]: { defaultVersion: "32.0.0.465" } } };
  const selection = manager.resolveSelection({ runtimeData: { projector: { version: "32.0.0.465" } } }, settings);
  assert.equal(selection.ready, true);
  assert.equal(selection.version, "35.0.0.60");
  assert.equal(selection.install.executablePath, source.executablePath);
  assert.deepEqual(manager.normalizeSettings(settings.runtimes[manager.id]), { defaultVersion: "35.0.0.60" });
});

test("status cache invalidates changed player metadata and leaves a visible damaged row", t => {
  const source = app(temporary(t)), manager = Projector.__test.createManager({ appPaths: [source.appPath] });
  assert.equal(manager.getState().installed[0].ready, true);
  const plist = path.join(source.appPath, "Contents", "Info.plist");
  fs.writeFileSync(plist, fs.readFileSync(plist, "utf8").replace("35.0.0.60", "35.0.0.61"));
  assert.equal(manager.resolveSelection().ready, false);
  const row = manager.getState().installed[0];
  assert.equal(row.ready, false);
  assert.equal(row.removable, false);
  assert.match(row.error, /invalid.*Reinstall MacLauncher/);
});

test("a missing or Intel-only included player reports repair instead of downloading or using Rosetta", t => {
  const missing = Projector.__test.createManager({ appPaths: [] }).resolveSelection();
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /missing.*Reinstall MacLauncher/);
  const source = app(temporary(t), { binary: native(0x01000007) });
  const selection = Projector.__test.createManager({ appPaths: [source.appPath] }).resolveSelection();
  assert.equal(selection.ready, false);
  assert.match(selection.reason, /invalid.*Reinstall MacLauncher/);
});

test("included player refuses an executable that escapes its app bundle", t => {
  const root = temporary(t), source = app(root), outside = path.join(root, "outside-player");
  fs.renameSync(source.executablePath, outside);
  fs.symlinkSync(outside, source.executablePath);
  const manager = Projector.__test.createManager({ appPaths: [source.appPath] });
  assert.equal(manager.getState().installed[0].ready, false);
  assert.match(manager.resolveSelection().reason, /escapes.*Reinstall MacLauncher/);
});
