const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const Live2D = require("../src/modules/renpy/live2d");
const Native = require("../src/modules/renpy/live2d-native");
const Archive = require("../src/modules/renpy/live2d-archive");
const Manager = require("../src/modules/renpy/runtime/sdk-runtime-manager");
const Module = require("../src/modules/renpy/main");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-live2d-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}
function macho(symbols = [], { cpu = 0x0100000c, type = 6 } = {}) {
  const strings = Buffer.from(`\0${symbols.map(name => `_${name}\0`).join("")}`);
  const data = Buffer.alloc(56 + symbols.length * 16 + strings.length);
  data.writeUInt32LE(0xfeedfacf, 0); data.writeUInt32LE(cpu, 4); data.writeUInt32LE(type, 12);
  data.writeUInt32LE(1, 16); data.writeUInt32LE(24, 20);
  data.writeUInt32LE(2, 32); data.writeUInt32LE(24, 36); data.writeUInt32LE(56, 40);
  data.writeUInt32LE(symbols.length, 44); data.writeUInt32LE(56 + symbols.length * 16, 48); data.writeUInt32LE(strings.length, 52);
  let index = 1;
  for (let i = 0; i < symbols.length; i++) { data.writeUInt32LE(index, 56 + i * 16); data[60 + i * 16] = 0x0f; index += Buffer.byteLength(symbols[i]) + 2; }
  strings.copy(data, 56 + symbols.length * 16); return data;
}
function zip(items) {
  const parts = [], entries = []; let offset = 0;
  for (const { name, bytes, mode = 0o100644, corrupt = false } of items) {
    const filename = Buffer.from(name), raw = zlib.deflateRawSync(bytes), crc = Archive.crc32(bytes) ^ (corrupt ? 1 : 0);
    const header = Buffer.alloc(30 + filename.length);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc >>> 0, 14);
    header.writeUInt32LE(raw.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26); filename.copy(header, 30);
    const entry = Buffer.alloc(46 + filename.length); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc >>> 0, 16); entry.writeUInt32LE(raw.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42); filename.copy(entry, 46);
    parts.push(header, raw); entries.push(entry); offset += header.length + raw.length;
  }
  const directory = Buffer.concat(entries), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0); footer.writeUInt16LE(items.length, 8); footer.writeUInt16LE(items.length, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, footer]);
}
function archive(root, version = "5-r.4.1", symbols = Native.requirements("8.5.2").symbols, extra = []) {
  const base = `CubismSdkForNative-${version}`, file = path.join(root, `${version}.zip`);
  fs.writeFileSync(file, zip([{ name: `${base}/Core/dll/macos/libLive2DCubismCore.dylib`, bytes: macho(symbols) }, { name: `${base}/Core/LICENSE.md`, bytes: Buffer.from("Vendor license notice") }, ...extra]));
  return file;
}
function sdk(root, version) {
  const major = Number(version[0]), installDir = path.join(root, "runtimes", "sdk", String(major), version);
  const lib = path.join(installDir, "lib", `py${major === 7 ? 2 : 3}-mac-universal`);
  fs.mkdirSync(lib, { recursive: true }); fs.writeFileSync(path.join(installDir, "renpy.sh"), "fixture"); fs.writeFileSync(path.join(lib, "renpy"), macho([], { type: 2 }), { mode: 0o755 });
  return { version, installDir };
}

