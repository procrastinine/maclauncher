const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), test = require("node:test"), assert = require("node:assert/strict");
const Mono = require("../src/modules/godot/mono"), Pack = require("../src/modules/godot/pack"), Godot = require("../src/modules/godot/main");
const {pack, settings} = require("./helpers/godot-pack");
const {createRuntimeCoordinator} = require("../src/core/runtime-coordinator");
const {EventEmitter} = require("node:events");
function fixture(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-mono-")));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const sourceRoot = path.join(root, "game"), userDataDir = path.join(root, "data");fs.mkdirSync(sourceRoot);
  const value = pack({"project.binary": settings({"application/config/name": "Game", "mono/project/assembly_name": "Game"}), "Main.gdc": Buffer.from("GDSC"), ...files});
  const source = path.join(sourceRoot, "Game.exe");fs.writeFileSync(source, value.buffer);fs.writeFileSync(path.join(sourceRoot, "external.cfg"), "publisher config");
  const appPath = path.join(userDataDir, "runtimes/godot/3.5.2-stable/mono/Godot_mono.app"), api = path.join(appPath, "Contents/Resources/GodotSharp/Api/Debug");fs.mkdirSync(api, {recursive: true});
  for (const name of ["GodotSharp.dll", "GodotSharpEditor.dll"]) fs.writeFileSync(path.join(api, name), Buffer.from("MZselected runtime " + name));
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"));fs.writeFileSync(path.join(appPath, "Contents/MacOS/Godot"), "owned executable fixture");
  const entry = {gameId: "game", gamePath: source, runtimeId: "godot", runtimeData: {godot: {version: "3.5.2-stable", variant: "mono"}},
    moduleData: {packPath: source, packOffset: value.offset, packSize: value.size, detectedMajor: 3, detectedVersion: "3.5.2"}};
  return {root, sourceRoot, source, userDataDir, appPath, api, entry, value,
    options: {target: {kind: "pack", path: source}, install: {version: "3.5.2-stable", appPath}, variant: "mono", userDataDir}};
}
test("Mono3 pack preparation preloads exact API DLLs through private filesystem fallback with no extraction or hook", async t => {
  const f = fixture(t), source = fs.readFileSync(f.source), prepared = await Mono.prepare(f.entry, f.options);
  assert.equal(prepared.target.path, f.source, "the original pack and payload offsets remain intact");assert.notEqual(prepared.cwd, f.sourceRoot);
  for (const name of ["GodotSharp.dll", "GodotSharpEditor.dll"]) assert.deepEqual(fs.readFileSync(path.join(prepared.cwd, ".mono/assemblies/Debug", name)), fs.readFileSync(path.join(f.api, name)));
  assert.equal(fs.readFileSync(path.join(prepared.cwd, "external.cfg"), "utf8"), "publisher config", "ordinary relative external reads still resolve");
  fs.writeFileSync(path.join(prepared.cwd, "external.cfg"), "private change");assert.equal(fs.readFileSync(path.join(f.sourceRoot, "external.cfg"), "utf8"), "publisher config");
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono")), false);assert.deepEqual(fs.readFileSync(f.source), source);
  const mtime = fs.statSync(path.join(prepared.cwd, ".mono/assemblies/Debug/GodotSharp.dll")).mtimeMs;
  assert.deepEqual(await Mono.prepare(f.entry, f.options), prepared);assert.equal(fs.statSync(path.join(prepared.cwd, ".mono/assemblies/Debug/GodotSharp.dll")).mtimeMs, mtime);
});
test("Mono3 C# assemblies retain IL and dependencies while packed stale API rows use the selected runtime", async t => {
  const game = Buffer.from("MZgame managed IL"), dependency = Buffer.from("MZdependency IL"), stale = Buffer.from("MZold API");
  const f = fixture(t, {".mono/assemblies/Release/Game.dll": game, ".mono/assemblies/Debug/GodotSharp.dll": stale});
  const external = path.join(f.sourceRoot, "data_Game/Assemblies");fs.mkdirSync(external, {recursive: true});fs.writeFileSync(path.join(external, "Dependency.dll"), dependency);
  const unrelated = path.join(f.sourceRoot, "data_Unrelated/Assemblies");fs.mkdirSync(unrelated, {recursive: true});fs.writeFileSync(path.join(unrelated, "Unrelated.dll"), "MZunrelated IL");
  const before = fs.readFileSync(f.source), prepared = await Mono.prepare(f.entry, f.options);assert.notEqual(prepared.target.path, f.source);
  Pack.open(prepared.target.path, {offset: f.value.offset, size: f.value.size}, (fd, value) => {
    assert.equal(value.entries.has(".mono/assemblies/Debug/GodotSharp.dll"), false);
    assert.deepEqual(Pack.readEntry(fd, value.entries.get(".mono/assemblies/Release/Game.dll"), 1024), game);
    assert.ok(value.entries.has("project.binary"));
  });
  assert.equal(Pack.hasTrailer(prepared.target.path, {offset: f.value.offset, size: f.value.size}), true);
  assert.deepEqual(fs.readFileSync(path.join(prepared.cwd, ".mono/temp/bin/Debug/Game.dll")), game);
  assert.deepEqual(fs.readFileSync(path.join(prepared.cwd, ".mono/temp/bin/Debug/Dependency.dll")), dependency);
  assert.equal(fs.existsSync(path.join(prepared.cwd, ".mono/temp/bin/Debug/Unrelated.dll")), false);
  assert.deepEqual(fs.readFileSync(f.source), before);assert.deepEqual(fs.readFileSync(path.join(external, "Dependency.dll")), dependency);
});
test("Mono3 project preparation preserves imported resources and publisher files in a private writable projection", async t => {
  const f = fixture(t), project = path.join(f.sourceRoot, "source");fs.mkdirSync(path.join(project, ".import"), {recursive: true});
  fs.writeFileSync(path.join(project, "project.godot"), '[application]\nconfig/name="Game"\n');fs.writeFileSync(path.join(project, ".import/texture.stex"), "imported texture");
  const managed = path.join(project, ".mono/temp/bin/Debug");fs.mkdirSync(managed, {recursive: true});fs.writeFileSync(path.join(managed, "Game.dll"), "MZsource game IL");
  const prepared = await Mono.prepare(f.entry, {...f.options, target: {kind: "project", path: project}});
  assert.notEqual(prepared.target.path, project);assert.equal(prepared.cwd, prepared.target.path);
  assert.equal(fs.readFileSync(path.join(prepared.cwd, ".import/texture.stex"), "utf8"), "imported texture");
  assert.equal(fs.readFileSync(path.join(prepared.cwd, ".mono/temp/bin/Debug/Game.dll"), "utf8"), "MZsource game IL");
  fs.writeFileSync(path.join(prepared.cwd, "project.godot"), "private write");assert.match(fs.readFileSync(path.join(project, "project.godot"), "utf8"), /config\/name/);
  assert.equal(fs.existsSync(path.join(project, ".mono/assemblies")), false);
});
test("Mono3 optional preparation is dormant for Standard and Godot4, and rejects cancellation and escaping assemblies", async t => {
  const f = fixture(t);assert.equal(await Mono.prepare({}, {variant: "standard"}), null);assert.equal(await Mono.prepare({}, {variant: "mono", install: {version: "4.6.3-stable"}}), null);
  const controller = new AbortController(), reason = Error("stopped");controller.abort(reason);await assert.rejects(Mono.prepare(f.entry, {...f.options, signal: controller.signal}), value => value === reason);
  const external = path.join(f.sourceRoot, "data_Game/Assemblies");fs.mkdirSync(external, {recursive: true});const outside = path.join(f.root, "outside.dll");fs.writeFileSync(outside, "MZoutside");fs.symlinkSync(outside, path.join(external, "escaped.dll"));
  await assert.rejects(Mono.prepare(f.entry, f.options), /assembly links/);assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono")), false);
});
test("ordinary Mono3 launch uses the existing selected Mono executable and private bootstrap cwd", async t => {
  const f = fixture(t);let call;
  await Godot.launchRuntime("godot", f.entry, {userDataDir: f.userDataDir, settings: {runtimes: {godot: {defaultVariant: "mono"}}}, platform: "darwin",
    spawnDetachedChecked: (executable, args, options) => {call = {executable, args, options};return {pid: 42};}});
  assert.match(call.executable, /Godot_mono\.app\/Contents\/MacOS\/Godot$/);assert.deepEqual(call.args, ["--main-pack", f.source]);
  assert.ok(fs.existsSync(path.join(call.options.cwd, ".mono/assemblies/Debug/GodotSharp.dll")));assert.equal(call.options.env, undefined, "the adapter adds no process hook or graphics environment");
});
test("Mono3 cached API repair and runtime changes preserve publisher bytes and prior prepared generations", async t => {
  const f = fixture(t), prepared = await Mono.prepare(f.entry, f.options), api = path.join(prepared.cwd, ".mono/assemblies/Debug/GodotSharp.dll");
  fs.writeFileSync(path.join(prepared.cwd, "Save.cfg"), "retained game state");
  fs.writeFileSync(api, "MZdamaged API");assert.deepEqual(await Mono.prepare(f.entry, f.options), prepared);
  assert.equal(fs.readFileSync(path.join(prepared.cwd, "Save.cfg"), "utf8"), "retained game state");
  assert.deepEqual(fs.readFileSync(api), fs.readFileSync(path.join(f.api, "GodotSharp.dll")));
  const accepted = fs.readFileSync(api);fs.writeFileSync(path.join(f.api, "GodotSharp.dll"), "MZupdated selected runtime API");
  const updated = await Mono.prepare(f.entry, f.options);assert.notEqual(updated.cwd, prepared.cwd);assert.deepEqual(fs.readFileSync(api), accepted);
  assert.equal(fs.readFileSync(path.join(updated.cwd, ".mono/assemblies/Debug/GodotSharp.dll"), "utf8"), "MZupdated selected runtime API");
  fs.writeFileSync(path.join(updated.cwd, "Save.cfg"), "working data with lost cache receipt");
  const directory = path.dirname(updated.cwd);fs.writeFileSync(path.join(directory, "prepared.json"), "interrupted receipt");
  await Mono.prepare(f.entry, f.options);
  const preserved = fs.readdirSync(directory).find(name => name.startsWith("preserved-"));assert.ok(preserved);
  assert.equal(fs.readFileSync(path.join(directory, preserved, "Save.cfg"), "utf8"), "working data with lost cache receipt");
  assert.deepEqual(fs.readFileSync(f.source), f.value.buffer);assert.equal(fs.existsSync(path.join(f.sourceRoot, ".mono")), false);
});
test("a publisher game.pck cannot collide with the private API-filtered pack or be modified through an alias", async t => {
  const f = fixture(t, {".mono/assemblies/Debug/GodotSharp.dll": Buffer.from("MZold API")});
  const source = path.join(f.sourceRoot, "game.pck");fs.renameSync(f.source, source);f.entry.moduleData.packPath = source;f.entry.gamePath = source;
  const prepared = await Mono.prepare(f.entry, {...f.options, target: {kind: "pack", path: source}});
  assert.notEqual(path.basename(prepared.target.path), "game.pck");assert.equal(fs.lstatSync(path.join(prepared.cwd, "game.pck")).isSymbolicLink(), false);
  fs.writeFileSync(path.join(prepared.cwd, "game.pck"), "private relative write");
  assert.deepEqual(fs.readFileSync(source), f.value.buffer);
  Pack.open(prepared.target.path, {offset: f.value.offset, size: f.value.size}, (_fd, parsed) => {
    assert.equal(parsed.entries.has(".mono/assemblies/Debug/GodotSharp.dll"), false);assert.ok(parsed.entries.has("project.binary"));
  });
});
test("unchanged Mono Play reads no API DLL bytes or recopies assets; changed external sibling input gets a fresh cache", async t => {
  const f = fixture(t), prepared = await Mono.prepare(f.entry, f.options), read = fs.readFileSync, copy = fs.copyFileSync;
  try {
    fs.readFileSync = function (file, ...args) {if (/GodotSharp(?:Editor)?\.dll$/.test(String(file))) assert.fail("Warm preparation must use validated file identities");return read.call(this, file, ...args);};
    fs.copyFileSync = () => assert.fail("Warm preparation must not copy game assets");
    assert.deepEqual(await Mono.prepare(f.entry, f.options), prepared);
  } finally {fs.readFileSync = read;fs.copyFileSync = copy;}
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "publisher changed config");
  const updated = await Mono.prepare(f.entry, f.options);assert.notEqual(updated.cwd, prepared.cwd);
  assert.equal(fs.readFileSync(path.join(updated.cwd, "external.cfg"), "utf8"), "publisher changed config");
});
test("existing Godot coordinator ownership protects active caches; retirement keeps current, fallback and modified data", async t => {
  const f = fixture(t), coordinator = createRuntimeCoordinator(), owner = coordinator.client("mono-game"), writer = coordinator.client("mono-cleanup");
  const withRuntimeMutation = async (identity, work) => {const token = await writer.acquireMutation(identity);try {return await work();} finally {await writer.release(token);}};
  const options = {...f.options, withRuntimeMutation};
  const first = await Mono.prepare(f.entry, options), active = await owner.acquireUse({managerId: "godot", version: "3.5.2-stable", variant: "mono", sourcePath: f.appPath});
  await owner.bindUse(active, process.pid);t.after(() => owner.release(active));
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "second publisher revision");const second = await Mono.prepare(f.entry, options);
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "third publisher revision");const third = await Mono.prepare(f.entry, options);
  await third.retire();assert.equal(fs.existsSync(first.cwd), true, "an actual bound Godot runtime protects its derived caches");
  await owner.release(active);await third.retire();assert.equal(fs.existsSync(first.cwd), false);assert.ok(fs.existsSync(second.cwd));assert.ok(fs.existsSync(third.cwd));
  fs.writeFileSync(path.join(second.cwd, "Save.cfg"), "actual game state");
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "fourth publisher revision");const fourth = await Mono.prepare(f.entry, options);await fourth.retire();
  assert.equal(fs.readFileSync(path.join(second.cwd, "Save.cfg"), "utf8"), "actual game state");assert.ok(fs.existsSync(third.cwd));assert.ok(fs.existsSync(fourth.cwd));
  let calls = 0;fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "fifth publisher revision");
  const fifth = await Mono.prepare(f.entry, {...f.options, withRuntimeMutation: () => {calls++;throw Error("Cleanup unavailable");}});
  assert.equal(calls, 0, "optional cleanup cannot wait or reject before Play");await fifth.retire();assert.ok(calls > 0);assert.ok(fs.existsSync(fifth.cwd));
});
test("ordinary launch defers optional cache cleanup until the owned child's retirement finishes", async t => {
  const f = fixture(t);let mutations = 0;
  const withRuntimeMutation = async (_identity, work) => {mutations++;return work();};
  const options = {...f.options, withRuntimeMutation};
  await Mono.prepare(f.entry, options);
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "second");await Mono.prepare(f.entry, options);
  fs.writeFileSync(path.join(f.sourceRoot, "external.cfg"), "third");
  const child = new EventEmitter();child.pid = process.pid;child.exitCode = null;child.signalCode = null;
  let finish;child.runtimeRetirement = new Promise(resolve => {finish = resolve;});
  const launched = await Godot.launchRuntime("godot", f.entry, {userDataDir: f.userDataDir, settings: {runtimes: {godot: {defaultVariant: "mono"}}},
    withRuntimeMutation, spawnDetachedChecked: async () => ({child})});
  assert.equal(launched.child, child);assert.equal(mutations, 0);
  child.exitCode = 0;child.emit("close", 0);await new Promise(setImmediate);assert.equal(mutations, 0, "root close alone is not permission to retire still-consumed resources");
  finish();await new Promise(setImmediate);assert.ok(mutations > 0);
});
