const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), test = require("node:test"), assert = require("node:assert/strict");
const Mono = require("../src/modules/godot/mono"), Pack = require("../src/modules/godot/pack"), Godot = require("../src/modules/godot/main");
const {pack, settings} = require("./helpers/godot-pack");
function fixture(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-mono-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sourceRoot = path.join(root, "game"), userDataDir = path.join(root, "data");fs.mkdirSync(sourceRoot);
  const value = pack({"project.binary": settings({"application/config/name": "Game", "mono/project/assembly_name": "Game"}), "Main.gdc": Buffer.from("GDSC"), ...files});
  const source = path.join(sourceRoot, "Game.exe");fs.writeFileSync(source, value.buffer);fs.writeFileSync(path.join(sourceRoot, "external.cfg"), "publisher config");
  const appPath = path.join(userDataDir, "runtimes/godot/3.5.2-stable/mono/Godot_mono.app"), api = path.join(appPath, "Contents/Resources/GodotSharp/Api/Debug");fs.mkdirSync(api, {recursive: true});
  for (const name of ["GodotSharp.dll", "GodotSharpEditor.dll"]) fs.writeFileSync(path.join(api, name), Buffer.from("MZselected runtime " + name));
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"));fs.writeFileSync(path.join(appPath, "Contents/MacOS/Godot"), "owned executable fixture", {mode:0o755});
  fs.writeFileSync(path.join(appPath,"Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const entry = {gameId: "game", gamePath: source, runtimeId: "godot", runtimeData: {godot: {version: "3.5.2-stable", variant: "mono"}},
    moduleData: {packPath: source, packOffset: value.offset, packSize: value.size, detectedMajor: 3, detectedVersion: "3.5.2"}};
  return {root, sourceRoot, source, userDataDir, appPath, api, entry, value,
    options: {target: {kind: "pack", path: source}, install: {version: "3.5.2-stable", appPath}, variant: "mono", userDataDir}};
}
test("Mono3 packs retain the original target, working directory and ordinary relative data", async t => {
  const f = fixture(t), prepared = await Mono.prepare(f.entry, f.options);
  assert.deepEqual(prepared, {target: f.options.target, cwd: f.sourceRoot});
  assert.equal(prepared.retire, undefined, "Play registers no cleanup of old private games");
  assert.equal(fs.existsSync(f.userDataDir + "/games"), false);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono")), false, "Godot itself owns API refresh");
  fs.writeFileSync(path.join(prepared.cwd, "external.cfg"), "ordinary game write");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "external.cfg"), "utf8"), "ordinary game write");
  assert.deepEqual(fs.readFileSync(f.source), f.value.buffer);
});
test("Mono3 source projects use their original imported assets and managed build outputs", async t => {
  const f = fixture(t), project = path.join(f.sourceRoot, "source"), imported = path.join(project, ".import/texture.stex");
  fs.mkdirSync(path.dirname(imported), {recursive: true});fs.writeFileSync(imported, "imported texture");
  fs.writeFileSync(path.join(project, "project.godot"), '[application]\nconfig/name="Game"\n');
  const assembly = path.join(project, ".mono/temp/bin/Debug/Game.dll");fs.mkdirSync(path.dirname(assembly), {recursive: true});fs.writeFileSync(assembly, "MZoriginal IL");
  const prepared = await Mono.prepare(f.entry, {...f.options, target: {kind: "project", path: project}});
  assert.deepEqual(prepared, {target: {kind: "project", path: project}, cwd: project});
  assert.equal(fs.readFileSync(assembly, "utf8"), "MZoriginal IL");assert.equal(fs.readFileSync(imported, "utf8"), "imported texture");
  assert.equal(fs.existsSync(path.join(project, ".mono/assemblies")), false);
});
test("ordinary Mono3 launch keeps the selected executable and the game's original cwd", async t => {
  const f = fixture(t);let call;
  await Godot.launchRuntime("godot", f.entry, {userDataDir: f.userDataDir, settings: {runtimes: {godot: {defaultVariant: "mono"}}}, platform: "darwin",
    spawnDetachedChecked: (executable, args, options) => {call = {executable, args, options};return {pid: 42};}});
  assert.match(call.executable, /Godot_mono\.app\/Contents\/MacOS\/Godot$/);
  assert.deepEqual(call.args, ["--main-pack", f.source]);assert.equal(call.options.cwd, f.sourceRoot);assert.equal(call.options.env, undefined);
});
test("warm original-path preparation never walks assets, copies siblings, reads API DLLs or hashes a full pack", async t => {
  const f = fixture(t, {"large.asset": Buffer.alloc(4 * 1024 * 1024)}), read = fs.readFileSync, walk = fs.readdirSync, copy = fs.copyFileSync, readChunk = fs.readSync;
  await Mono.prepare(f.entry, f.options);let bytesRead = 0;
  try {
    fs.readFileSync = function(file, ...args) {assert.doesNotMatch(String(file), /GodotSharp(?:Editor)?\.dll$|external\.cfg$/);return read.call(this, file, ...args);};
    fs.readdirSync = function(file, ...args) {assert.notEqual(String(file), f.sourceRoot);assert.ok(String(file).includes("Assemblies") || String(file).includes(".mono"));return walk.call(this, file, ...args);};
    fs.copyFileSync = () => assert.fail("No game asset copy is necessary");
    fs.readSync = function(fd, buffer, offset, length, position) {const count = readChunk.call(this, fd, buffer, offset, length, position);bytesRead += count;return count;};
    assert.equal((await Mono.prepare(f.entry, f.options)).cwd, f.sourceRoot);
    assert.ok(bytesRead < 1024 * 1024, `Only bounded pack metadata should be read, got ${bytesRead}`);
  } finally {fs.readFileSync = read;fs.readdirSync = walk;fs.copyFileSync = copy;fs.readSync = readChunk;}
});
test("only Release and exported managed IL missing from the original Debug folders is prepared", async t => {
  const game = Buffer.from("MZgame managed IL"), dependency = "MZdependency IL";
  const f = fixture(t, {".mono/assemblies/Release/Game.dll": game});
  const external = path.join(f.sourceRoot, "data_Game/Assemblies");fs.mkdirSync(external, {recursive: true});fs.writeFileSync(path.join(external, "Dependency.dll"), dependency);
  fs.writeFileSync(path.join(external, "GodotSharp.dll"), "MZpublisher API");
  const unrelated = path.join(f.sourceRoot, "data_Unrelated/Assemblies");fs.mkdirSync(unrelated, {recursive: true});fs.writeFileSync(path.join(unrelated, "Unrelated.dll"), "MZunrelated IL");
  const prepared = await Mono.prepare(f.entry, f.options), debug = path.join(f.sourceRoot, ".mono/temp/bin/Debug");
  assert.equal(prepared.target.path, f.source);assert.equal(prepared.cwd, f.sourceRoot);
  assert.deepEqual(fs.readFileSync(path.join(debug, "Game.dll")), game);assert.equal(fs.readFileSync(path.join(debug, "Dependency.dll"), "utf8"), dependency);
  assert.equal(fs.existsSync(path.join(debug, "GodotSharp.dll")), false);assert.equal(fs.existsSync(path.join(debug, "Unrelated.dll")), false);
  fs.writeFileSync(path.join(debug, "Dependency.dll"), "authoritative existing output");
  fs.writeFileSync(path.join(external, "Dependency.dll"), "new export input");await Mono.prepare(f.entry, f.options);
  assert.equal(fs.readFileSync(path.join(debug, "Dependency.dll"), "utf8"), "authoritative existing output");
  assert.equal(fs.readFileSync(path.join(external, "Dependency.dll"), "utf8"), "new export input");
});
test("existing loose and packed Debug assemblies win over alternate Release inputs", async t => {
  const f = fixture(t, {".mono/assemblies/Debug/Game.dll": Buffer.from("MZoriginal Debug"), ".mono/assemblies/Release/Game.dll": Buffer.from("MZRelease")});
  const release = path.join(f.sourceRoot, ".mono/assemblies/Release"), debug = path.join(f.sourceRoot, ".mono/assemblies/Debug");
  fs.mkdirSync(release, {recursive: true});fs.mkdirSync(debug);fs.writeFileSync(path.join(release, "Dependency.dll"), "MZRelease dependency");fs.writeFileSync(path.join(debug, "Dependency.dll"), "MZDebug dependency");
  await Mono.prepare(f.entry, f.options);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono/temp")), false);
  assert.equal(fs.readFileSync(path.join(debug, "Dependency.dll"), "utf8"), "MZDebug dependency");
});
test("an assembly destination created concurrently is kept instead of overwritten", async t => {
  const f = fixture(t, {".mono/assemblies/Release/Game.dll": Buffer.from("MZexport IL")}), link = fs.linkSync;
  try {
    fs.linkSync = function(from, to) {fs.writeFileSync(to, "concurrent authoritative IL");return link.call(this, from, to);};
    await Mono.prepare(f.entry, f.options);
  } finally {fs.linkSync = link;}
  const debug = path.join(f.sourceRoot, ".mono/temp/bin/Debug");
  assert.equal(fs.readFileSync(path.join(debug, "Game.dll"), "utf8"), "concurrent authoritative IL");assert.deepEqual(fs.readdirSync(debug), ["Game.dll"]);
});
test("a coarse-stamped assembly mutation during preparation publishes no partial output", async t => {
  const f = fixture(t), file = path.join(f.sourceRoot, "GodotSharp/Assemblies/Game.dll");fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, "MZold IL");
  const read = fs.readFileSync, stat = fs.statSync;let changed = false;
  try {
    fs.statSync = function(input, ...args) {const value = stat.call(this, input, ...args);if (String(input) === file) return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {mtimeMs: 2000, ctimeMs: 2000});return value;};
    fs.readFileSync = function(input, ...args) {const bytes = read.call(this, input, ...args);if (String(input) === file && !changed) {changed = true;fs.writeFileSync(file, "MZnew IL");}return bytes;};
    await assert.rejects(Mono.prepare(f.entry, f.options), /source changed/);
  } finally {fs.readFileSync = read;fs.statSync = stat;}
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono/temp/bin/Debug/Game.dll")), false);
});
test("damaged packed managed IL is rejected without replacing existing original data", async t => {
  const f = fixture(t, {".mono/assemblies/Release/Game.dll": Buffer.from("MZexport IL")});
  Pack.open(f.source, {offset: f.value.offset, size: f.value.size}, (_fd, value) => {const fd = fs.openSync(f.source, "r+");try {fs.writeSync(fd, Buffer.from("X"), 0, 1, value.entries.get(".mono/assemblies/Release/Game.dll").offset);} finally {fs.closeSync(fd);}});
  await assert.rejects(Mono.prepare(f.entry, f.options), /packed assemblies/);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono/temp/bin/Debug/Game.dll")), false);assert.equal(fs.readFileSync(path.join(f.sourceRoot, "external.cfg"), "utf8"), "publisher config");
});
test("packed stale API rows alone require a filtered pack, with original cwd and override config", async t => {
  const f = fixture(t, {".mono/assemblies/Debug/GodotSharp.dll": Buffer.from("MZold API")});
  fs.writeFileSync(path.join(f.sourceRoot, "override.cfg"), "[application]\nconfig/name=\"Override\"\n");
  const prepared = await Mono.prepare(f.entry, f.options);assert.notEqual(prepared.target.path, f.source);assert.equal(prepared.cwd, f.sourceRoot);
  assert.match(prepared.target.path, /mono-packs/);assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono/assemblies")), false);
  Pack.open(prepared.target.path, {offset: f.value.offset, size: f.value.size}, (_fd, value) => {assert.equal(value.entries.has(".mono/assemblies/Debug/GodotSharp.dll"), false);assert.ok(value.entries.has("project.binary"));});
  assert.equal(Pack.hasTrailer(prepared.target.path, {offset: f.value.offset, size: f.value.size}), true);
  assert.equal(fs.readFileSync(path.join(path.dirname(prepared.target.path), "override.cfg"), "utf8"), fs.readFileSync(path.join(f.sourceRoot, "override.cfg"), "utf8"));
  assert.deepEqual(fs.readdirSync(path.dirname(prepared.target.path)).sort(), ["main.pck", "override.cfg"]);
  assert.deepEqual(fs.readFileSync(f.source), f.value.buffer);assert.deepEqual(await Mono.prepare(f.entry, f.options), prepared);
});
test("modified derived packs are preserved while a fresh necessary transformation is prepared", async t => {
  const f = fixture(t, {".mono/assemblies/Debug/GodotSharp.dll": Buffer.from("MZold API")});
  const first = await Mono.prepare(f.entry, f.options);fs.writeFileSync(first.target.path, "private retained bytes");
  const next = await Mono.prepare(f.entry, f.options);assert.notEqual(next.target.path, first.target.path);
  assert.equal(fs.readFileSync(first.target.path, "utf8"), "private retained bytes");assert.equal(next.cwd, f.sourceRoot);
});
test("legacy private games, saves and receipts are neither read, migrated, repaired nor retired", async t => {
  const f = fixture(t), old = path.join(f.userDataDir, "games/game/modules/godot/mono-projects/000000000000000000000000/project");
  fs.mkdirSync(old, {recursive: true});fs.writeFileSync(path.join(old, "Save.cfg"), "private save");fs.writeFileSync(path.join(path.dirname(old), "prepared.json"), "legacy receipt");
  const before = fs.statSync(path.join(old, "Save.cfg")), read = fs.readFileSync, walk = fs.readdirSync;
  try {
    fs.readFileSync = function(file, ...args) {assert.ok(!String(file).includes("mono-projects"));return read.call(this, file, ...args);};
    fs.readdirSync = function(file, ...args) {assert.ok(!String(file).includes("mono-projects"));return walk.call(this, file, ...args);};
    const prepared = await Mono.prepare(f.entry, {...f.options, withRuntimeMutation: () => assert.fail("No retirement/migration is permitted")});
    assert.equal(prepared.retire, undefined);assert.equal(prepared.cwd, f.sourceRoot);
  } finally {fs.readFileSync = read;fs.readdirSync = walk;}
  assert.equal(fs.readFileSync(path.join(old, "Save.cfg"), "utf8"), "private save");assert.equal(fs.readFileSync(path.join(path.dirname(old), "prepared.json"), "utf8"), "legacy receipt");assert.equal(fs.statSync(path.join(old, "Save.cfg")).mtimeMs, before.mtimeMs);
});
test("optional preparation stays dormant for Standard and Godot4, and respects cancellation", async t => {
  const f = fixture(t);assert.equal(await Mono.prepare({}, {variant: "standard"}), null);assert.equal(await Mono.prepare({}, {variant: "mono", install: {version: "4.6.3-stable"}}), null);
  const controller = new AbortController(), reason = Error("stopped");controller.abort(reason);await assert.rejects(Mono.prepare(f.entry, {...f.options, signal: controller.signal}), value => value === reason);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono")), false);
});
test("assembly adaptation never writes through a source-side output-directory alias", async t => {
  const f = fixture(t, {".mono/assemblies/Release/Game.dll": Buffer.from("MZexport IL")}), outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);fs.symlinkSync(outside, path.join(f.sourceRoot, ".mono"));
  await assert.rejects(Mono.prepare(f.entry, f.options), /must not be aliases/);assert.deepEqual(fs.readdirSync(outside), []);
});