test("immutable game imports patch Live2D inside the owned view while source native libraries remain unchanged", async t => {
  const root = fixture(t), game = sdk(root, "8.5.3"), userDataDir = path.join(root, "data");
  fs.mkdirSync(path.join(game.installDir, "game"));
  fs.writeFileSync(path.join(game.installDir, "game/options.rpy"), 'define config.save_directory = ""\n');
  const sourceExecutable = path.join(game.installDir, "lib/py3-mac-universal/renpy"), original = fs.readFileSync(sourceExecutable);
  const sourceStat = fs.statSync(sourceExecutable), entry = { gameId: "immutable-game", moduleId: "renpy", gamePath: game.installDir,
    contentRootDir: game.installDir, containerData: { extractedRoot: game.installDir, key: "fixture" }, moduleData: { version: "8.5.3", major: 8 } };
  const archivePath = archive(root, "5-r.5", Native.requirements("8.5.3").symbols);
  const info = await Module.actions.patchLive2D(entry, { archivePath }, { userDataDir });
  assert.equal(info.ready, true); assert.equal(info.renpyVersion, "8.5.3"); assert.equal(info.version, "5-r.5");
  assert.ok(info.targetPath.startsWith(entry.moduleData.writableInput.root + path.sep));
  assert.equal(entry.contentRootDir, game.installDir);
  assert.equal(fs.existsSync(path.join(game.installDir, "lib/py3-mac-universal/libLive2DCubismCore.dylib")), false);
  assert.deepEqual(fs.readFileSync(sourceExecutable), original);
  assert.deepEqual([fs.statSync(sourceExecutable).mode, fs.statSync(sourceExecutable).mtimeMs, fs.statSync(sourceExecutable).ctimeMs], [sourceStat.mode, sourceStat.mtimeMs, sourceStat.ctimeMs]);
  assert.equal((await Module.actions.removeLive2D(entry, {}, { userDataDir })).removed, true);
  assert.deepEqual(fs.readFileSync(sourceExecutable), original);
});

test("Ren'Py 8.5.3 changes the Core symbol contract; SDK7 and 8.5.2 retain the old API", t => {
  const root = fixture(t), legacy = path.join(root, "legacy.dylib"), modern = path.join(root, "modern.dylib");
  fs.writeFileSync(legacy, macho(Native.requirements("7.8.7").symbols)); fs.writeFileSync(modern, macho(Native.requirements("8.5.3").symbols));
  assert.equal(Native.validateCore(legacy, "8.5.2", ["arm64"]).recommendedVersion, "5-r.4.1");
  assert.equal(Native.validateCore(modern, "8.5.3", ["arm64"]).recommendedVersion, "5-r.5");
  assert.throws(() => Native.validateCore(legacy, "8.5.3", ["arm64"]), /csmGetRenderOrders/);
  assert.throws(() => Native.validateCore(modern, "7.8.7", ["arm64"]), /csmGetDrawableRenderOrders/);
  assert.throws(() => Native.validateCore(modern, "8.5.3", ["x86_64"]), /architecture/);
  assert.throws(() => Native.requirements("unknown"), /explicit/);
});

test("ZIP import validates selected payload checksums and rejects traversal/symlink members", t => {
  const root = fixture(t), file = archive(root);
  assert.equal(Archive.readCubismArchive(file).version, "5-r.4.1");
  assert.throws(() => Archive.readCubismArchive(archive(root, "5-r.5", [], [{ name: "../outside", bytes: Buffer.from("oops") }])), /Unsafe path/);
  assert.throws(() => Archive.readCubismArchive(archive(root, "5-r.5", [], [{ name: "link", bytes: Buffer.from("outside"), mode: 0o120777 }])), /symlink/);
  const bad = path.join(root, "bad.zip"), base = "CubismSdkForNative-5-r.5";
  fs.writeFileSync(bad, zip([{ name: `${base}/Core/dll/macos/libLive2DCubismCore.dylib`, bytes: Buffer.from("changed"), corrupt: true }, { name: `${base}/Core/LICENSE.md`, bytes: Buffer.from("license") }]));
  assert.throws(() => Archive.readCubismArchive(bad), /checksum/);
  assert.throws(() => Archive.readCubismArchive(path.join(root, "missing.zip")), /ENOENT/);
});

test("import preserves an original library and removal restores its exact bytes/mode", t => {
  const root = fixture(t), install = sdk(root, "8.5.2"), target = Live2D.sdkTarget(install), original = Buffer.from("original incompatible library");
  fs.writeFileSync(target.libraryPath, original, { mode: 0o640 });
  assert.equal(Live2D.importLibrary(target, archive(root)).ready, true);
  assert.equal(Live2D.status(target).officialArchive, false);
  assert.equal(Live2D.status(target).owned, true);
  assert.deepEqual(Live2D.removeLibrary(target), { removed: true, restoredOriginal: true, targetPath: target.libraryPath });
  assert.deepEqual(fs.readFileSync(target.libraryPath), original);
  assert.equal(fs.statSync(target.libraryPath).mode & 0o777, 0o640);
  assert.throws(() => Live2D.removeLibrary(target), /No launcher-owned/);
});

