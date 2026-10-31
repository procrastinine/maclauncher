const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { settingsFile, archive, game } = require("./helpers/unity-assets");
const Detect = require("../src/modules/unity/detect");
const Graphics = require("../src/modules/unity/graphics");
const Launch = require("../src/modules/unity/launch");
const Saves = require("../src/modules/unity/save-location");
const SharedManaged = require("../src/modules/shared/runtime/managed-assembly");
const Providers = require("../src/modules/shared/runtime/providers");
const { resolveRuntimeSupportForEntry } = require("../src/core/launch-capability");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "unity-module-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function context(root, file = root) { return { rootDir: root, inputPath: file, stat: fs.statSync(file) }; }
// A minimal x64 Windows GUI executable, the record the Windows runtimes read.
function windowsExecutable(file) {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt16LE(2, 220); fs.writeFileSync(file, bytes);
}

test("Unity detects exact versions from Windows, Linux and compressed-container structure", t => {
  const root = temporary(t), a = path.join(root, "windows"), b = path.join(root, "linux"); fs.mkdirSync(a); fs.mkdirSync(b);
  const win = game(a, { bundled: true }), linux = game(b, { linux: true });
  for (const input of [context(a), context(a, win.file), context(b), context(b, linux.file)]) {
    const entry = Detect.detectGame(input);
    assert.equal(entry.moduleId, "unity"); assert.equal(entry.moduleData.detectedVersion, "2020.1.17f1");
    assert.equal(entry.moduleData.detectedVersionConfidence, "exact"); assert.equal(entry.moduleData.scriptingBackend, "mono");
    assert.equal(entry.moduleData.graphics.status, "native-renderer-present"); assert.deepEqual(entry.moduleData.graphics.graphicsAPIs, [17]);
  }
  const crash = path.join(a, "UnityCrashHandler64.exe"); fs.copyFileSync(win.file, crash);
  assert.equal(Detect.detectGame(context(a, crash)), null);
  const linux32 = path.join(b, "Game.x86"); fs.renameSync(linux.file, linux32);
  assert.equal(Detect.detectGame(context(b)).gamePath, linux32);
  assert.equal(Detect.detectGame(context(b, linux32)).moduleData.detectedVersion, "2020.1.17f1");
});

test("Unity rejects name-only markers, malformed sizes and unsupported runtime strings", t => {
  const root = temporary(t), fixture = game(root);
  const bytes = fs.readFileSync(path.join(fixture.data, "globalgamemanagers"));
  bytes.writeUInt32BE(100000, 4); fs.writeFileSync(path.join(fixture.data, "globalgamemanagers"), bytes);
  assert.equal(Detect.detectGame(context(root)), null);
  assert.equal(Detect.parseAssetVersion(Buffer.from("Unity 2020.1.17f1"), 20), null);
  const packed = archive(settingsFile()); packed.writeBigUInt64BE(1n, packed.indexOf(Buffer.from("2020.1.17f1\0")) + 12);
  assert.equal(Detect.parseAssetVersion(packed, packed.length), null);
});

