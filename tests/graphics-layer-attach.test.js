const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLauncher } = require("../src/core/launcher");

// A Wine laid out as MetalSharp Wine: an application whose Unix loader has a bundle of its own.
function wineFixture(t, { signed }) {
  const { image, X64 } = require("./fixtures/macho-image");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-layer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, bytes = "fixture") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const contents = path.join(root, "Sample.app", "Contents"), unix = path.join(contents, "lib", "wine", "x86_64-unix");
  put(path.join(contents, "MacOS", "wine"), image({ cpu: X64, fileType: 2 })); put(path.join(contents, "MacOS", "wineserver"), image({ cpu: X64, fileType: 2 }));
  put(path.join(unix, "ntdll.so"), image({ cpu: X64 }));
  const loader = put(path.join(unix, "wine.app", "Contents", "MacOS", "wine"), image({ cpu: X64, fileType: 2 }));
  fs.symlinkSync("wine.app/Contents/MacOS/wine", path.join(unix, "wine"));
  if (signed) for (const bundle of [contents, path.join(unix, "wine.app", "Contents")]) put(path.join(bundle, "embedded.provisionprofile"));
  return { loader, install: { engineRoot: contents, executablePath: path.join(contents, "MacOS", "wine"), serverPath: path.join(contents, "MacOS", "wineserver"), architecture: "x86_64" } };
}
const entitlements = keys => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join("")}</dict></plist>`;
const signature = (flags, keys = []) => `Executable=/x\nCodeDirectory v=20500 size=1 flags=${flags} hashes=1\nTeamIdentifier=TEAM123456\n${entitlements(["com.apple.security.cs.allow-jit", ...keys])}`;

test("the graphics layer is measured from the signature of the loader the game runs from", t => {
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const reads = [], reader = output => file => { reads.push(file); return output; };
  // Hardened without DYLD variables: dyld drops DYLD_INSERT_LIBRARIES, the layer's only route.
  const strict = wineFixture(t, { signed: true });
  assert.equal(Graphics.graphicsLayerAttachable(strict.install, { readSignature: reader(signature("0x10000(runtime)")) }), false);
  assert.deepEqual(reads, [fs.realpathSync(strict.loader)], "the publisher's Unix loader is read, not its launcher");
  // Read once per loader file, and again after the file changes.
  assert.equal(Graphics.graphicsLayerAttachable(strict.install, { readSignature: () => assert.fail("cached") }), false);
  fs.appendFileSync(strict.loader, "changed");
  assert.equal(Graphics.graphicsLayerAttachable(strict.install, { readSignature: reader(signature("0x10000(runtime)", ["com.apple.security.cs.allow-dyld-environment-variables"])) }), true,
    "the changed file is read again");
  // Current macOS enforces the DER entitlements, which `codesign --entitlements -` prints as
  // [Key]/[Value] lines; MetalSharp Wine's XML blob is invalid ("The OS will ignore these entitlements").
  const der = keys => `CodeDirectory v=20500 size=447 flags=0x10000(runtime) hashes=3+7 location=embedded\nTeamIdentifier=TQK8H7V7RP\n[Dict]\n` +
    keys.map(key => `\t[Key] ${key}\n\t[Value]\n\t\t[Bool] true\n`).join("");
  const metalsharp = wineFixture(t, { signed: true });
  assert.equal(Graphics.graphicsLayerAttachable(metalsharp.install, { readSignature: reader(der(["com.apple.developer.cross-architecture-support",
    "com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"])) }), false,
    "MetalSharp Wine's loader as current macOS reads it: disabled library validation does not bring DYLD variables back");
  const dyldDer = wineFixture(t, { signed: true });
  assert.equal(Graphics.graphicsLayerAttachable(dyldDer.install, { readSignature: reader(der(["com.apple.security.cs.allow-dyld-environment-variables"])) }), true);
  for (const [output, why] of [[signature("0x10000(runtime)", ["com.apple.security.cs.allow-dyld-environment-variables"]), "DYLD variables allowed"],
    [signature("0x2(adhoc)"), "no hardened runtime"], ["Sample: code object is not signed at all", "unsigned"], ["", "unreadable"]]) {
    const other = wineFixture(t, { signed: true });
    assert.equal(Graphics.graphicsLayerAttachable(other.install, { readSignature: reader(output) }), true, why);
  }
  // A Wine whose game runs from the view's own bundle is never read.
  const plain = wineFixture(t, { signed: false });
  assert.equal(Graphics.graphicsLayerAttachable(plain.install, { readSignature: () => assert.fail("not a publisher loader") }), true);
});

test("a Wine source answers for the version the game selects", t => {
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const { createProvider } = require("../src/modules/crossover/sources/provider");
  const strict = wineFixture(t, { signed: true }), options = [];
  Graphics.graphicsLayerAttachable(strict.install, { readSignature: () => signature("0x10000(runtime)") });
  const manager = selection => ({ resolveSelection: (_entry, _settings, _userDataDir, option) => { options.push(option); return selection; } });
  const source = require("../src/modules/crossover/sources").get("metalsharp-wine");
  const provider = selection => createProvider({ source, manager: manager(selection) });
  const context = { settings: {}, userDataDir: "/state" };
  assert.equal(provider({ ready: true, install: strict.install }).graphicsLayer({}, context), false);
  assert.deepEqual(options[0], { verification: "status" }, "a status read of the installed version, without a full payload walk");
  assert.equal(provider({ ready: false }).graphicsLayer({}, context), true, "a version that is not installed stays shown");
});

test("library checks carry a refused graphics layer to the game's row, and the inspector leaves Graphics out", () => {
  const info = { id: "engine", label: "Engine", runtime: { default: "runner", supported: ["runner"], entries: { runner: {} } }, supports: {} };
  const checks = layer => {
    const mod = { getRuntimeProvider: () => ({ graphicsLayer: layer }) };
    const launcher = createLauncher({ userDataDir: "/state", registry: { getModule: () => mod, getModuleInfo: () => info }, getRuntimeManagerState: () => ({ installed: [] }) });
    return launcher.resolveEntryChecks({ gameId: "game", gamePath: "/game/player.exe", moduleId: "engine" }, {});
  };
  assert.equal(checks(() => false).graphicsLayer, false);
  assert.equal(Object.hasOwn(checks(() => true), "graphicsLayer"), false);
  assert.equal(Object.hasOwn(checks(() => { throw new Error("unreadable"); }), "graphicsLayer"), false, "an error counts as attachable");
  const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.match(read("src/main/main.js"), /\.\.\.\(checks\.graphicsLayer === false \? \{ graphicsLayer: false \} : \{\}\)/);
  assert.match(read("src/renderer/src/ui/components/GameDetails.tsx"), /canLaunch && g\.graphicsLayer !== false && <EffectsControls/);
  assert.match(read("src/renderer/src/ui/App.tsx"), /const inspectGraphics = inspectionGame\.graphicsLayer !== false &&/);
});

test("a Wine launch whose loader refuses the layer tells the launcher so", async () => {
  const { launch } = require("../src/runtime-adapters/wine");
  const spawned = [], plan = { directory: "/tmp", winePath: "/view/bin/wine", serverPath: "/view/bin/wineserver", args: [], environment: {}, executablePath: "/game/Game.exe" };
  const context = { spawnDetachedChecked: async (command, args, options) => { spawned.push(options); return { pid: 1, once() {}, on() {} }; } };
  const dependencies = { processes: { installStopHandler() {} }, activation: { followWineActivation() {} }, supervisorArguments: () => [], createLog: () => ({ attach() {}, close() {} }) };
  await launch(plan, context, dependencies);
  await launch({ ...plan, graphicsUnavailable: "refused" }, context, dependencies);
  assert.deepEqual(spawned.map(options => [options.graphicsExecutable, options.graphicsUnavailable]), [["/view/bin/wine", undefined], ["/view/bin/wine", "refused"]]);
  assert.match(fs.readFileSync(path.join(__dirname, "../src/modules/crossover/sources/wine-launch.js"), "utf8"),
    /graphicsLayerAttachable\(selected\.install\) \? \{\} :\s*\{ graphicsUnavailable:/);
});

// MetalSharp Wine's ntdll reads DXMT_RUNTIME_DIR and loads <dir>/aarch64-unix/winemetal.so; its own runtime is lib/mullion.
function runtimeLibraryFixture(t, { readsDirectory = true, library = true } = {}) {
  const wine = wineFixture(t, { signed: true }), contents = wine.install.engineRoot;
  const put = (file, bytes = "fixture") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  put(path.join(contents, "lib", "wine", "x86_64-unix", "ntdll.so"), Buffer.concat([require("./fixtures/macho-image").image(),
    Buffer.from(readsDirectory ? "\0DXMT_RUNTIME_DIR\0" : "\0WINEDLLPATH\0")]));
  const mullion = path.join(contents, "lib", "mullion");
  for (const file of ["aarch64-unix/winemetal.so", "aarch64-windows/d3d11.dll", "aarch64-windows/dxgi.dll", "aarch64-windows/winemetal.dll", "i386-windows/d3d11.dll"]) put(path.join(mullion, file));
  const graphics = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-root-")));
  t.after(() => fs.rmSync(graphics, { recursive: true, force: true }));
  if (library) put(path.join(graphics, "maclauncher-winemetal.so"), "layer library");
  const ReShade = require("../src/modules/shared/reshade"), original = ReShade.runtimeRoot;
  ReShade.runtimeRoot = () => graphics;
  t.after(() => { ReShade.runtimeRoot = original; });
  return { ...wine, mullion, graphics };
}
const metalsharpSignature = `CodeDirectory v=20500 size=447 flags=0x10000(runtime) hashes=3+7 location=embedded\nTeamIdentifier=TQK8H7V7RP\n[Dict]\n` +
  ["com.apple.developer.cross-architecture-support", "com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]
    .map(key => `\t[Key] ${key}\n\t[Value]\n\t\t[Bool] true\n`).join("");

test("a hardened loader that loads unsigned libraries takes the layer through the runtime's winemetal.so", t => {
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const route = fixture => Graphics.graphicsLayerRoute(fixture.install, { readSignature: () => metalsharpSignature });
  const metalsharp = runtimeLibraryFixture(t);
  assert.equal(route(metalsharp), "runtime-library");
  assert.equal(Graphics.graphicsLayerAttachable(metalsharp.install), true, "the Graphics section is shown");
  assert.equal(route(runtimeLibraryFixture(t, { library: false })), null, "a graphics component without maclauncher-winemetal.so");
  assert.equal(route(runtimeLibraryFixture(t, { readsDirectory: false })), null, "an ntdll that does not read DXMT_RUNTIME_DIR");
  const validated = runtimeLibraryFixture(t);
  assert.equal(Graphics.graphicsLayerRoute(validated.install, { readSignature: () => metalsharpSignature.replace("disable-library-validation", "allow-unsigned-executable-memory") }), null,
    "library validation on: no unsigned library loads");
});

test("the view's DXMT runtime folder links the runtime's files and holds the layer library as winemetal.so", async t => {
  const Graphics = require("../src/modules/crossover/sources/wine-graphics");
  const fixture = runtimeLibraryFixture(t), view = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-view-")));
  t.after(() => fs.rmSync(view, { recursive: true, force: true }));
  const route = Graphics.runtimeLibraryRoute(fixture.install);
  for (let pass = 0; pass < 2; pass++) {
    const root = await Graphics.prepareRuntimeLibraryView(route, view);
    assert.equal(root, path.join(view, "graphics-runtime"));
    for (const file of ["aarch64-windows/d3d11.dll", "aarch64-windows/dxgi.dll", "aarch64-windows/winemetal.dll", "i386-windows/d3d11.dll"])
      assert.equal(fs.readlinkSync(path.join(root, file)), path.join(fixture.mullion, file), file);
    assert.equal(fs.readlinkSync(path.join(root, "aarch64-unix", "winemetal-runtime.so")), path.join(fixture.mullion, "aarch64-unix", "winemetal.so"));
    const library = path.join(root, "aarch64-unix", "winemetal.so");
    assert.equal(fs.lstatSync(library).isFile(), true, "a copy, so the library finds winemetal-runtime.so beside itself");
    assert.equal(fs.readFileSync(library, "utf8"), "layer library");
  }
  // A newer layer library replaces the copy.
  fs.writeFileSync(path.join(fixture.graphics, "maclauncher-winemetal.so"), "newer layer library");
  await Graphics.prepareRuntimeLibraryView(route, view);
  assert.equal(fs.readFileSync(path.join(view, "graphics-runtime", "aarch64-unix", "winemetal.so"), "utf8"), "newer layer library");
  const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.match(read("src/modules/crossover/sources/wine-graphics.js"), /\.\.\.\(runtimeLibraryRoot \? \{ DXMT_RUNTIME_DIR: runtimeLibraryRoot \} : \{\}\)/);
  assert.match(read("src/modules/crossover/sources/wine-launch.js"), /graphics\.inProcessGraphics && environment\.DYLD_INSERT_LIBRARIES\) environment\.MACLAUNCHER_GRAPHICS_LIBRARIES = environment\.DYLD_INSERT_LIBRARIES/);
  assert.match(read("src/core/launcher.js"), /if \(graphicsInProcess === true\) \{releaseCopy\(target\);return original;\}/);
  // An instrumented launch (processAdapter) checks graphics again; 0542 made a private copy there when the second check lost the route.
  assert.match(read("src/core/launcher.js"), /const graphicsTarget = Object\.fromEntries\(\["graphicsExecutable", "graphicsUnavailable", "graphicsInProcess"\]/);
  assert.match(read("src/modules/shared/reshade/native/CMakeLists.txt"), /add_library\(maclauncher-winemetal SHARED src\/winemetal-layer\.c\)/);
  assert.match(read("src/modules/shared/reshade/native/winemetal-runtime.tbd"), /install-name:\s+'@loader_path\/winemetal-runtime\.so'/);
});

test("a Wine launch whose game process loads the layer itself starts without the DYLD route", async () => {
  const { launch } = require("../src/runtime-adapters/wine");
  const spawned = [], plan = { directory: "/tmp", winePath: "/view/bin/wine", serverPath: "/view/bin/wineserver", args: [], environment: {}, executablePath: "/game/Game.exe" };
  const context = { spawnDetachedChecked: async (command, args, options) => { spawned.push(options); return { pid: 1, once() {}, on() {} }; } };
  const dependencies = { processes: { installStopHandler() {} }, activation: { followWineActivation() {} }, supervisorArguments: () => [], createLog: () => ({ attach() {}, close() {} }) };
  await launch({ ...plan, graphicsInProcess: true }, context, dependencies);
  assert.equal(spawned[0].graphicsInProcess, true);
});