test("incompatible imports and changed managed libraries cannot overwrite or remove data", t => {
  const root = fixture(t), target = Live2D.sdkTarget(sdk(root, "8.5.3"));
  assert.throws(() => Live2D.importLibrary(target, archive(root)), /csmGetRenderOrders/);
  assert.equal(fs.existsSync(target.libraryPath), false);
  assert.equal(fs.existsSync(path.join(target.metadataDir, "record.json")), false);
  Live2D.importLibrary(target, archive(root, "5-r.5", Native.requirements("8.5.3").symbols));
  fs.appendFileSync(target.libraryPath, "changed");
  assert.equal(Live2D.status(target).ready, false);
  assert.throws(() => Live2D.removeLibrary(target), /changed/);
  assert.throws(() => Live2D.importLibrary(target, archive(root, "5-r.5", Native.requirements("8.5.3").symbols)), /changed/);
  assert.ok(fs.readFileSync(target.libraryPath).includes(Buffer.from("changed")));
});

test("publication failure rolls the library back and leaves no new install/backup record", t => {
  const root = fixture(t), target = Live2D.sdkTarget(sdk(root, "8.5.2")), original = Buffer.from("original library");
  fs.writeFileSync(target.libraryPath, original); fs.mkdirSync(path.join(target.metadataDir, "LICENSE.md"), { recursive: true });
  assert.throws(() => Live2D.importLibrary(target, archive(root)), /EISDIR|ENOTEMPTY/);
  assert.deepEqual(fs.readFileSync(target.libraryPath), original);
  assert.equal(fs.existsSync(path.join(target.metadataDir, "record.json")), false);
  assert.equal(fs.existsSync(path.join(target.metadataDir, "original.dylib")), false);
});

test("symlinked native library targets and owned directories are refused", t => {
  const root = fixture(t), target = Live2D.sdkTarget(sdk(root, "8.5.2")), outside = path.join(root, "outside");
  fs.writeFileSync(outside, "untouched"); fs.symlinkSync(outside, target.libraryPath);
  assert.throws(() => Live2D.importLibrary(target, archive(root)), /symlinks/);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched"); fs.unlinkSync(target.libraryPath);
  fs.rmSync(target.metadataDir, { recursive: true, force: true }); fs.symlinkSync(root, target.metadataDir);
  assert.throws(() => Live2D.importLibrary(target, archive(root)), /symlinks/);
});

test("SDK row metadata and pure manager actions route imports to the selected major/version only", async t => {
  const root = fixture(t), first = sdk(root, "7.8.7"), second = sdk(root, "8.5.3"), file = archive(root);
  const state = Manager.getState({ userDataDir: root, settings: {} });
  assert.equal(state.v7.installed[0].actions.find(action => action.id === "importLive2D").inputKind, "file");
  await Manager.performInstalledAction({ userDataDir: root, sectionId: "v7", version: "7.8.7", installedActionId: "importLive2D", archivePath: file });
  assert.equal(Live2D.status(Live2D.sdkTarget(first)).ready, true);
  assert.equal(fs.existsSync(Live2D.sdkTarget(second).libraryPath), false);
  await assert.rejects(Manager.performInstalledAction({ userDataDir: root, sectionId: "v8", version: "7.8.7", installedActionId: "importLive2D", archivePath: file }), /not installed/);
  await Manager.performInstalledAction({ userDataDir: root, sectionId: "v7", version: "7.8.7", installedActionId: "removeLive2D" });
  assert.equal(fs.existsSync(Live2D.sdkTarget(first).libraryPath), false);
});

test("cancelled explicit download never publishes a library or completes an install", async t => {
  const root = fixture(t), target = Live2D.sdkTarget(sdk(root, "8.5.2")), controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(Live2D.downloadLibrary(target, { userDataDir: root, signal: controller.signal, dependencies: { downloadToFile: () => { calls++; } } }), { name: "AbortError" });
  assert.equal(calls, 0); assert.equal(fs.existsSync(target.libraryPath), false);
});

test("Play library download consent is requested only for a missing official archive", async t => {
  const root = fixture(t), target = Live2D.sdkTarget(sdk(root, "8.5.3")); let called = 0;
  await assert.rejects(Live2D.downloadLibrary(target, { userDataDir: root, confirmRuntimeInstall: plan => { called++; assert.equal(plan.libraryVersion, "5-r.5"); return false; },
    dependencies: { downloadToFile: () => assert.fail("network after rejection") } }), { name: "AbortError" });
  assert.equal(called, 1); assert.equal(fs.existsSync(target.libraryPath), false);
});