test("Unity separates IL2CPP native-code and Direct3D shader blockers before installation", t => {
  const root = temporary(t), direct3d = path.join(root, "direct3d"), native = path.join(root, "native"); fs.mkdirSync(direct3d); fs.mkdirSync(native);
  game(direct3d, { apis: [2, 18] }); game(native, { il2cpp: true });
  const win = Detect.detectGame(context(direct3d)), cpp = Detect.detectGame(context(native));
  assert.equal(win.moduleData.compatibility, "Runs in a Windows runtime (Direct3D 11 and Direct3D 12 shaders)");
  assert.throws(() => Launch.preflight(win), error => error.message === "This build has shaders only for Direct3D 11 and Direct3D 12, and the Mac Mono player needs Metal or OpenGL shaders. " +
    "Its Windows executable runs in a Windows runtime, which translates Direct3D to Metal or Vulkan.");
  assert.equal(cpp.moduleData.scriptingBackend, "il2cpp"); assert.equal(cpp.moduleData.compatibility, "Runs in a Windows runtime (IL2CPP code)");
  assert.throws(() => Launch.preflight(cpp), /IL2CPP compiled this game's code .* Its Windows executable runs in a Windows runtime\.$/);
});

test("Unity names the shader APIs a build has and mentions a Windows runtime only for a Windows executable", t => {
  const root = temporary(t), linux = path.join(root, "linux"), vulkan = path.join(root, "vulkan"); fs.mkdirSync(linux); fs.mkdirSync(vulkan);
  game(linux, { linux: true, apis: [21, 11] }); game(vulkan, { apis: [21] });
  const elf = Detect.detectGame(context(linux)), exe = Detect.detectGame(context(vulkan));
  assert.equal(elf.moduleData.compatibility, "Shaders only for Vulkan and OpenGL ES 3");
  assert.throws(() => Launch.preflight(elf), error => error.message === "This build has shaders only for Vulkan and OpenGL ES 3, and the Mac Mono player needs Metal or OpenGL shaders.");
  assert.doesNotMatch(elf.moduleData.graphics.reason, /Direct3D|Windows/);
  assert.equal(exe.moduleData.compatibility, "Runs in a Windows runtime (Vulkan shaders)");
  assert.throws(() => Launch.preflight(exe), error => !/Direct3D/.test(error.message) && error.message.endsWith(" Its Windows executable runs in a Windows runtime."));
  assert.deepEqual(Detect.macPlayerBlocker({ scriptingBackend: "mono", graphics: { status: "native-renderer-present" }, windowsApis: ["System.Windows.Forms"] }, "/Game.x86_64"),
    { label: "Uses Windows desktop APIs", reason: "This game's Mono code uses Windows desktop APIs that the Mac Mono player does not provide." });
  assert.equal(Detect.macPlayerBlocker({ scriptingBackend: "mono", graphics: { status: "native-renderer-present" }, windowsApis: [] }, "/Game.exe"), null);
});

test("a Unity game the Mac player cannot run is offered the Windows runtimes and not the Unity player", t => {
  const root = temporary(t), userDataDir = path.join(root, "data");
  const providers = Providers.listRuntimeProviders([require("../src/modules/crossover/main")]);
  const Unity = Providers.composeRuntimeProviders(require("../src/modules/unity/main"), providers);
  const offered = (name, options = {}) => {
    const directory = path.join(root, name); fs.mkdirSync(directory);
    const source = game(directory, options); if (!options.linux) windowsExecutable(source.file);
    const entry = Providers.decorateRuntimeEntry(Detect.detectGame(context(directory)), providers);
    return { entry, supported: resolveRuntimeSupportForEntry(Unity, Unity.manifest, entry, {}, { userDataDir }) };
  };
  const mono = offered("mono");
  assert.ok(mono.supported.includes("unity") && mono.supported.includes("sikarugir"), mono.supported.join());
  assert.equal(Unity.canLaunchRuntime("unity", mono.entry, {}, { userDataDir }), true);
  assert.deepEqual(Unity.runtimeRecommendation(mono.entry), { version: "2020.1.17f1", sectionId: "default" });
  for (const options of [{ apis: [2, 18] }, { il2cpp: true }]) {
    const blocked = offered(options.il2cpp ? "il2cpp" : "direct3d", options);
    assert.equal(blocked.supported.includes("unity"), false, blocked.supported.join());
    assert.equal(blocked.supported.includes("sikarugir"), true, blocked.supported.join());
    assert.equal(Unity.canLaunchRuntime("unity", blocked.entry, {}, { userDataDir }), false);
    assert.equal(Unity.runtimeRecommendation(blocked.entry), null);
  }
  const linux = offered("linux", { linux: true, apis: [21] });
  assert.deepEqual(linux.supported.filter(runtimeId => ["unity", "sikarugir", "crossover"].includes(runtimeId)), []);
});

test("Unity inspects native imports without invoking game code", t => {
  const root = temporary(t); game(root, { nativeImports: [{ library: "GameInputNative", name: "Initialize" }] });
  const entry = Detect.detectGame(context(root)); assert.deepEqual(entry.moduleData.nativeImports, ["GameInputNative"]);
  assert.equal(entry.moduleData.managedAssemblies[0].assemblyName, "Assembly-CSharp");
  assert.equal(SharedManaged, require("../src/modules/fna/managed-assembly"));
});

test("Unity LZ4/archive reads reject escaping matches and oversized metadata", () => {
  assert.equal(Graphics.lz4Block(Buffer.from([0x40, 65, 66, 67, 68]), 4).toString(), "ABCD");
  assert.equal(Graphics.lz4Block(Buffer.from([0x10, 65, 1, 0]), 5).toString(), "AAAAA");
  assert.throws(() => Graphics.lz4Block(Buffer.from([0, 0, 0]), 4), /match escapes/);
  assert.throws(() => Graphics.lz4Block(Buffer.from([0x40, 65]), 4), /literal escapes/);
  const bytes = archive(settingsFile()); const stringsEnd = bytes.indexOf(Buffer.from("2020.1.17f1\0")) + 12;
  bytes.writeUInt32BE(Graphics.LIMITS.metadata + 1, stringsEnd + 12);
  assert.throws(() => Graphics.archiveMember({ size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) }, "globalgamemanagers"), /metadata exceeds/);
});

