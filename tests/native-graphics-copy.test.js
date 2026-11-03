const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const NativeApplication = require("../src/modules/shared/native-application");
const Injection = require("../src/modules/shared/runtime/native-injection");

const machO = fileType => { const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(fileType, 12); return bytes; };
const plist = keys => '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' + keys.map(([key, value]) => `<key>${key}</key>${value}`).join("") + "</dict></plist>";
const write = (file, contents, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); if (mode) fs.chmodSync(file, mode); };
function digest(root) {
  const rows = [];
  const walk = directory => { for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) walk(file);
    else rows.push([path.relative(root, file), stat.isSymbolicLink() ? fs.readlinkSync(file) : crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
  } };
  walk(root);
  return JSON.stringify(rows);
}

// A notarized-style app: hardened main executable and helper, a library, a
// script, resources and an earlier signature, with game data beside the app.
function fixture(t, { sandbox = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-copy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "Games"), app = path.join(folder, "Game.app"), contents = path.join(app, "Contents");
  write(path.join(contents, "Info.plist"), plist([["CFBundleExecutable", "<string>Game</string>"], ["CFBundleIdentifier", "<string>com.example.game</string>"]]));
  write(path.join(contents, "PkgInfo"), "APPL????");
  write(path.join(contents, "_CodeSignature", "CodeResources"), "publisher seal");
  write(path.join(contents, "MacOS", "Game"), machO(2), 0o755);
  write(path.join(contents, "MacOS", "steam_appid.txt"), "480");
  fs.symlinkSync("Game", path.join(contents, "MacOS", "Alias"));
  write(path.join(contents, "Helpers", "crash"), machO(2), 0o755);
  write(path.join(contents, "Helpers", "tool.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  write(path.join(contents, "Frameworks", "libgame.dylib"), machO(6), 0o755);
  write(path.join(contents, "Resources", "data.txt"), "resources");
  write(path.join(folder, "base", "pak0.txt"), "game data beside the app");
  const userDataDir = path.join(root, "data"), effects = path.join(userDataDir, "games", "game-1", "effects");
  fs.mkdirSync(effects, { recursive: true });
  const entitlements = plist([["com.apple.application-identifier", "<string>ABC.com.example.game</string>"],
    ["com.apple.developer.team-identifier", "<string>ABC</string>"], ["com.apple.security.cs.allow-jit", "<true/>"],
    ["com.apple.security.device.audio-input", "<true/>"], ...(sandbox ? [["com.apple.security.app-sandbox", "<true/>"]] : [])]);
  const calls = [];
  // codesign and PlistBuddy, faked: the original files report a hardened
  // signature and signing appends a marker to the signed code.
  const execute = async (command, args) => {
    if (command === "/usr/bin/codesign" && args[0] === "--display") {
      const file = args.at(-1), copied = !file.startsWith(folder + path.sep);
      if (copied) return { stdout: "", stderr: "flags=0x2(adhoc)" };
      return { stdout: path.basename(file) === "Game" ? entitlements : "", stderr: "flags=0x10000(runtime)\nTeamIdentifier=ABC" };
    }
    if (command === "/usr/libexec/PlistBuddy") {
      const key = args[1].replace(/^Delete :/, ""), file = args[2];
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(new RegExp(`<key>${key.replace(/\./g, "\\.")}</key><string>[^<]*</string>`), ""));
      calls.push(["plistbuddy", key]);
      return { stdout: "", stderr: "" };
    }
    if (command === "/usr/bin/codesign" && args[0] === "--force") {
      const target = args.at(-1), index = args.indexOf("--entitlements");
      calls.push(["sign", target, index < 0 ? null : fs.readFileSync(args[index + 1], "utf8"), args.slice(0, 6)]);
      const code = fs.statSync(target).isDirectory() ? path.join(target, "Contents", "MacOS", "Game") : target;
      fs.appendFileSync(code, "signed");
      if (fs.statSync(target).isDirectory()) write(path.join(target, "Contents", "_CodeSignature", "CodeResources"), "ad hoc seal");
      return { stdout: "", stderr: "" };
    }
    throw new Error("Unexpected command " + command);
  };
  return { root, folder, app, contents, userDataDir, effects, directory: path.join(effects, "app-copy"), execute, calls };
}
const executables = (f, execute = f.execute) => async () => [path.join(f.contents, "MacOS", "Game"), ...await Injection.blockingExecutables(f.app, [], { execute })];

test("signature facts include the sandbox and entitlements that a copy carries", () => {
  const facts = Injection.parseSignature("flags=0x10000(runtime)\n" + plist([["com.apple.security.app-sandbox", "<true/>"]]));
  assert.equal(facts.sandbox, true);
  assert.match(facts.entitlements, /^<\?xml.*<\/plist>$/);
  assert.equal(Injection.parseSignature("flags=0x2(adhoc)").entitlements, null);
});

test("the copy unit is the outermost bundle around an executable, or the file itself", t => {
  const f = fixture(t);
  const nested = path.join(f.contents, "Resources", "Inner.app", "Contents");
  write(path.join(nested, "Info.plist"), plist([["CFBundleExecutable", "<string>Inner</string>"]]));
  write(path.join(nested, "MacOS", "Inner"), machO(2), 0o755);
  assert.equal(NativeApplication.copyUnit(path.join(f.contents, "MacOS", "Game")), f.app);
  assert.equal(NativeApplication.copyUnit(path.join(nested, "MacOS", "Inner")), f.app);
  assert.equal(NativeApplication.copyUnit(path.join(f.folder, "base", "pak0.txt")), path.join(f.folder, "base", "pak0.txt"));
});

test("blocking executables are the hardened Mach-O programs, not libraries or scripts", async t => {
  const f = fixture(t);
  assert.deepEqual(await Injection.blockingExecutables(f.app, [], { execute: f.execute }),
    [path.join(f.contents, "Helpers", "crash"), path.join(f.contents, "MacOS", "Game")]);
});

test("a graphics copy re-signs only blocking code, aliases everything else and leaves the original untouched", async t => {
  const f = fixture(t), before = digest(f.folder);
  const prepared = await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  const copy = path.join(f.directory, "root", "Game.app"), contents = path.join(copy, "Contents");
  assert.equal(prepared.app, copy);
  assert.equal(digest(f.folder), before, "The original app and its folder are unchanged");
  // Code that is signed again, and each signed bundle's Info.plist, are real files.
  assert.ok(fs.lstatSync(path.join(contents, "Info.plist")).isFile());
  assert.equal(fs.readFileSync(path.join(contents, "MacOS", "Game"), "utf8"), machO(2).toString("utf8") + "signed");
  assert.equal(fs.readFileSync(path.join(contents, "Helpers", "crash"), "utf8"), machO(2).toString("utf8") + "signed");
  assert.equal(fs.readFileSync(path.join(contents, "_CodeSignature", "CodeResources"), "utf8"), "ad hoc seal");
  for (const relative of ["Resources", "Frameworks", "PkgInfo", "MacOS/steam_appid.txt", "Helpers/tool.sh"])
    assert.equal(fs.readlinkSync(path.join(contents, relative)), path.join(f.contents, relative));
  assert.equal(fs.readlinkSync(path.join(contents, "MacOS", "Alias")), "Game");
  assert.equal(fs.readlinkSync(path.join(f.directory, "root", "base")), path.join(f.folder, "base"));
  assert.equal(fs.readFileSync(path.join(f.directory, "root", "base", "pak0.txt"), "utf8"), "game data beside the app");
  // Nested code is signed before its bundle, ad hoc and without option flags.
  const signs = f.calls.filter(call => call[0] === "sign");
  // Signing happens in a private stage before the copy is published.
  assert.deepEqual(signs.map(call => call[1].replace(/^.*\/\.stage-[^/]+\/root\/Game\.app\/?/, "")), [path.join("Contents", "Helpers", "crash"), ""]);
  assert.deepEqual(signs[1][3], ["--force", "--sign", "-", "--timestamp=none", "--options", "0"]);
  assert.equal(signs[0][2], null);
  assert.doesNotMatch(signs[1][2], /application-identifier|team-identifier/);
  assert.match(signs[1][2], /com\.apple\.security\.cs\.allow-jit.*com\.apple\.security\.device\.audio-input/);
  assert.deepEqual(prepared.droppedEntitlements, ["com.apple.application-identifier", "com.apple.developer.team-identifier"]);
  // Only the signed executable changes. Module-selected data, cwd and
  // environment retain their original paths, even when inside the app.
  const executable = path.join(f.contents, "MacOS", "Game");
  const args = ["-data", path.join(f.app, "Contents", "Resources"), "-flag"];
  const options = { cwd: path.dirname(executable), env: { LIBRARIES: [f.contents + "/Frameworks", "/usr/lib"].join(":"), KEEP: "yes" } };
  const launched = prepared.launch({ command: executable, args, options });
  assert.equal(launched.command, path.join(contents, "MacOS", "Game"));
  assert.equal(launched.args, args);
  assert.equal(launched.options, options);
  assert.equal(fs.readFileSync(path.join(launched.args[1], "data.txt"), "utf8"), "resources");
  // dhewm3 derives its base path from the bundle's parent and changes cwd
  // internally. Required compatibility aliases must cover that lookup too.
  assert.equal(fs.readFileSync(path.join(path.dirname(prepared.app), "base", "pak0.txt"), "utf8"), "game data beside the app");
  assert.equal(prepared.map("/elsewhere/file"), "/elsewhere/file");
});

test("an unchanged original reuses its copy, and new items beside it appear", async t => {
  const f = fixture(t);
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  const root = path.join(f.directory, "root");
  write(path.join(root, "config.cfg"), "written by the game");
  write(path.join(f.folder, "mods", "mod.txt"), "added later");
  fs.rmSync(path.join(f.folder, "base"), { recursive: true });
  f.calls.length = 0;
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: async () => assert.fail("An intact copy is reused") }, f.execute);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readlinkSync(path.join(root, "mods")), path.join(f.folder, "mods"));
  assert.equal(fs.existsSync(path.join(root, "base")), false);
  assert.equal(fs.readFileSync(path.join(root, "config.cfg"), "utf8"), "written by the game");
});