test("game patch uses copied runtime provenance and protects unrelated SDK/global libraries", async t => {
  const root = fixture(t), game = sdk(root, "8.5.3"), userDataDir = path.join(root, "userdata"), gameId = "game-one";
  const metadata = path.join(userDataDir, "games", gameId, "modules", "renpy", "patches"); fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, "patch.json"), JSON.stringify({ sdkVersion: "8.5.3", preexistingMacLib: false }));
  const entry = { gameId, gamePath: game.installDir, moduleData: { version: "7.8.7" } };
  const archivePath = archive(root, "5-r.5", Native.requirements("8.5.3").symbols);
  const info = await Live2D.patchGame(entry, { archivePath }, { userDataDir });
  assert.equal(info.renpyVersion, "8.5.3"); assert.equal(info.version, "5-r.5");
  assert.equal(fs.existsSync(path.join(game.installDir, ".maclauncher-libraries")), false);
  assert.equal(Live2D.removeGame(entry, {}, { userDataDir }).restoredOriginal, false);
  fs.writeFileSync(path.join(metadata, "patch.json"), JSON.stringify({ sdkVersion: "8.5.3", preexistingMacLib: true }));
  await assert.rejects(Live2D.patchGame(entry, { archivePath }, { userDataDir }), /No macOS Ren'Py library/);
});

test("loose model discovery is bounded, skips symlinks and does not execute game scripts", t => {
  const root = fixture(t), game = path.join(root, "game"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "script.rpy"), "raise Exception('must never execute')");
  assert.equal(Live2D.detectModels(game).detected, false);
  fs.writeFileSync(path.join(game, "model.model3.json"), "{}");
  assert.equal(Live2D.detectModels(game).detected, true);
  const sibling = path.join(root, "sibling"); fs.mkdirSync(sibling); fs.symlinkSync(game, path.join(sibling, "link"));
  assert.equal(Live2D.detectModels(sibling).detected, false);
});

test("model discovery reads only primitive RPA metadata without extracting or evaluating payloads", t => {
  const root = fixture(t), name = Buffer.from("models/hiyori.model3.json"), header = Buffer.from("RPA-2.0 0000000000000000\n"), string = Buffer.alloc(5), values = Buffer.alloc(10);
  string[0] = 0x58; string.writeUInt32LE(name.length, 1);
  values[0] = 0x4a; values.writeUInt32LE(header.length, 1); values[5] = 0x4a; values.writeUInt32LE(2, 6);
  const index = Buffer.concat([Buffer.from([0x80, 2]), Buffer.from("}("), string, name, Buffer.from("]("), Buffer.from("("), values, Buffer.from("teu.")]);
  Buffer.from((header.length + 2).toString(16).padStart(16, "0")).copy(header, 8);
  const file = path.join(root, "models.rpa"); fs.writeFileSync(file, Buffer.concat([header, Buffer.from("{}"), zlib.deflateSync(index)]));
  assert.equal(Live2D.detectModels(root).detected, true);
  assert.equal(fs.readdirSync(root).length, 1);
});

test("Play hooks preserve explicit SDK overrides and reuse exact installed SDKs without discovery", async t => {
  const root = fixture(t); sdk(root, "8.5.3");
  const entry = { gamePath: root, moduleData: { major: 8, version: "8.5.3.26051504" } };
  const selected = await Module.ensureRuntime(entry, { runtimeId: "sdk", userDataDir: root, settings: {} });
  assert.equal(selected, null); assert.equal(entry.runtimeData, undefined);
  entry.runtimeData = { sdk: { version: "8.4.1" } };
  assert.equal((await Module.ensureRuntime(entry, { runtimeId: "sdk", userDataDir: root, settings: {} })).version, "8.4.1");
  assert.equal(await Module.ensureRuntime(entry, { runtimeId: "patched", userDataDir: root }), null);
  await assert.rejects(Module.ensureRuntime({ gamePath: root, moduleData: {} }, { runtimeId: "sdk", userDataDir: root }), /major version is unknown/);
});

