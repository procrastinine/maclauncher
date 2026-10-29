const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Pack = require("../src/modules/godot/pack"), Godot = require("../src/modules/godot/main"), Metadata = require("../src/modules/godot/metadata");
const {pack, settings} = require("./helpers/godot-pack");
function fixture(t, value) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-pack-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, "game.exe");fs.writeFileSync(source, value.buffer);
  return {root, source, entry: {gameId: "pack", gamePath: source, moduleData: {packPath: source, packOffset: value.offset, packSize: value.size}}};
}
test("embedded trailer launch preserves executable-relative resources and never reuses a raw-slice cache", t => {
  const config = settings({"application/config/name": "Embedded game"}), value = pack({"project.binary": config});
  const f = fixture(t, value), userDataDir = path.join(f.root, "profile");
  const old = path.join(userDataDir, "games/pack/modules/godot/packs/game.embedded.pck");fs.mkdirSync(path.dirname(old), {recursive: true});fs.writeFileSync(old, value.buffer.subarray(value.offset, value.offset + value.size));
  const before = fs.readFileSync(f.source), target = Godot.__test.resolveLaunchTarget(f.entry, {userDataDir});
  assert.equal(target.path, f.source);assert.equal(Pack.hasTrailer(target.path, value), true);
  Pack.open(target.path, value, (fd, parsed) => assert.deepEqual(Pack.readEntry(fd, parsed.entries.get("project.binary"), 1024), config));
  assert.deepEqual(fs.readFileSync(f.source), before);assert.deepEqual(fs.readFileSync(old), value.buffer.subarray(value.offset, value.offset + value.size));
});
for (const [version, flags, fileBase] of [[1, 0, 0], [2, 0, 16], [2, 2, 16], [3, 0, 16]]) test(`section-only pack v${version} flags${flags} is rebased with readable resources and a warm cache`, t => {
  const config = settings({"application/config/name": "Section game 日本語"}), value = pack({"project.binary": config, "asset.bin": Buffer.from([4, 3, 2, 1])}, {version, flags, fileBase, trailer: false});
  const f = fixture(t, value), options = {userDataDir: path.join(f.root, "profile")};
  const target = Godot.__test.resolveLaunchTarget(f.entry, options);assert.notEqual(target.path, f.source);assert.match(target.path, /standalone-v2\.pck$/);
  Pack.open(target.path, {}, (fd, parsed) => {
    assert.deepEqual(Pack.readEntry(fd, parsed.entries.get("project.binary"), 1024), config);
    assert.deepEqual(Pack.readEntry(fd, parsed.entries.get("asset.bin"), 1024), Buffer.from([4, 3, 2, 1]));
  });
  const time = fs.statSync(target.path).mtimeMs;assert.equal(Godot.__test.resolveLaunchTarget(f.entry, options).path, target.path);assert.equal(fs.statSync(target.path).mtimeMs, time);
  assert.deepEqual(fs.readFileSync(f.source), value.buffer);
});
test("pack metadata rejects unsafe paths, malformed directories and non-string Variant settings", t => {
  for (const name of ["../outside.png", "/absolute.png", "a\\b.png"]) {
    const value = pack({[name]: Buffer.from([1])}), f = fixture(t, value);
    assert.throws(() => Pack.open(f.source, value, () => {}), /resource path/);
  }
  const value = pack({"project.binary": settings({"application/config/name": "Safe"})}), f = fixture(t, value);
  const corrupt = Buffer.from(value.buffer);corrupt.writeUInt32LE(65537, value.offset + 84);fs.writeFileSync(f.source, corrupt);
  assert.equal(Metadata.exported(f.entry), null);
  const object = settings({"application/config/name": "Object"});object.writeUInt32LE(17, 8 + 4 + Buffer.byteLength("application/config/name") + 4);
  assert.equal(Metadata.binarySettings(object)["application/config/name"], undefined);
  assert.equal(Metadata.binarySettings(Buffer.from("ECFG")), null);
});
function createGodotApp(appPath) {
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), {recursive: true});
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string></dict></plist>');
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/Godot"), "#!/bin/sh\nexit 0\n", {mode: 0o755});
}
test("Godot3 packed GDScript retains explicit version and Mono choices with an independent Standard runtime", async t => {
  const settingsGlobal = {runtimes: {godot: {defaultVersion: "4.6.3-stable", defaultVariant: "mono"}}};
  const value = pack({"project.binary": settings({"application/config/name": "Game"}), "Main.gdc": Buffer.from("GDSC")}), f = fixture(t, value);
  f.entry.moduleData.detectedVersion = "3.5.2";f.entry.moduleData.detectedMajor = 3;
  assert.equal(Pack.scripting(f.source, value), "gdscript");
  assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {}, f.entry), "mono");
  assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {}, {...f.entry, runtimeSettings: {godot: {preferExtracted: true}}}), "mono");
  assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {variant: "mono"}, f.entry), "mono");
  assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {variant: "standard"}, f.entry), "standard");
  // Version discovery is explicit; the archive list is supplied locally instead of querying godotengine.org.
  const archive = t.mock.method(require("../src/modules/godot/runtime/godot-runtime"), "fetchAvailableVersions",
    async () => ({versions: ["4.6.3-stable", "3.5.2-stable"], source: "test-archive", mode: "all"}));
  const mono = path.join(f.root, "profile/runtimes/godot/3.5.2-stable/mono/Godot.app");createGodotApp(mono);
  const globalPlan = await Godot.ensureRuntime(f.entry, {userDataDir: path.join(f.root, "profile"), settings: settingsGlobal});
  assert.equal(globalPlan.version, "4.6.3-stable", "The explicit global choice is not replaced by another installed version");
  f.entry.runtimeData = {godot: {version: "3.5.2-stable"}};
  assert.equal(await Godot.ensureRuntime(f.entry, {userDataDir: path.join(f.root, "profile"), settings: settingsGlobal}), null);
  const standardSettings = {runtimes: {godot: {...settingsGlobal.runtimes.godot, defaultVariant: "standard"}}};
  const planned = await Godot.ensureRuntime(f.entry, {userDataDir: path.join(f.root, "profile"), settings: standardSettings});
  assert.equal(planned.installOptions.variant, "standard");assert.equal(planned.version, "3.5.2-stable");
  assert.equal(standardSettings.runtimes.godot.defaultVersion, "4.6.3-stable", "Preparing a per-game override preserves the global choice");
  const standard = path.join(f.root, "profile/runtimes/godot/3.5.2-stable/standard/Godot.app");createGodotApp(standard);
  assert.equal(await Godot.ensureRuntime(f.entry, {userDataDir: path.join(f.root, "profile"), settings: settingsGlobal}), null);
  assert.equal(Godot.actions.runtimeStatus(f.entry, {}, {userDataDir: path.join(f.root, "profile"), settings: standardSettings}).requiredVariant, "standard");
  for (const files of [
    {"project.binary": settings({"mono/project/assembly_name": "Game"}), "Main.gdc": Buffer.from("GDSC")},
    {"project.binary": settings({"application/config/name": "Game"}), "Main.cs.remap": Buffer.from("Managed")},
    {"project.binary": settings({"application/config/name": "Game"})}
  ]) {
    const other = pack(files);fs.writeFileSync(f.source, other.buffer);f.entry.moduleData.packSize = other.size;
    assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {}, f.entry), "mono", "managed or unproven content keeps the Mono path");
  }
  fs.writeFileSync(f.source, value.buffer);f.entry.moduleData.packSize = value.size;
  fs.mkdirSync(path.join(f.root, "data_game_windows_x86_64"));assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {}, f.entry), "mono", "external assembly directories are not overlooked");
  fs.rmdirSync(path.join(f.root, "data_game_windows_x86_64"));
  const encrypted = Buffer.from(value.buffer);encrypted.writeUInt32LE(2, value.offset + 4);encrypted.writeUInt32LE(1, value.offset + 20);fs.writeFileSync(f.source, encrypted);
  assert.equal(Godot.__test.resolveRuntimeVariant(settingsGlobal, {}, f.entry), "mono");
});
