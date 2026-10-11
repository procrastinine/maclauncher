const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Haxe = require("../src/modules/haxe/main");
const { LIMITS } = require("../src/modules/haxe/detect");
const { LIMITS: PE_LIMITS, readPeExports } = require("../src/modules/shared/runtime/pe-exports");
const Detection = require("../src/modules/detection");
const Registry = require("../src/modules/registry");
const { canLaunchEntry } = require("../src/core/launch-capability");
const { createLauncher } = require("../src/core/launcher");
const { createGameMetadataService } = require("../src/core/game-metadata");
const GameStore = require("../src/core/game-store");

// Synthetic PE metadata only. No game code or executable fixture is run.
function peImage({ architecture = "x86_64", dll = false, exports = [], strings = "", stringsOffset = 0x800, rdataSize = 0x1000 } = {}) {
  const pe = 0x80, optionalSize = architecture === "x86" ? 224 : 240;
  const optional = pe + 24, directories = optional + (architecture === "x86" ? 96 : 112);
  const sectionTable = optional + optionalSize, data = Buffer.alloc(0x600 + rdataSize);
  data.write("MZ"); data.writeUInt32LE(pe, 60); data.writeUInt32LE(0x4550, pe);
  data.writeUInt16LE({ x86: 0x14c, x86_64: 0x8664, arm64: 0xaa64 }[architecture], pe + 4);
  data.writeUInt16LE(2, pe + 6); data.writeUInt16LE(optionalSize, pe + 20);
  data.writeUInt16LE(2 | (dll ? 0x2000 : 0), pe + 22);
  data.writeUInt16LE(architecture === "x86" ? 0x10b : 0x20b, optional);
  data.writeUInt32LE(16, directories - 4);
  for (const [i, name, rva, offset, size, flags] of [
    [0, ".text", 0x1000, 0x400, 0x200, 0x60000020],
    [1, ".rdata", 0x2000, 0x600, rdataSize, 0x40000040]
  ]) {
    const header = sectionTable + i * 40;
    data.write(name, header); data.writeUInt32LE(size, header + 8);
    data.writeUInt32LE(rva, header + 12); data.writeUInt32LE(size, header + 16);
    data.writeUInt32LE(offset, header + 20); data.writeUInt32LE(flags, header + 36);
  }
  const count = exports.length, addresses = 0x640, names = addresses + count * 4, ordinals = names + count * 4;
  let nextString = ordinals + count * 2;
  if (count) {
    data.writeUInt32LE(0x2000, directories);
    data.writeUInt32LE(count, 0x600 + 20); data.writeUInt32LE(count, 0x600 + 24);
    data.writeUInt32LE(addresses - 0x600 + 0x2000, 0x600 + 28);
    data.writeUInt32LE(names - 0x600 + 0x2000, 0x600 + 32);
    data.writeUInt32LE(ordinals - 0x600 + 0x2000, 0x600 + 36);
    exports.forEach((exported, i) => {
      const { name, kind = "code" } = typeof exported === "string" ? { name: exported } : exported;
      data.writeUInt32LE(kind === "code" ? 0x1010 + i * 8 : kind === "forwarded" ? 0x2040 : 0x2800, addresses + i * 4);
      data.writeUInt32LE(nextString - 0x600 + 0x2000, names + i * 4);
      data.writeUInt16LE(i, ordinals + i * 2); data.write(name + "\0", nextString);
      nextString += Buffer.byteLength(name) + 1;
    });
    data.writeUInt32LE(nextString - 0x600, directories + 4);
  }
  data.write(strings, 0x600 + stringsOffset);
  return { data, offsets: { pe, optional, directories, sectionTable, addresses, names, ordinals } };
}