test("SDK preparation claims its actual Python generation before a Live2D mutation", async t => {
  const root = fixture(t), install = sdk(root, "8.5.3"), game = path.join(root, "game");
  fs.mkdirSync(game); fs.writeFileSync(path.join(game, "model.model3.json"), "{}");
  const events = [], error = Object.assign(new Error("SDK in use"), { code: "RUNTIME_IN_USE" });
  await assert.rejects(Module.prepareLaunch({ gamePath: root, moduleData: { major: 8 }, runtimeData: { sdk: { version: "8.5.3" } } },
    { runtimeId: "sdk", userDataDir: root, settings: { runtimes: { sdk: { v7: { defaultVersion: "7.8.7" }, v8: { defaultVersion: "8.4.1" } } } },
      useRuntime: async identity => events.push({ kind: "use", identity }),
      withRuntimeMutation: async identity => { events.push({ kind: "mutation", identity }); throw error; },
      dependencies: { downloadToFile: () => assert.fail("network before the SDK guard") } }), { code: "RUNTIME_IN_USE" });
  assert.equal(events[0].kind, "use");
  assert.deepEqual(events[0].identity, { managerId: "sdk", version: "8.5.3", sectionId: "v8", sourcePath: install.installDir });
  assert.deepEqual(events[1], { kind: "mutation", identity: { managerId: "sdk", version: "8.5.3" } });
});

test("an active SDK guards automatic Live2D downloads while another generation remains independent", async t => {
  const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
  const { withRuntimeCoordinator, withRuntimeMutation } = require("../src/core/coordinated-runtime-managers");
  const root = fixture(t), legacy = sdk(root, "7.8.7"), modern = sdk(root, "8.5.3");
  const coordinator = createRuntimeCoordinator({ userDataDir: root }), running = coordinator.client(), writer = coordinator.client();
  const token = await running.acquireUse({ managerId: "sdk", version: legacy.version, sectionId: "v7", sourcePath: legacy.installDir });
  await running.bindUse(token, 42); t.after(() => running.release(token));
  let downloads = 0, consent = 0;
  const options = { userDataDir: root,
    withRuntimeMutation: (identity, fn) => withRuntimeCoordinator(writer, root, () => withRuntimeMutation(identity, fn)),
    confirmRuntimeInstall: () => { consent++; return false; }, dependencies: { downloadToFile: () => downloads++ } };
  await assert.rejects(Live2D.ensureSdkLibrary(legacy, options), { code: "RUNTIME_IN_USE" });
  assert.equal(consent, 0); assert.equal(downloads, 0);
  await assert.rejects(Live2D.ensureSdkLibrary(modern, options), { name: "AbortError" });
  assert.equal(consent, 1); assert.equal(downloads, 0);
  assert.equal(fs.existsSync(Live2D.sdkTarget(legacy).libraryPath), false);
  assert.equal(fs.existsSync(Live2D.sdkTarget(modern).libraryPath), false);
});

test("two cold Live2D game preparations publish once and retain independent exact SDK use", async t => {
  const { createRuntimeCoordinator } = require("../src/core/runtime-coordinator");
  const { createRuntimeUseScope, withRuntimeCoordinator, withRuntimeUseScope, withRuntimeMutation } = require("../src/core/coordinated-runtime-managers");
  const root = fixture(t), install = sdk(root, "8.5.3"), zipPath = archive(root, "5-r.5", Native.requirements("8.5.3").symbols);
  const coordinator = createRuntimeCoordinator({ userDataDir: root });
  let releaseReaders, releasePublish, readers = 0, publications = 0;
  const bothReaders = new Promise(resolve => { releaseReaders = resolve; });
  const publishGate = new Promise(resolve => { releasePublish = resolve; });
  const scopes = [];
  const jobs = ["one", "two"].map(name => {
    const gameRoot = path.join(root, name), game = path.join(gameRoot, "game");
    fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(path.join(game, "model.model3.json"), "{}");
    const client = coordinator.client(), scope = createRuntimeUseScope({ coordinator: client, managers: [Manager], userDataDir: root }); scopes.push(scope);
    const context = { runtimeId: "sdk", userDataDir: root, settings: {},
      useRuntime: async identity => { await scope.useRuntime(identity); if (++readers === 2) releaseReaders(); await bothReaders; },
      withRuntimeMutation: (identity, fn) => scope.withMutablePreparation(identity, () => withRuntimeCoordinator(client, root, () =>
        withRuntimeUseScope(scope, () => withRuntimeMutation(identity, fn)))),
      dependencies: { downloadSdkLibrary: async target => {
        publications++; await publishGate;
        // Trusted publisher IO is injected; real ZIP/ABI/provenance handling runs.
        // The synthetic archive is a manual import, not an official vendor digest.
        return Live2D.importLibrary(target, zipPath);
      } }
    };
    return Module.prepareLaunch({ gamePath: gameRoot, moduleData: { major: 8 }, runtimeData: { sdk: { version: "8.5.3" } } }, context);
  });
  t.after(async () => { releaseReaders(); releasePublish(); await Promise.all(scopes.map(scope => scope.release())); });
  const deadline = Date.now() + 5000;
  while (publications === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readers, 2); assert.equal(publications, 1); releasePublish();
  const results = await Promise.all(jobs);
  assert.equal(results.every(result => result.ready), true); assert.equal(publications, 1);
  assert.equal(results.every(result => result.officialArchive === false), true);
  const leases = coordinator.snapshot().active.filter(lease => lease.kind === "use");
  assert.equal(leases.length, 2);
  assert.equal(leases.every(lease => lease.identities[0].version === "8.5.3" && lease.identities[0].sectionId === "v8"), true);
  await scopes[0].bind(42); await scopes[1].bind(43); await scopes[0].release();
  await assert.rejects(coordinator.client().acquireMutation({ managerId: "sdk", version: install.version }), { code: "RUNTIME_IN_USE" });
  await scopes[1].release(); assert.equal(coordinator.snapshot().active.length, 0);
});