test("Unity chooses only a renderer that the original build contains", () => {
  assert.deepEqual(Launch.rendererArguments({ graphics: { nativeGraphicsAPIs: [17] } }), ["-force-glcore"]);
  assert.deepEqual(Launch.rendererArguments({ graphics: { nativeGraphicsAPIs: [16, 17] } }), ["-force-metal"]);
  assert.throws(() => Launch.rendererArguments({ graphics: { nativeGraphicsAPIs: [17] } }, { renderer: "metal" }), /does not include Metal/);
});

test("Unity save discovery uses per-game company/product roots and creates nothing", t => {
  const root = temporary(t), entry = { moduleData: { companyName: "Company", productName: "Product" } };
  const location = Saves.resolveSaveLocations(entry, { homeDir: root });
  assert.equal(location.primaryDirectory, path.join(root, "Library", "Application Support", "Company", "Product"));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(Saves.resolveSaveLocations({ moduleData: { companyName: "../Library", productName: "Product" } }, { homeDir: root }).directories, []);
  assert.ok(location.directories.every(item => !item.directory.endsWith("Preferences")));
});

test("legacy Unity company/product names come from a bounded PlayerSettings object", () => {
  const bytes = Buffer.alloc(160), offset = 32;
  bytes.writeInt32LE(4, offset + 4); bytes.writeInt32LE(2, offset + 8); bytes.writeInt32LE(60, offset + 16);
  let at = offset + 20;
  for (const text of ["Creator", "The Game!"]) {
    const encoded = Buffer.from(text); bytes.writeInt32LE(encoded.length, at); encoded.copy(bytes, at + 4);
    at = Math.ceil((at + 4 + encoded.length) / 4) * 4;
  }
  const parsed = { version: "5.3.2p3", little: true, objects: [{ classId: 129, offset, size: 100 }] };
  assert.deepEqual(Graphics.playerSettingsIdentity(bytes, parsed), { companyName: "Creator", productName: "The Game!", source: "PlayerSettings serialized object" });
  assert.equal(Graphics.playerSettingsIdentity(bytes, { ...parsed, version: "2020.1.17f1" }), null);
  bytes.writeInt32LE(99999, offset + 20); assert.equal(Graphics.playerSettingsIdentity(bytes, parsed), null);
});