const limeExports = ["hx_set_loader", "lime_application_create__0", "lime_window_create__prime", "__neko_entry_point", "hl_application_create"];
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-haxe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function game(t, { architecture = "x86_64", main = {}, lime = {}, limeName = "lime.ndll" } = {}) {
  const root = temporary(t), executable = path.join(root, "sample.exe"), library = path.join(root, limeName);
  fs.writeFileSync(executable, peImage({ architecture, exports: ["hx_cffi"], strings: "openfl.display.Sprite\0", ...main }).data);
  fs.writeFileSync(library, peImage({ architecture, dll: true, exports: limeExports,
    strings: "hxcpp/4,1,15/include/hx/CFFINekoLoader.h\0", ...lime }).data);
  return { root, executable, library };
}
function detect(input) {
  const session = Detection.createDetectionSession(input);
  return { result: Haxe.detectGame(session.context, session.helpers), session };
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("PE exports distinguish actual code, data and forwarded symbols across CPU types", t => {
  const root = temporary(t);
  for (const architecture of ["x86", "x86_64", "arm64"]) {
    const file = path.join(root, architecture + ".exe");
    fs.writeFileSync(file, peImage({ architecture, exports: ["host", { name: "data", kind: "data" }, { name: "forward", kind: "forwarded" }] }).data);
    const image = readPeExports(file);
    assert.equal(image.architecture, architecture); assert.equal(image.isDll, false);
    assert.equal(image.exports.get("host").executable, true);
    assert.equal(image.exports.get("data").executable, false);
    assert.deepEqual(image.exports.get("forward"), { rva: 0x2040, forwarded: true, executable: false });
    assert.ok(image.bytesRead < 8192);
  }
});

test("PE export inspection rejects corrupt tables, oversized metadata and truncated files", t => {
  const root = temporary(t), file = path.join(root, "broken.exe");
  for (const corrupt of [
    ({ data }) => data.subarray(0, 128),
    ({ data, offsets }) => { data.writeUInt32LE(PE_LIMITS.exportBytes + 1, offsets.directories + 4); return data; },
    ({ data, offsets }) => { data.writeUInt16LE(1, offsets.ordinals); return data; },
    ({ data, offsets }) => { data.writeUInt32LE(0xffffffff, offsets.names); return data; },
    ({ data }) => { data.writeUInt32LE(PE_LIMITS.exportNames + 1, 0x618); return data; },
    ({ data, offsets }) => { data.writeUInt32LE(data.length, offsets.sectionTable + 20); return data; },
    ({ data, offsets }) => { data.writeUInt16LE(0x10b, offsets.optional); return data; },
    ({ data, offsets }) => { data.writeUInt16LE(0x9999, offsets.pe + 4); return data; },
    ({ data, offsets }) => { data.writeUInt16LE(0, offsets.pe + 22); return data; }
  ]) {
    fs.writeFileSync(file, corrupt(peImage({ exports: ["hx_cffi"] })));
    assert.equal(readPeExports(file), null);
  }
  fs.writeFileSync(file, peImage({ exports: ["same", "same"] }).data);
  assert.equal(readPeExports(file), null);
  fs.writeFileSync(file, peImage().data);
  assert.equal(readPeExports(file).exports.size, 0);
});

test("Haxe native imports preserve the target, CPU and reported support-library version", t => {
  for (const architecture of ["x86", "x86_64", "arm64"]) {
    const f = game(t, { architecture }), { result } = detect(f.executable);
    assert.equal(result.moduleId, "haxe"); assert.equal(result.gamePath, f.executable);
    assert.equal(result.contentRootDir, f.root); assert.equal(result.runtimeId, "inspection");
    assert.equal(result.moduleData.compileTarget, "Windows C++ (hxcpp)");
    assert.equal(result.moduleData.framework, "OpenFL / Lime"); assert.equal(result.moduleData.architecture, architecture);
    assert.equal(result.moduleData.detectedVersion, "hxcpp 4.1.15");
    assert.equal(result.moduleData.versionKind, "C++ support library");
    assert.equal(result.moduleData.detectedVersionConfidence, "reported");
    assert.match(result.moduleData.compatibility, /cannot run natively on macOS/);
    assert.equal(JSON.stringify(result).includes("CFFINekoLoader.h"), false);
  }
});

test("native classification requires executable hxcpp host and Lime CFFI exports with matching CPU", t => {
  for (const options of [
    { main: { exports: [] } },
    { main: { exports: ["__neko_entry_point", "hl_application_create"] } },
    { main: { exports: [{ name: "hx_cffi", kind: "data" }] } },
    { main: { exports: [{ name: "hx_cffi", kind: "forwarded" }] } },
    { main: { dll: true } },
    { lime: { architecture: "x86" } },
    { lime: { dll: false } },
    { lime: { exports: ["hx_set_loader", "lime_application_create__0"] } },
    { lime: { exports: limeExports.map(name => ({ name, kind: "data" })) } }
  ]) {
    const f = game(t, options);
    assert.equal(detect(f.executable).result, null, JSON.stringify(options));
  }
});

test("Haxe class strings and shared Neko/HashLink adapters do not prove a portable program", t => {
  const f = game(t, { main: { exports: ["__neko_entry_point"], strings: "openfl.display.Sprite\0haxe.Timer\0HLB\0NEKO\0" } });
  assert.equal(detect(f.executable).result, null);
  const HashLink = require("../src/modules/hashlink/main");
  const session = Detection.createDetectionSession(f.executable);
  assert.equal(HashLink.detectGame(session.context, session.helpers), null);
  assert.equal(detect(f.library).result, null);
});

test("a selected genuine HashLink program remains separate from adjacent native C++ builds", async t => {
  const f = game(t), bytecode = path.join(f.root, "portable.hl");
  // HLB5 serialized metadata: void + zero-argument function types, no natives.
  fs.writeFileSync(bytecode, Buffer.concat([Buffer.from([72, 76, 66, 5, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0]),
    Buffer.alloc(8), Buffer.from([0, 10, 0, 0])]));
  const report = await Registry.explainDetectionAsync(bytecode);
  assert.equal(report.selectedModuleId, "hashlink");
  assert.equal(report.detected.moduleData.bytecodePath, bytecode);
  assert.equal(report.detected.moduleData.bytecodeVersion, 5);
  assert.equal(report.trace.some(row => row.moduleId === "haxe" && row.outcome === "matched"), false);
});

test("companion and candidate gates avoid binary reads for unrelated or oversized directories", t => {
  const root = temporary(t), input = path.join(root, "sample.exe");
  fs.writeFileSync(input, peImage({ exports: ["hx_cffi"] }).data);
  const missing = detect(input);
  assert.equal(missing.result, null); assert.equal(missing.session.metrics.reads, 0);
  fs.writeFileSync(path.join(root, "lime.ndll"), peImage({ dll: true, exports: limeExports }).data);
  for (let i = 0; i < LIMITS.candidates; i++) fs.writeFileSync(path.join(root, `extra-${i}.exe`), "MZ");
  const excessive = detect(root);
  assert.equal(excessive.result, null); assert.equal(excessive.session.metrics.reads, 0);
});

test("case variants work, while duplicate companions, symlinks and app bundles do not classify", t => {
  const f = game(t, { limeName: "LIME.NDLL" });
  assert.equal(detect(f.executable).result.moduleId, "haxe");
  const session = Detection.createDetectionSession(f.executable);
  const helpers = { ...session.helpers, readdir: () => [
    { name: "LIME.NDLL", isFile: () => true }, { name: "lime.ndll", isFile: () => true }
  ] };
  assert.equal(Haxe.detectGame(session.context, helpers), null);
  const target = path.join(f.root, "actual.ndll"); fs.renameSync(f.library, target); fs.symlinkSync(target, f.library);
  assert.equal(detect(f.executable).result, null); assert.equal(readPeExports(f.library), null);
  assert.equal(Haxe.detectGame({ ...session.context, isAppBundle: true }, session.helpers), null);
});

test("multiple matching native games are ambiguous, while selecting an executable is explicit", t => {
  const f = game(t), second = path.join(f.root, "second.exe");
  assert.equal(detect(f.root).result.gamePath, f.executable);
  fs.copyFileSync(f.executable, second);
  assert.equal(detect(f.root).result, null);
  const report = Detection.explainDetection(f.root, [Haxe]);
  assert.equal(report.error.code, "DETECTION_CONFLICT"); assert.equal(report.candidates.length, 2);
  assert.equal(detect(second).result.gamePath, second);
});

test("bounded metadata windows leave unavailable framework/build versions unknown", t => {
  const f = game(t, { main: { rdataSize: 512 * 1024, stringsOffset: LIMITS.strings + 64 },
    lime: { rdataSize: 512 * 1024, stringsOffset: LIMITS.strings + 64 } });
  const { result, session } = detect(f.executable);
  assert.equal(result.moduleData.framework, "Lime"); assert.equal(result.moduleData.hxcppVersion, null);
  assert.equal(result.moduleData.detectedVersion, undefined);
  assert.ok(session.metrics.bytesRead < 2 * LIMITS.strings + 8192);
  assert.equal(session.metrics.archiveListings, 0); assert.equal(session.metrics.workersStarted, 0);
});

test("PE/string reads share session caches and changed library metadata is seen in a fresh session", t => {
  const f = game(t), first = detect(f.executable), reads = first.session.metrics.reads;
  assert.equal(Haxe.detectGame(first.session.context, first.session.helpers).moduleData.hxcppVersion, "4.1.15");
  assert.equal(first.session.metrics.reads, reads); assert.ok(first.session.metrics.cacheHits > 0);
  fs.writeFileSync(f.library, peImage({ dll: true, exports: limeExports, strings: "hxcpp/4.2.0/include/hx/CFFILoader.h\0" }).data);
  assert.equal(detect(f.executable).result.moduleData.hxcppVersion, "4.2.0");
});

test("native metadata respects the shared detection budget without disguising it as no match", t => {
  const f = game(t), session = Detection.createDetectionSession(f.executable, { maxReadBytes: 100 });
  assert.throws(() => Haxe.detectGame(session.context, session.helpers), error => error.code === "DETECTION_LIMIT");
});

test("the automatic module registry imports native Haxe builds without offering a fake player", async t => {
  const f = game(t), userDataDir = temporary(t), before = [digest(f.executable), digest(f.library)];
  const report = await Registry.explainDetectionAsync(f.executable, { workerMode: "inline" });
  assert.equal(report.selectedModuleId, "haxe"); assert.equal(report.versions[0].certainty, "reported");
  const launcher = createLauncher({ userDataDir, spawn: () => assert.fail("Native Windows code must not be spawned") });
  const entry = await launcher.resolveEntry(f.executable, { detectionReport: report });
  assert.equal(GameStore.readGameRecord(userDataDir, entry.gameId).moduleId, "haxe");
  assert.equal(canLaunchEntry({ mod: Haxe, info: Registry.getModuleInfo("haxe"), entry, runtimeId: entry.runtimeId }), false);
  await assert.rejects(launcher.launchEntry(entry), /cannot launch/);
  await assert.rejects(Haxe.launchRuntime("inspection", entry, {}), /Windows Haxe C\+\+ code/);
  assert.deepEqual(Haxe.runtimeManagers, []); assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
  assert.deepEqual([digest(f.executable), digest(f.library)], before);
});

test("persistent Haxe imports reuse detection and icons, then invalidate changed CFFI metadata", async t => {
  const f = game(t), userDataDir = temporary(t);
  let detections = 0;
  const registry = { ...Registry, listModuleIds: () => ["haxe"], listModules: () => [Registry.getModuleInfo("haxe")],
    async detectGameAsync(input) {
      detections++;
      return Detection.resultOrThrow(await Detection.explainDetectionAsync(input, [Haxe], { workerMode: "inline" }));
    }
  };
  const settings = {}, service = createGameMetadataService({ userDataDir, registry });
  const first = await service.importEntry(f.executable, settings); GameStore.writeGameRecord(userDataDir, first);
  assert.equal(first.iconSource, "module-default"); assert.equal(first.moduleData.hxcppVersion, "4.1.15");
  const second = await service.importEntry(f.executable, settings);
  const restarted = createGameMetadataService({ userDataDir, registry });
  const third = await restarted.refreshEntry(second, settings);
  assert.equal(detections, 1); assert.equal(third.iconPath, first.iconPath); assert.equal(third.gameId, first.gameId);
  const stat = fs.statSync(f.library);
  fs.writeFileSync(f.library, peImage({ dll: true, exports: limeExports, strings: "hxcpp/4.2.0/include/hx/CFFILoader.h\0" }).data);
  fs.utimesSync(f.library, stat.atime, stat.mtime);
  const changed = await restarted.refreshEntry(third, settings);
  assert.equal(detections, 2); assert.equal(changed.moduleData.hxcppVersion, "4.2.0");
});