test("unchanged sibling data reuses its directory identity without listing or linking again", async t => {
  const f = fixture(t);
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const receipt = fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), readdir = fs.promises.readdir;
  // The existing alias exposes changes inside a data folder without a
  // repeated listing of the original app's parent or any data copy.
  write(path.join(f.folder, "base", "pak0.txt"), "updated original data");
  t.mock.method(fs.promises, "readdir", (directory, ...args) => {
    assert.notEqual(path.resolve(directory), f.folder, "An unchanged original parent is not enumerated");
    return readdir(directory, ...args);
  });
  t.mock.method(fs.promises, "symlink", () => assert.fail("Warm copies must not rebuild data aliases"));
  f.calls.length = 0;
  await prepare();
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), receipt);
  assert.equal(fs.readFileSync(path.join(path.dirname(path.join(f.directory, "root", "Game.app")), "base", "pak0.txt"), "utf8"), "updated original data");
});

test("an existing owned sibling alias can be repaired without replacing private data", async t => {
  const f = fixture(t);
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const root = path.join(f.directory, "root");
  fs.unlinkSync(path.join(root, "base"));
  write(path.join(root, "private.cfg"), "game-owned settings");
  await prepare();
  assert.equal(fs.readlinkSync(path.join(root, "base")), path.join(f.folder, "base"));
  assert.equal(fs.readFileSync(path.join(root, "private.cfg"), "utf8"), "game-owned settings");
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
});

