// Required first: it replaces the network functions before modules load.
require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Custom = require("../src/modules/shared/runtime/custom-runtime");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");

const CPU = { x64: [0x01000007, 3], arm64: [0x0100000c, 0] };
function command(kind, value) {
  const size = Math.ceil((24 + Buffer.byteLength(value) + 1) / 8) * 8, bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(kind); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(24, 8); bytes.write(value, 24); return bytes;
}
function macho(type = 2, { cpu = "x64", minimum = 13, marker = "" } = {}) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32); build.writeUInt32LE(24, 4);
  build.writeUInt32LE(1, 8); build.writeUInt32LE(minimum << 16, 12); build.writeUInt32LE(27 << 16, 16);
  const commands = [build, command(0xc, "/usr/lib/libSystem.B.dylib")], body = Buffer.concat(commands), bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(CPU[cpu][0], 4); bytes.writeUInt32LE(CPU[cpu][1], 8);
  bytes.writeUInt32LE(type, 12); bytes.writeUInt32LE(commands.length, 16); bytes.writeUInt32LE(body.length, 20);
  body.copy(bytes, 32); bytes.write(marker, 400); return bytes;
}
function write(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode }); return file;
}
function temporary(t, name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
// Every entry of a folder with its kind, size and modification time.
function snapshot(root) {
  const rows = [];
  (function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      rows.push([path.relative(root, file), stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file", stat.size, stat.mtimeMs]);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file);
    }
  })(root);
  return rows;
}
function register(manager, userDataDir, runtimePath) {
  return runRuntimeManagerAction({ manager, action: "registerCustom", payload: { sectionId: "default", runtimePath }, userDataDir,
    readSettings: () => ({}), saveSettings: () => {} });
}
// The release layout of WineCX: Libraries/Wine with the loader under
// lib/wine/x86_64-unix, and its version file beside it.
function winecxTree(root, { minimum = 13, missing } = {}) {
  const wine = path.join(root, "Libraries", "Wine"), unix = path.join(wine, "lib", "wine", "x86_64-unix");
  write(path.join(unix, "wine"), macho(2, { minimum }), 0o755);
  fs.mkdirSync(path.join(wine, "bin"), { recursive: true });
  for (const name of ["wine", "wine64"]) fs.symlinkSync("../lib/wine/x86_64-unix/wine", path.join(wine, "bin", name));
  write(path.join(wine, "bin", "wineserver"), macho(2, { marker: "WINEMSYNC" }), 0o755);
  write(path.join(unix, "ntdll.so"), Buffer.concat([macho(6, { marker: "CX_APPLEGPTK_LIBD3DSHARED_PATH" }), Buffer.from("wine-11.19\0")]));
  if (missing !== "winemac.so") write(path.join(unix, "winemac.so"), macho(6));
  write(path.join(wine, "lib", "wine", "x86_64-windows", "kernel32.dll"), "Windows library");
  write(path.join(root, "Libraries", "DXVK", "x64", "d3d11.dll"), "DXVK");
  write(path.join(root, "Libraries", "WhiskyWineVersion.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>dxvkVersion</key><string>1.10.3</string><key>version</key><dict><key>major</key><integer>4</integer>
<key>minor</key><integer>8</integer><key>patch</key><integer>1</integer></dict></dict></plist>`);
  return path.join(root, "Libraries");
}

test("a WineCX folder the user selects is registered in place, measured like a download and selected as the default", async t => {
  const root = temporary(t, "custom-winecx"), userDataDir = path.join(root, "profile"), libraries = winecxTree(path.join(root, "My WineCX"));
  const manager = require("../src/modules/crossover/winecx/runtime/manager").createManager({ dependencies: { systemVersionSync: () => "26.1" } });
  Custom.instrumentManagers([manager]);
  assert.ok(manager.getState({ userDataDir, componentSummaries: false }).sections.every(section => section.customRuntime), "Runtimes offers Register custom…");
  const before = snapshot(root);
  const registered = await register(manager, userDataDir, libraries);
  assert.equal(registered.version, libraries);
  assert.deepEqual(registered.architectures, ["x86_64"], "the CPU is measured from the native images");
  assert.equal(registered.minimumMacOS, "13.0.0");
  assert.equal(registered.wineVersion, "11.19");
  assert.deepEqual(registered.componentVersions, { dxvk: "1.10.3" });
  assert.equal(registered.executablePath, path.join(libraries, "Wine", "bin", "wine"));
  const settings = { runtimes: { winecx: manager.applySettingsUpdate("setDefault", { sectionId: "default", version: libraries }, {}) } };
  const selected = manager.resolveSelection({}, settings, userDataDir);
  assert.equal(selected.ready, true);
  assert.equal(selected.install.librariesRoot, libraries);
  assert.equal(selected.install.serverPath, path.join(libraries, "Wine", "bin", "wineserver"));
  assert.equal(manager.getState({ userDataDir, settings: settings.runtimes.winecx, componentSummaries: false }).installed
    .find(row => row.version === libraries)?.ready, true, "the registration is listed as ready");
  assert.deepEqual(snapshot(root).filter(row => !row[0].startsWith("profile")), before, "nothing in the selected folder is written or moved");
  // A file inside the folder names the same Libraries folder.
  assert.equal((await register(manager, userDataDir, path.join(libraries, "Wine", "bin", "wineserver"))).librariesRoot, libraries);
});

test("a custom WineCX folder without its required native files or above this macOS is refused", async t => {
  const root = temporary(t, "custom-winecx-refused"), userDataDir = path.join(root, "profile");
  const manager = require("../src/modules/crossover/winecx/runtime/manager").createManager({ dependencies: { systemVersionSync: () => "26.1" } });
  Custom.instrumentManagers([manager]);
  await assert.rejects(register(manager, userDataDir, winecxTree(path.join(root, "incomplete"), { missing: "winemac.so" })), /missing its native Wine components/);
  await assert.rejects(register(manager, userDataDir, winecxTree(path.join(root, "newer"), { minimum: 27 })), /Requires macOS 27 or later/);
  await assert.rejects(register(manager, userDataDir, fs.mkdirSync(path.join(root, "empty"), { recursive: true }) || path.join(root, "empty")), /complete WineCX folder/);
  assert.deepEqual(Custom.forManager(manager).records(userDataDir), [], "nothing was registered");
});

// A publisher-signed Wine application: its loaders sit in bundles holding a
// provisioning profile, and its tools folder links to MacOS.
function signedApplication(root) {
  const contents = path.join(root, "MetalSharp Wine.app", "Contents"), unix = path.join(contents, "lib", "wine", "aarch64-unix");
  write(path.join(contents, "MacOS", "wine"), macho(2, { cpu: "arm64" }), 0o755);
  write(path.join(contents, "MacOS", "wineserver"), macho(2, { cpu: "arm64", marker: "WINEMSYNC" }), 0o755);
  write(path.join(unix, "ntdll.so"), macho(6, { cpu: "arm64" }));
  write(path.join(unix, "wine.app", "Contents", "MacOS", "wine"), macho(2, { cpu: "arm64" }), 0o755);
  for (const bundle of [contents, path.join(unix, "wine.app", "Contents")]) write(path.join(bundle, "embedded.provisionprofile"), "profile");
  write(path.join(contents, "_CodeSignature", "CodeResources"), "seal");
  write(path.join(contents, "share", "assets", "libfmod.dylib"), macho(6, { cpu: "x64" }));
  fs.symlinkSync("wine.app/Contents/MacOS/wine", path.join(unix, "wine"));
  fs.symlinkSync("MacOS", path.join(contents, "bin"));
  return path.dirname(contents);
}

test("a signed Wine application the user selects is registered with its seal intact and runs its own loader", async t => {
  const root = temporary(t, "custom-signed-wine"), userDataDir = path.join(root, "profile"), app = signedApplication(path.join(root, "Applications"));
  const manager = require("../src/runtime-adapters/wine-release").createManager("metalsharp-wine", { dependencies: { systemVersionSync: () => "26.1" } });
  Custom.instrumentManagers([manager]);
  const before = snapshot(path.join(root, "Applications"));
  const registered = await register(manager, userDataDir, app);
  assert.deepEqual(registered.architectures, ["arm64"], "the application's own share files do not decide its CPU");
  assert.equal(registered.wineRoot, path.join(app, "Contents"));
  assert.equal(registered.executablePath, path.join(app, "Contents", "MacOS", "wine"));
  const selected = manager.resolveSelection({}, {}, userDataDir, { version: app });
  assert.equal(selected.ready, true);
  assert.equal(require("../src/modules/crossover/sources/wine-graphics").publisherSigned(selected.install), true, "the launch links the publisher's loader bundles");
  assert.deepEqual(snapshot(path.join(root, "Applications")), before, "the signed application is not modified");
});

test("a custom Wine that runs through another application's loader is accepted only when it reaches that loader", async t => {
  const root = temporary(t, "custom-highball"), userDataDir = path.join(root, "profile"), applications = path.join(root, "Applications");
  const engine = path.join(root, "engine"), unix = path.join(engine, "lib", "wine", "aarch64-unix");
  write(path.join(engine, "bin", "wineserver"), macho(2, { cpu: "arm64" }), 0o755);
  write(path.join(engine, "bin", "wine"), macho(2, { cpu: "arm64" }), 0o755);
  write(path.join(unix, "ntdll.so"), macho(6, { cpu: "arm64" }));
  const manager = require("../src/runtime-adapters/wine-release").createManager("highball-wine", { dependencies: { systemVersionSync: () => "26.1", applicationDirectories: [applications] } });
  Custom.instrumentManagers([manager]);
  await assert.rejects(register(manager, userDataDir, engine), /runs through Highball, which is not installed/);
  const loader = write(path.join(applications, "Highball.app/Contents/Helpers/WineLoader.app/Contents/MacOS/wine"), macho(2, { cpu: "arm64" }), 0o755);
  await assert.rejects(register(manager, userDataDir, engine), /does not reach its application's Wine loader/);
  fs.symlinkSync(loader, path.join(unix, "wine"));
  const registered = await register(manager, userDataDir, engine);
  assert.equal(registered.ready, true);
  assert.deepEqual(registered.architectures, ["arm64"]);
});