test("Auto SDK uses the newest complete Python-generation installation without discovery or pinning", async t => {
  const root = fixture(t); sdk(root, "8.4.1"); const newest = sdk(root, "8.5.3"); sdk(root, "7.8.7");
  const partial = path.join(root, "runtimes/sdk/8/8.9.0"); fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, "renpy.py"), "incomplete");
  const misplaced = path.join(root, "runtimes/sdk/8/7.9.9"); fs.mkdirSync(misplaced, { recursive: true });
  fs.writeFileSync(path.join(misplaced, "renpy.py"), "wrong generation");
  t.mock.method(Manager, "refreshCatalog", () => assert.fail("Ready SDK Auto must remain offline"));
  const entry = { gamePath: root, moduleData: { major: 8, version: "8.4.1" } }, before = structuredClone(entry), claims = [];
  const context = { runtimeId: "sdk", userDataDir: root, settings: { runtimes: { sdk: { v8: { defaultVersion: "8.4.1" } } } },
    useRuntime: identity => claims.push(identity) };
  assert.equal(await Module.ensureRuntime(entry, context), null);
  await Module.prepareLaunch(entry, context);
  assert.deepEqual(entry, before); assert.equal(claims[0].version, newest.version);
  assert.equal(claims[0].sourcePath, newest.installDir);
  const installed = Manager.core.listInstalled(root, 8);
  assert.equal(installed.find(item => item.version === "8.9.0").ready, false);
  assert.equal(installed.some(item => item.version === "7.9.9"), false);
  const legacy = { gamePath: root, moduleData: { major: 7 } };
  assert.equal(await Module.ensureRuntime(legacy, context), null);
});

test("Auto SDK catalog fallback plans a current stable SDK without saving an implicit game pin", async t => {
  const root = fixture(t), calls = [];
  t.mock.method(Manager, "refreshCatalog", async options => { calls.push(options.major); return { versions: ["8.6.1", "8.4.1"], latestStableVersion: "8.6.1" }; });
  const entry = { gamePath: root, moduleData: { major: 8, version: "8.4.1" } }, before = structuredClone(entry);
  const plan = await Module.ensureRuntime(entry, { runtimeId: "sdk", userDataDir: root,
    settings: { runtimes: { sdk: { v8: { defaultVersion: "8.4.1" } } } } });
  assert.deepEqual(plan, { managerId: "sdk", version: "8.6.1", installOptions: { major: 8, sectionId: "v8" } });
  assert.deepEqual(calls, [8]); assert.deepEqual(entry, before);
  entry.moduleData.builtSdkVersion = "8.4.1";
  assert.equal((await Module.ensureRuntime(entry, { runtimeId: "sdk", userDataDir: root, settings: {} })).version, "8.4.1");
  assert.deepEqual(calls, [8]);
});