test("an updated original or a damaged copy is made again, and the earlier copy goes through the trash", async t => {
  const f = fixture(t);
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  const root = path.join(f.directory, "root"), copied = path.join(root, "Game.app", "Contents", "MacOS", "Game");
  write(path.join(root, "config.cfg"), "written by the game");
  // An app update replaces the executable.
  const update = path.join(f.contents, "MacOS", "Game.new");
  write(update, Buffer.concat([machO(2), Buffer.from("version 2")]), 0o755);
  fs.renameSync(update, path.join(f.contents, "MacOS", "Game"));
  let made = 0;
  const refreshed = await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory,
    executables: async () => { made++; return executables(f, async (command, args) => f.execute(command, args))(); } }, f.execute);
  assert.equal(made, 1);
  assert.match(fs.readFileSync(copied, "utf8"), /version 2signed$/);
  assert.equal(fs.readFileSync(path.join(root, "config.cfg"), "utf8"), "written by the game");
  assert.deepEqual(fs.readdirSync(f.effects).filter(name => name.startsWith(".maclauncher-trash-")), []);
  // A changed copy is replaced from the original as well.
  fs.writeFileSync(copied, "damaged");
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: async () => { made++; return [path.join(f.contents, "MacOS", "Game")]; } }, f.execute);
  assert.equal(made, 2);
  assert.match(fs.readFileSync(copied, "utf8"), /version 2signed$/);
  assert.equal(refreshed.app, path.join(root, "Game.app"));
});

