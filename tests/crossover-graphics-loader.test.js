const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Loader = require("../src/modules/crossover/runtime/graphics-loader");
const permissions = '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.device.camera</key><true/><key>custom</key><dict><key>nested</key><string>preserved</string></dict></dict></plist>';
function installation(root) {
  const crossoverRoot = path.join(root, "vendor"), loaderPath = path.join(crossoverRoot, "bin/wineloader");
  for (const [name, bytes] of Object.entries({ "bin/wineloader": "supplied loader", "bin/wineserver": "server",
    "lib/wine/x86_64-unix/wine": "distinct child loader", "lib/wine/x86_64-unix/ntdll.so": "supplied ntdll", "lib/wine/x86_64-unix/crypt32.so": "supplied unix module",
    "lib64/library.dylib": "supplied dependency",
    "lib/wine/x86_64-windows/ntdll.dll": "PE ntdll", "lib/wine/x86_64-windows/apisetschema.dll": "api sets", "share/wine/data": "data" })) {
    const file = path.join(crossoverRoot, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes, { mode: 0o755 });
  }
  return { crossoverRoot, loaderPath };
}
test("graphics loader permission preserves existing nested entitlements and changes only the DYLD permission", () => {
  const result = Loader.entitlements(permissions);
  assert.match(result, /<key>custom<\/key><dict><key>nested<\/key><string>preserved<\/string><\/dict>/);
  assert.match(result, /<key>com.apple.security.cs.allow-dyld-environment-variables<\/key><true\/>/);
  assert.equal(Loader.entitlements(result), result);
  assert.equal(Loader.entitlements(result.replace(/(<key>com.apple.security.cs.allow-dyld-environment-variables<\/key>)<true\/>/, '$1<false/>')), result);
  assert.throws(() => Loader.entitlements("not a plist"), /permissions could not be read/);
});
test("graphics loader fallback removes only the known processor and restores preexisting shared values", () => {
  const previous = {DYLD_INSERT_LIBRARIES: '/steam.dylib:/camera.dylib', STEAM_DYLD_INSERT_LIBRARIES: '/steam.dylib',
    WINEDLLPATH: '/vendor/dxmt', DXMT_ENABLE_NVEXT: '1', MACLAUNCHER_DXMT_BASE_LIBRARY: '/required/native.so',
    RESHADE_EXTERNAL: 'existing setting', FSR4_ROOT: '/existing/root', SteamAppId: '480'};
  const graphics = {DYLD_INSERT_LIBRARIES: '/shared/libreshade-macos.dylib', RESHADE_EFFECT_PLAN: '/shared/plan.json',
    RESHADE_LOG: '/shared/log', FSR4_ROOT: '/shared/fsr4'};
  const current = {...previous, ...graphics, DYLD_INSERT_LIBRARIES: previous.DYLD_INSERT_LIBRARIES + ':' + graphics.DYLD_INSERT_LIBRARIES + ':/later.dylib',
    STEAM_DYLD_INSERT_LIBRARIES: '/steam.dylib:/shared/libreshade-macos.dylib:/later.dylib'};
  delete current.RESHADE_EXTERNAL;
  const retained = Loader.withoutGraphics(current, previous, graphics);
  assert.deepEqual(retained, {...previous, DYLD_INSERT_LIBRARIES: '/steam.dylib:/camera.dylib:/later.dylib',
    STEAM_DYLD_INSERT_LIBRARIES: '/steam.dylib:/later.dylib'});
  assert.equal(current.RESHADE_EFFECT_PLAN, '/shared/plan.json');assert.equal(previous.FSR4_ROOT, '/existing/root');
  assert.deepEqual(Loader.withoutGraphics({VALUE: 'retained'}, {}, graphics), {VALUE: 'retained'});
});
test("CrossOver graphics preparation signs only a private copy and reuses matching completed output", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-graphics-loader-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = installation(root), original = selected.loaderPath, directory = path.join(root, "game");
  const child = path.join(selected.crossoverRoot, "lib/wine/x86_64-unix/wine");
  const calls = [], execute = async (command, args) => {
    assert.equal(command, "/usr/bin/codesign");calls.push(args);
    if (args[0] === "-d") { assert.ok([original, child].map(file => fs.realpathSync(file)).includes(args.at(-1)));return { stdout: permissions }; }
    assert.ok(args.at(-1).startsWith(directory));
    if (args.includes("--sign")) {
      assert.match(fs.readFileSync(args[args.indexOf("--entitlements") + 1], "utf8"), /allow-dyld-environment-variables/);
      fs.appendFileSync(args.at(-1), " private signature");
    }
    return { stdout: "" };
  };
  const loader = await Loader.prepare(selected, directory, { execute }), prepared = path.dirname(path.dirname(loader));
  assert.equal(fs.readFileSync(original, "utf8"), "supplied loader");
  assert.equal(fs.readFileSync(loader, "utf8"), "supplied loader private signature");
  assert.equal(fs.readFileSync(child, "utf8"), "distinct child loader");
  assert.equal(fs.readFileSync(path.join(prepared, "lib/wine/x86_64-unix/wine"), "utf8"), "distinct child loader private signature");
  assert.equal(fs.lstatSync(path.join(prepared, "lib/wine/x86_64-unix/ntdll.so")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(prepared, "lib/wine/x86_64-unix/ntdll.so"), "utf8"), "supplied ntdll");
  assert.equal(fs.realpathSync(path.join(prepared, "lib/wine/x86_64-windows/ntdll.dll")), fs.realpathSync(path.join(selected.crossoverRoot, "lib/wine/x86_64-windows/ntdll.dll")));
  assert.equal(fs.realpathSync(path.join(prepared, "lib/wine/x86_64-unix/crypt32.so")), fs.realpathSync(path.join(selected.crossoverRoot, "lib/wine/x86_64-unix/crypt32.so")));
  assert.equal(fs.realpathSync(path.join(prepared, "lib64")), fs.realpathSync(path.join(selected.crossoverRoot, "lib64")));
  assert.deepEqual(Loader.environment(loader, { DYLD_LIBRARY_PATH: "/existing/libraries" }), {
    WINELOADER: loader, CX_WINELOADER: loader, DYLD_LIBRARY_PATH: path.join(prepared, "lib/wine/x86_64-unix") + ":/existing/libraries",
  });
  assert.equal(calls.length, 6);
  assert.equal(await Loader.prepare(selected, directory, { execute: () => assert.fail("unchanged loader does not need signing") }), loader);
  assert.equal(fs.readdirSync(path.join(directory, "graphics-loader")).some(name => name.startsWith("prepare-")), false);
  fs.writeFileSync(loader, "changed");await assert.rejects(Loader.prepare(selected, directory, { execute }), /has changed/);
});
test("failed private loader signing leaves the supplied loader untouched and removes incomplete copies", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-graphics-loader-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = installation(root), directory = path.join(root, "game");
  await assert.rejects(Loader.prepare(selected, directory, { execute: async () => { throw Error("signing failed"); } }), /signing failed/);
  assert.equal(fs.readFileSync(selected.loaderPath, "utf8"), "supplied loader");assert.deepEqual(fs.readdirSync(path.join(directory, "graphics-loader")), []);
});
test("CrossOver graphics preparation preserves older single-loader layouts without requiring modern Wine files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-graphics-loader-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = installation(root), directory = path.join(root, "game");
  fs.rmSync(path.join(selected.crossoverRoot, "lib/wine"), { recursive: true });
  let signs = 0;
  const execute = async (_command, args) => {
    if (args[0] === "-d") return { stdout: permissions };
    if (args.includes("--sign")) signs++;
    return { stdout: "" };
  };
  const loader = await Loader.prepare(selected, directory, { execute });
  assert.equal(signs, 1);
  assert.equal(fs.readFileSync(loader, "utf8"), "supplied loader");
  assert.deepEqual(Loader.environment(loader), { WINELOADER: loader, CX_WINELOADER: loader });
  assert.equal(await Loader.prepare(selected, directory, { execute: () => assert.fail("cache should be reused") }), loader);
});
test("private Vulkan selection binds the exact paired modules and x64 driver without changing the Direct3D backend", async t => {
  const crypto = require("node:crypto"), root = fs.mkdtempSync(path.join(os.tmpdir(), "crossover-scene-loader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = installation(root), directory = path.join(root, "game"), profile = require("../src/modules/crossover/temporal/catalog").VULKAN_PROFILE;
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes);return file; };
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), modules = {}, runtimeFiles = [];
  for (const architecture of ["x86_64-unix", "x86_64-windows", "i386-windows"]) {
    const name = "winevulkan." + (architecture.endsWith("unix") ? "so" : "dll"), relative = "lib/wine/" + architecture + "/" + name;
    const original = write(path.join(selected.crossoverRoot, relative), "vendor " + architecture);
    runtimeFiles.push({ relative, sha256: hash(original) });
    const file = write(path.join(root, "paired", architecture, name), "owned " + architecture);modules[architecture] = { path: file, sha256: hash(file) };
  }
  for (const name of ["win32u.so", "winemac.so"]) {
    const relative = "lib/wine/x86_64-unix/" + name, file = write(path.join(selected.crossoverRoot, relative), "vendor " + name);
    runtimeFiles.push({ relative, sha256: hash(file) });
  }
  const native = Buffer.alloc(56);
  for (const [offset, value] of [[0, 0xfeedfacf], [4, 0x01000007], [12, 6], [16, 1], [20, 24], [32, 0x32], [36, 24], [40, 1], [44, 0x0d0000], [48, 0x0d0000]]) native.writeUInt32LE(value, offset);
  const driver = write(path.join(root, "driver", "libMoltenVK-scene.dylib"), native);
  const closure = { profile: profile.id, runtimeProfile: { id: profile.id, driverVersion: profile.driverVersion, unixCallCount: profile.unixCallCount, files: runtimeFiles },
    modules, driver: { path: driver, sha256: hash(driver) } };
  const execute = async (_command, args) => ({ stdout: args[0] === "-d" ? permissions : "" });
  const loader = await Loader.prepare(selected, directory, { execute, sceneClosure: closure }), prepared = path.resolve(path.dirname(loader), "..");
  assert.equal(fs.realpathSync(path.join(prepared, "lib/wine/x86_64-unix/libMoltenVK.dylib")), fs.realpathSync(driver));
  for (const [architecture, item] of Object.entries(modules)) assert.equal(fs.realpathSync(path.join(prepared, "lib/wine", architecture, path.basename(item.path))), fs.realpathSync(item.path));
  const previous = { CX_GRAPHICS_BACKEND: "d3dmetal", CX_ACTIVE_GRAPHICS_BACKEND: "dxmt", WINED3DMETAL: "1", WINEDXVK: "0", WINEDLLPATH: "/existing/modules", WINEDLLOVERRIDES: "other=n,b" };
  const values = Loader.environment(loader, previous, { installation: selected, sceneClosure: closure });
  for (const key of ["CX_GRAPHICS_BACKEND", "CX_ACTIVE_GRAPHICS_BACKEND", "WINED3DMETAL", "WINEDXVK"]) assert.equal(Object.hasOwn(values, key), false);
  assert.match(values.WINEDLLPATH, /existing\/modules/);assert.equal(values.WINEDLLOVERRIDES, "other=n,b;winevulkan=b");
  assert.equal(await Loader.prepare(selected, directory, { sceneClosure: closure, execute: () => assert.fail("unchanged closure must reuse its loader") }), loader);
  const arm = Buffer.from(native);arm.writeUInt32LE(0x0100000c, 4);fs.writeFileSync(driver, arm);
  assert.throws(() => Loader.sceneSelection(selected, { ...closure, driver: { path: driver, sha256: hash(driver) } }), /architecture/);
  fs.writeFileSync(driver, native);fs.appendFileSync(modules["i386-windows"].path, " changed");
  await assert.rejects(Loader.prepare(selected, directory, { execute, sceneClosure: closure }), /closure changed/);
  assert.equal(fs.readFileSync(path.join(selected.crossoverRoot, "lib/wine/i386-windows/winevulkan.dll"), "utf8"), "vendor i386-windows");
});
test("Graphics Off does no scene package or original-library discovery", () => {
  const Temporal = require("../src/modules/crossover/temporal"), unavailable = new Proxy({}, { get() { assert.fail("Off must not inspect packages"); } });
  assert.equal(Temporal.resolveScenePlan({}, {}, { install: { crossoverRoot: "/unreadable/vendor" }, requested: false, support: unavailable, vulkan: unavailable }), null);
});
test("image filters, scaling and image-pair generation never acquire or activate the scene API", t => {
  const Temporal = require("../src/modules/crossover/temporal"), ReShade = require("../src/modules/shared/reshade");
  t.mock.method(ReShade, "resolveShaderSelection", () => ({requirements: {depth: false, motion: false}, traits: {}}));
  const unavailable = new Proxy({}, {get() { assert.fail("Image-only work must not inspect scene packages"); }});
  const nodes = [{id: "image", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}},
    {id: "scale", kind: "upscale", enabled: true, method: "bilinear", settings: {}},
    {id: "frames", kind: "frame-generation", enabled: true, method: "lsfg", settings: {}}];
  for (const video of nodes.map(node => [node]).concat([nodes])) {
    const entry = {effects: {schema: 2, mode: "advanced", enabled: true, video}};
    assert.deepEqual(Temporal.sceneDemand(entry), []);
    assert.equal(Temporal.resolveScenePlan(entry, {}, {install: {crossoverRoot: "/unreadable/vendor"}, support: unavailable, vulkan: unavailable}), null);
  }
  const entry = {effects: {schema: 2, mode: "advanced", enabled: true, video: [nodes[0]]}};
  t.mock.method(ReShade, "resolveShaderSelection", () => ({requirements: {depth: true, motion: false}, traits: {sceneBindings: {NormalTexture: "normal"}}}));
  assert.deepEqual(Temporal.sceneDemand(entry).sort(), ["depth", "normal"]);
  const temporal = {...entry, effects: {...entry.effects, video: [{id: "scene", kind: "temporal", method: "metalfx", enabled: true, settings: {}}]}};
  assert.deepEqual(Temporal.sceneDemand(temporal).sort(), ["depth", "motion"]);
});
