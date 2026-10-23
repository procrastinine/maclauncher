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