test("a copy is released through the trash only for its own app", async t => {
  const f = fixture(t);
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  assert.equal(await NativeApplication.releaseCopy(f.directory, path.join(f.folder, "Other.app")), false);
  assert.ok(fs.existsSync(f.directory));
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), true);
  assert.deepEqual(fs.readdirSync(f.effects), []);
  assert.ok(fs.existsSync(path.join(f.folder, "base", "pak0.txt")), "Removing the copy never follows its aliases");
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
});

test("refresh preserves changed executable and Info.plist bytes apart from runnable code", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const code = path.join(root, "Game.app/Contents/MacOS/Game"), info = path.join(root, "Game.app/Contents/Info.plist");
  fs.writeFileSync(code, "a self-updater's replacement executable");
  // Atomic replacement has a new inode, as well as new contents.
  write(info + ".new", "a self-updater's replacement Info.plist"); fs.renameSync(info + ".new", info);
  const original = digest(f.folder);
  await prepare();
  assert.equal(fs.readFileSync(code, "utf8"), machO(2).toString("utf8") + "signed");
  assert.equal(fs.readFileSync(info, "utf8"), fs.readFileSync(path.join(f.contents, "Info.plist"), "utf8"));
  const recovered = path.join(f.directory, "recovered"), snapshots = fs.readdirSync(recovered);
  assert.equal(snapshots.length, 1);
  const files = path.join(recovered, snapshots[0], "files");
  assert.equal(fs.readFileSync(path.join(files, "Game.app/Contents/MacOS/Game"), "utf8"), "a self-updater's replacement executable");
  assert.equal(fs.readFileSync(path.join(files, "Game.app/Contents/Info.plist"), "utf8"), "a self-updater's replacement Info.plist");
  assert.ok(fs.lstatSync(path.join(files, "Game.app/Contents/MacOS/Game")).isFile());
  assert.equal(digest(f.folder), original);
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
  assert.equal(fs.readFileSync(path.join(files, "Game.app/Contents/MacOS/Game"), "utf8"), "a self-updater's replacement executable");
});

test("a failed preservation copy leaves the modified code and receipt intact", async t => {
  const f = fixture(t), root = path.join(f.directory, "root"), CopyFile = require("../src/modules/shared/copy-file");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const code = path.join(root, "Game.app/Contents/MacOS/Game"); fs.writeFileSync(code, "private update");
  const before = digest(root), receipt = fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), clone = CopyFile.cloneOrCopy;
  t.mock.method(CopyFile, "cloneOrCopy", async (source, ...args) => {
    if (source === code) throw new Error("fixture preservation copy failure");
    return clone(source, ...args);
  });
  await assert.rejects(prepare(), /fixture preservation copy failure/);
  assert.equal(digest(root), before);
  assert.equal(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), receipt);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["copy.json", "root"]);
});

test("a failed preservation publication never replaces the old root", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  fs.writeFileSync(path.join(root, "Game.app/Contents/MacOS/Game"), "private update");
  const before = digest(root), receipt = fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), rename = fs.promises.rename;
  t.mock.method(fs.promises, "rename", async (source, target) => {
    if (path.dirname(target) === path.join(f.directory, "recovered")) throw new Error("fixture preservation publish failure");
    return rename(source, target);
  });
  await assert.rejects(prepare(), /fixture preservation publish failure/);
  assert.equal(digest(root), before);
  assert.equal(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), receipt);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, "recovered")), []);
});

test("root publication failure retains preserved changes and a retry reuses their snapshot", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  fs.writeFileSync(path.join(root, "Game.app/Contents/MacOS/Game"), "private update");
  const before = digest(root), rename = fs.promises.rename;
  let failed = false;
  t.mock.method(fs.promises, "rename", async (source, target) => {
    if (!failed && target === root && source.includes(path.sep + ".stage-")) { failed = true; throw new Error("fixture publish failure"); }
    return rename(source, target);
  });
  await assert.rejects(prepare(), /fixture publish failure/);
  assert.equal(digest(root), before);
  const recovered = path.join(f.directory, "recovered"), snapshot = fs.readdirSync(recovered)[0];
  assert.equal(fs.readFileSync(path.join(recovered, snapshot, "files/Game.app/Contents/MacOS/Game"), "utf8"), "private update");
  await prepare();
  assert.deepEqual(fs.readdirSync(recovered), [snapshot]);
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/Game"), "utf8"), machO(2).toString("utf8") + "signed");
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
});

test("only aged duplicate-only stages from dead preparations can be discarded", async t => {
  const f = fixture(t);
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const old = new Date(Date.now() - 2 * 86400000);
  for (const [name, marked, aged, pid] of [["LEGACY", false, true, 2147483647], ["OLD123", true, true, 2147483647],
    ["NEW123", true, false, 2147483647], ["LIVE12", true, true, process.pid]]) {
    const stage = path.join(f.directory, ".stage-" + name);
    write(path.join(stage, "root/private.dat"), "staged bytes " + name);
    if (marked) write(path.join(stage, "copy-stage.json"), JSON.stringify({ schema: 1, duplicateOnly: true, pid }));
    if (aged) fs.utimesSync(stage, old, old);
  }
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  await prepare();
  assert.equal(fs.existsSync(path.join(f.directory, ".stage-OLD123")), false);
  for (const name of ["LEGACY", "NEW123", "LIVE12"])
    assert.equal(fs.readFileSync(path.join(f.directory, ".stage-" + name, "root/private.dat"), "utf8"), "staged bytes " + name);
});

test("interrupted copy cleanup leaves only declared effects trash and recovery remains usable", async t => {
  const f = fixture(t), root = path.join(f.directory, "root"), Storage = require("../src/core/storage-maintenance");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  write(path.join(root, "Game.app/Contents/MacOS/save.dat"), "saved game");
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  const remove = Storage.removeTrash, warnings = [];
  let fail = true;
  t.mock.method(Storage, "removeTrash", async file => {
    if (fail) { fail = false; throw new Error("fixture interrupted cleanup"); }
    return remove(file);
  });
  t.mock.method(console, "warn", message => warnings.push(message));
  await prepare();
  assert.match(warnings[0], /fixture interrupted cleanup/);
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/save.dat"), "utf8"), "saved game");
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith(".maclauncher-trash-")), false);
  assert.equal(fs.readdirSync(f.effects).filter(name => Storage.TRASH.test(name)).length, 1);
  assert.ok(fs.existsSync(path.join(f.directory, "copy-publication.json")));
  await prepare();
  assert.equal(fs.existsSync(path.join(f.directory, "copy-publication.json")), false);
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/save.dat"), "utf8"), "saved game");
  // Cleanup is optional: even its failure cannot prevent a valid refresh.
  const stage = path.join(f.directory, ".stage-OLD123"), old = new Date(Date.now() - 2 * 86400000);
  write(path.join(stage, "root/duplicate.dat"), "disposable duplicate");
  write(path.join(stage, "copy-stage.json"), JSON.stringify({ schema: 1, duplicateOnly: true, pid: 2147483647 }));
  fs.utimesSync(stage, old, old);
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated again");
  fail = true;
  await prepare();
  assert.match(warnings[1], /Earlier graphics-copy staging.*fixture interrupted cleanup/);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith(".maclauncher-trash-")), false);
  assert.equal(fs.readdirSync(f.effects).filter(name => Storage.TRASH.test(name)).length, 2);
  assert.match(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/Game"), "utf8"), /updated againsigned$/);
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/save.dat"), "utf8"), "saved game");
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
});

test("refresh keeps private files in every real directory and replacements of aliases", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const writes = ["config.cfg", "Game.app/new.cfg", "Game.app/Contents/settings.cfg", "Game.app/Contents/MacOS/saves/slot.dat", "Game.app/Contents/Helpers/custom.cfg"];
  for (const relative of writes) write(path.join(root, relative), relative);
  const replaced = path.join(root, "Game.app/Contents/MacOS/steam_appid.txt");
  fs.unlinkSync(replaced); write(replaced, "private replacement");
  const alias = path.join(root, "Game.app/Contents/MacOS/Alias");
  fs.unlinkSync(alias); fs.symlinkSync("saves/slot.dat", alias);
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  const original = digest(f.folder);
  await prepare();
  for (const relative of writes) assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), relative);
  assert.equal(fs.readFileSync(replaced, "utf8"), "private replacement");
  assert.equal(fs.readlinkSync(alias), "saves/slot.dat");
  assert.equal(digest(f.folder), original, "Carrying private data never writes through original aliases");
  // Carry the same files again: they must never become launcher-owned entries.
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated again");
  await prepare();
  assert.equal(fs.readFileSync(path.join(root, writes[3]), "utf8"), writes[3]);
  assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
});

test("a private sibling folder wins a collision with a newly added original sibling", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  write(path.join(root, "mods/private.dat"), "private mod");
  write(path.join(f.folder, "mods/public.dat"), "new original mod");
  await prepare(); // The intact-copy alias refresh also preserves the folder.
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  await prepare();
  assert.ok(fs.lstatSync(path.join(root, "mods")).isDirectory());
  assert.equal(fs.readFileSync(path.join(root, "mods/private.dat"), "utf8"), "private mod");
  assert.equal(fs.existsSync(path.join(root, "mods/public.dat")), false);
  assert.equal(fs.readFileSync(path.join(f.folder, "mods/public.dat"), "utf8"), "new original mod");
});

test("private descendants survive when an old real directory becomes an original alias", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  write(path.join(root, "Game.app/Contents/Helpers/private.cfg"), "private");
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  const original = digest(f.folder);
  await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory,
    executables: async () => [path.join(f.contents, "MacOS/Game")] }, f.execute);
  assert.ok(fs.lstatSync(path.join(root, "Game.app/Contents/Helpers")).isDirectory());
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/Helpers/private.cfg"), "utf8"), "private");
  assert.equal(digest(f.folder), original);
});

test("a private-data carry failure leaves the old root and receipt intact", async t => {
  const f = fixture(t), root = path.join(f.directory, "root"), CopyFile = require("../src/modules/shared/copy-file");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const privateFile = path.join(root, "Game.app/Contents/MacOS/save.dat");
  write(privateFile, "saved game");
  const before = digest(root), receipt = fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), clone = CopyFile.cloneOrCopy;
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  t.mock.method(CopyFile, "cloneOrCopy", async (source, ...args) => {
    if (source === privateFile) throw new Error("fixture carry failure");
    return clone(source, ...args);
  });
  await assert.rejects(prepare(), /fixture carry failure/);
  assert.equal(digest(root), before);
  assert.equal(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), receipt);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["copy.json", "root"]);
});

test("a failed root publication rolls back the old copy with all private data", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  write(path.join(root, "Game.app/Contents/MacOS/save.dat"), "saved game");
  const before = digest(root), receipt = fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), rename = fs.promises.rename;
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  t.mock.method(fs.promises, "rename", async (source, target) => {
    if (target === root && source.includes(path.sep + ".stage-")) throw new Error("fixture publish failure");
    return rename(source, target);
  });
  await assert.rejects(prepare(), /fixture publish failure/);
  assert.equal(digest(root), before);
  assert.equal(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"), receipt);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["copy.json", "root"]);
});

test("a failed receipt publication rolls back even after the new root was installed", async t => {
  const f = fixture(t), root = path.join(f.directory, "root"), receiptFile = path.join(f.directory, "copy.json");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  write(path.join(root, "config.cfg"), "private");
  const before = digest(root), receipt = fs.readFileSync(receiptFile, "utf8"), rename = fs.renameSync;
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  let failed = false;
  t.mock.method(fs, "renameSync", (source, target) => {
    if (target === receiptFile && !failed) { failed = true; throw new Error("fixture receipt failure"); }
    return rename(source, target);
  });
  await assert.rejects(prepare(), /fixture receipt failure/);
  assert.equal(digest(root), before);
  assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["copy.json", "root"]);
});

test("release retains private nested files, replaced aliases and modified copied code", async t => {
  for (const kind of ["nested", "alias", "code"]) await t.test(kind, async t => {
    const f = fixture(t), root = path.join(f.directory, "root");
    await NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
    if (kind === "nested") write(path.join(root, "Game.app/Contents/MacOS/save.dat"), "saved game");
    else if (kind === "alias") { fs.unlinkSync(path.join(root, "base")); write(path.join(root, "base/save.dat"), "saved game"); }
    else fs.writeFileSync(path.join(root, "Game.app/Contents/MacOS/Game"), "private executable replacement");
    const before = digest(root);
    assert.equal(await NativeApplication.releaseCopy(f.directory, f.app), false);
    assert.equal(digest(root), before);
  });
});

test("a pending publication recovers the previous root before reuse", async t => {
  const f = fixture(t), root = path.join(f.directory, "root");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  write(path.join(root, "Game.app/Contents/MacOS/save.dat"), "saved game");
  const before = digest(root), receipt = JSON.parse(fs.readFileSync(path.join(f.directory, "copy.json"), "utf8"));
  const id = crypto.randomUUID(), previous = ".previous-" + id;
  fs.renameSync(root, path.join(f.directory, previous));
  write(path.join(root, "uncommitted.txt"), "new root without a committed receipt");
  write(path.join(f.directory, "copy-publication.json"), JSON.stringify({ id, previous, hadRoot: true, receipt }));
  await prepare();
  assert.equal(digest(root), before);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["copy.json", "root"]);
});

test("legacy receipts preserve private nested entries on their first refresh", async t => {
  const f = fixture(t), root = path.join(f.directory, "root"), receiptFile = path.join(f.directory, "copy.json");
  const prepare = () => NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute);
  await prepare();
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")); delete receipt.owned;
  write(receiptFile, JSON.stringify(receipt));
  write(path.join(root, "Game.app/Contents/MacOS/save.dat"), "saved game");
  fs.appendFileSync(path.join(f.contents, "MacOS/Game"), "updated");
  await prepare();
  assert.equal(fs.readFileSync(path.join(root, "Game.app/Contents/MacOS/save.dat"), "utf8"), "saved game");
});

test("an App Sandbox app is not copied, because its container belongs to the original signature", async t => {
  const f = fixture(t, { sandbox: true });
  await assert.rejects(NativeApplication.prepareCopy({ unit: f.app, directory: f.directory, executables: executables(f) }, f.execute),
    /App Sandbox\. macOS ties its data container to the original signature/);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(f.calls, []);
});

function launcherFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-copy-launch-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Game.app"), executable = path.join(app, "Contents", "MacOS", "Game");
  write(path.join(app, "Contents", "Info.plist"), plist([["CFBundleExecutable", "<string>Game</string>"]]));
  write(executable, machO(2), 0o755);
  const userDataDir = path.join(root, "data"), spawned = [], reason = "The executable's hardened runtime does not allow DYLD graphics attachment.";
  const ReShade = require("../src/modules/shared/reshade"), Live = require("../src/modules/shared/reshade/live-controls");
  const manifest = { id: "probe", gameType: "native", runtime: { default: "native", supported: ["native"], entries: { native: { graphicsHost: "window" } } } };
  const registry = { listModules: () => [manifest], getModule: () => ({ id: "probe", manifest }), getModuleInfo: () => manifest };
  const launcher = require("../src/core/launcher").createLauncher({ userDataDir, registry, logger: { warn() {}, info() {} },
    rosetta: { requiresForExecutable: () => false, isAvailable: () => true }, spawn(command, args, options) {
      spawned.push({ command, args, options }); const child = new EventEmitter(); child.pid = 61000 + spawned.length;
      child.unref = () => queueMicrotask(() => child.emit("spawn")); return child;
    } });
  t.mock.method(ReShade, "prepare", async entry => {
    const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json"); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, phase: "prepared", launchId: entry.gameId, effectPlanAPI: 1 }));
    return { DYLD_INSERT_LIBRARIES: "/owned/graphics.dylib", RESHADE_EFFECT_PLAN: "/owned/plan" };
  });
  t.mock.method(Injection, "preflight", async target => target === executable ? { available: false, reason } : { available: true });
  const effects = enabled => ({ schema: 2, mode: "advanced", enabled, video: [{ id: "gray", kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }] });
  const entry = enabled => ({ gameId: "copy-test", gamePath: app, moduleId: "probe", runtimeId: "native", networkAccess: true, effects: effects(enabled) });
  return { root, app, executable, userDataDir, spawned, reason, launcher, entry, directory: path.join(userDataDir, "games", "copy-test", "effects", "app-copy") };
}

test("Play with graphics runs a blocked app from its private copy with the processor attached", async t => {
  const f = launcherFixture(t), copy = path.join(f.directory, "root", "Game.app"), requests = [];
  t.mock.method(NativeApplication, "prepareCopy", async request => {
    requests.push(request);
    const map = value => typeof value === "string" && (value === f.app || value.startsWith(f.app + path.sep)) ? copy + value.slice(f.app.length) : value;
    return { app: copy, map, droppedEntitlements: [], launch: ({ command, args, options }) =>
      ({ command: map(command), args, options }) };
  });
  const context = f.launcher.getGameLaunchContext(f.entry(true), {});
  await context.spawnDetachedChecked(f.executable, ["-root", f.app], { cwd: path.dirname(f.executable), env: { GAME_ROOT: f.app } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].unit, f.app);
  assert.equal(requests[0].directory, f.directory);
  const launch = f.spawned[0];
  assert.equal(launch.command, path.join(copy, "Contents", "MacOS", "Game"));
  assert.deepEqual(launch.args, ["-root", f.app]);
  assert.equal(launch.options.cwd, path.dirname(f.executable));
  assert.equal(launch.options.env.GAME_ROOT, f.app);
  assert.equal(launch.options.env.DYLD_INSERT_LIBRARIES, "/owned/graphics.dylib");
  assert.equal(launch.options.env.RESHADE_EFFECT_PLAN, "/owned/plan");
  assert.equal(context.graphicsPreparationFailure, undefined);
  assert.equal(context.launchedPath(f.executable), path.join(copy, "Contents", "MacOS", "Game"));
});

test("a copy that cannot be made keeps the original launch, without the processor, and names both reasons", async t => {
  const f = launcherFixture(t);
  t.mock.method(NativeApplication, "prepareCopy", async () => { throw new Error("codesign could not sign the copy."); });
  const context = f.launcher.getGameLaunchContext(f.entry(true), {});
  await context.spawnDetachedChecked(f.executable, [], { cwd: path.dirname(f.executable), env: {} });
  assert.equal(f.spawned[0].command, f.executable);
  assert.equal(Object.hasOwn(f.spawned[0].options.env, "RESHADE_EFFECT_PLAN"), false);
  assert.equal(context.graphicsPreparationFailure.reason, f.reason + " A private copy for graphics could not be used: codesign could not sign the copy.");
  assert.equal(context.launchedPath(f.executable), f.executable);
});

test("Play with graphics off runs the original and removes a copy it no longer needs", async t => {
  const f = launcherFixture(t), released = [];
  t.mock.method(NativeApplication, "prepareCopy", async () => assert.fail("Graphics off never prepares a copy"));
  t.mock.method(NativeApplication, "releaseCopy", async (directory, unit) => { released.push([directory, unit]); return true; });
  const context = f.launcher.getGameLaunchContext(f.entry(false), {});
  await context.spawnDetachedChecked(f.executable, [], { cwd: path.dirname(f.executable), env: {} });
  assert.equal(f.spawned[0].command, f.executable);
  assert.equal(f.spawned[0].options.cwd, path.dirname(f.executable));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [[f.directory, f.app]]);
});

test("window activation follows the executable the launch actually ran", async () => {
  const { spawnForegroundNativeGame } = require("../src/modules/shared/runtime/native-focus");
  const child = new EventEmitter(), focused = [];
  const context = { spawnDetachedChecked: async () => child, launchedPath: file => file.replace("/Original/", "/Copy/") };
  await spawnForegroundNativeGame({ context, executablePath: "/Original/Game.app/Contents/MacOS/Game" },
    { focus: (_child, options) => { focused.push(options.executablePath); return Promise.resolve({}); }, platform: "darwin" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(focused, ["/Copy/Game.app/Contents/MacOS/Game"]);
});
