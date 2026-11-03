const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Godot = require("../src/modules/godot/backcompat");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-mirror-descriptors-"))), remove = fs.rmSync;
  t.after(() => remove(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), original = path.join(root, "original-project");fs.mkdirSync(userDataDir);
  const entry = {gameId: "godot-game", moduleId: "godot", gamePath: original, moduleData: {projectRoot: original}};
  const moduleRoot = path.join(userDataDir, "games/godot-game/modules/godot");
  const mkdir = relative => {const directory = path.join(moduleRoot, relative);fs.mkdirSync(directory, {recursive: true});return directory;};
  return {root, original, userDataDir, entry, moduleRoot, mkdir};
}
const descriptor = (mirrorRoot, sourceRoot, generated = []) => ({mirrorRoot, sourceRoot, generated});

test("Godot descriptors cover exact old Mono and import views before their parent metadata", t => {
  const f = fixture(t), mono = "a".repeat(24), project = "b".repeat(20);
  const monoRoot = f.mkdir("mono-projects/" + mono), projectRoot = f.mkdir("source-projects/" + project);
  for (const child of ["project", "preserved-" + "c".repeat(16), ".preparing-ABC123/project"]) f.mkdir("mono-projects/" + mono + "/" + child);
  for (const child of ["project", "previous", "preparing-" + "d".repeat(16), "editor-home"]) f.mkdir("source-projects/" + project + "/" + child);
  const recorded = path.join(f.root, "recorded-original");
  fs.writeFileSync(path.join(projectRoot, "prepared.json"), JSON.stringify({schemaVersion: 1, source: recorded}));
  for (const current of ["mono-packs/" + "e".repeat(24), "packs", "gdre", "reports", "runtimes", "icons"]) f.mkdir(current);
  const before = JSON.stringify(f.entry), rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  assert.deepEqual(rows, [
    {mirrorRoot: path.join(f.moduleRoot, "writable-input/files"), sourceRoot: f.original},
    descriptor(path.join(monoRoot, ".preparing-ABC123/project"), f.original),
    descriptor(path.join(monoRoot, ".preparing-ABC123"), f.original, ["prepared.json"]),
    descriptor(path.join(monoRoot, "preserved-" + "c".repeat(16)), f.original),
    descriptor(path.join(monoRoot, "project"), f.original),
    descriptor(monoRoot, f.original, ["prepared.json"]),
    descriptor(path.join(projectRoot, "preparing-" + "d".repeat(16)), recorded),
    descriptor(path.join(projectRoot, "previous"), recorded),
    descriptor(path.join(projectRoot, "project"), recorded),
    descriptor(projectRoot, recorded, ["prepared.json", "import.log"])
  ]);
  assert.equal(JSON.stringify(f.entry), before);
  assert.ok(rows.every(row => !row.generated?.some(name => /\.dll$|\.pck$|\.godot|Save|\.cfg$/.test(name))), "private code/config/import outputs are never discarded by name");
  assert.equal(fs.existsSync(path.join(projectRoot, "editor-home")), true, "descriptors never retire anything");
});

test("Godot descriptor discovery reads only bounded old metadata and never inspects original or private bytes", t => {
  const f = fixture(t), generation = f.mkdir("source-projects/" + "a".repeat(20));
  const project = f.mkdir("source-projects/" + "a".repeat(20) + "/project");
  fs.writeFileSync(path.join(generation, "prepared.json"), JSON.stringify({source: f.original}));
  const save = path.join(project, "save.dat");fs.writeFileSync(save, "unique private progress");
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    const name = String(file);
    assert.ok(!name.startsWith(f.original), "original source is not probed");
    if (name.startsWith(f.userDataDir + path.sep)) assert.equal(name, path.join(generation, "prepared.json"));
    return read(file, ...args);
  });
  for (const method of ["statSync", "lstatSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {assert.ok(!String(file).startsWith(f.original));return original(file, ...args);});
  }
  for (const method of ["writeFileSync", "mkdirSync", "renameSync", "symlinkSync", "unlinkSync", "rmSync", "rmdirSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => {assert.ok(!String(file).startsWith(f.root + path.sep), "descriptor hook must not mutate temporary game/profile data");return original(file, ...args);});
  }
  assert.equal(Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir}).length, 3);
  assert.equal(read(save, "utf8"), "unique private progress");
});

test("Godot shared-view fields map lexically to original project paths without source access", t => {
  const f = fixture(t), old = path.join(f.moduleRoot, "writable-input/files"), source = path.join(f.root, "container-original");
  f.entry.moduleData = {projectRoot: path.join(old, "nested"), writableInput: {schemaVersion: 1, root: old, sourceRoot: source}};
  const generation = f.mkdir("mono-projects/" + "a".repeat(24));f.mkdir("mono-projects/" + "a".repeat(24) + "/project");
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  assert.equal(rows[0].sourceRoot, source);
  assert.deepEqual(rows[1], descriptor(path.join(generation, "project"), path.join(source, "nested")));
  assert.equal(f.entry.moduleData.projectRoot, path.join(old, "nested"));
});

test("Godot pack fallback and absent old namespaces do not enumerate sources or current transforms", t => {
  const f = fixture(t);f.entry.moduleData = {packPath: path.join(f.original, "Game.exe")};
  t.mock.method(fs, "opendirSync", () => assert.fail("Absent legacy namespaces need no enumeration"));
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  assert.deepEqual(rows, [{mirrorRoot: path.join(f.moduleRoot, "writable-input/files"), sourceRoot: f.original}]);
  assert.deepEqual(Godot.legacyGameMirrors({...f.entry, gameId: "../unsafe"}, {userDataDir: f.userDataDir}), []);
});

test("Godot unknown old directory aliases remain pending instead of being followed", t => {
  const f = fixture(t);f.mkdir("");const outside = path.join(f.root, "outside");fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.moduleRoot, "source-projects"));
  t.mock.method(fs, "opendirSync", () => assert.fail("An aliased namespace cannot be enumerated"));
  assert.throws(() => Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir}), /aliases/);
});

test("Godot legacy discovery stops at its bounded entry count and closes the iterator", t => {
  const f = fixture(t);f.mkdir("mono-projects");let read = 0, closed = false;
  t.mock.method(fs, "opendirSync", () => ({readSync() {read++;return {name: "unknown-" + read, isSymbolicLink: () => false, isDirectory: () => false};}, closeSync() {closed = true;}}));
  assert.throws(() => Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir}), /Godot game hold too many entries to recover automatically, so they were left in place/);
  assert.equal(read, 1025);assert.equal(closed, true);
});

test("Godot keeps an internal recovered-project origin explicit without classifying its current export as obsolete", t => {
  const f = fixture(t), current = f.mkdir("gdre/current-export"), old = f.mkdir("source-projects/" + "a".repeat(20));
  f.mkdir("source-projects/" + "a".repeat(20) + "/project");fs.writeFileSync(path.join(old, "prepared.json"), JSON.stringify({source: current}));
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  assert.ok(rows.slice(1).every(row => row.sourceRoot === current));
  assert.ok(rows.every(row => row.mirrorRoot !== current));
});

test("Godot backcompat boundary stays outside ordinary module and preparation exports", () => {
  assert.equal(typeof Godot.legacyGameMirrors, "function");
  assert.equal(Object.hasOwn(require("../src/modules/godot/main"), "legacyGameMirrors"), false);
  for (const name of ["main", "mono", "project"]) {
    const file = require.resolve("../src/modules/godot/" + name), source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /require\(["'](?:\.\/|\.\.\/shared\/)backcompat(?:[\/"'])/);
  }
});

for (const variant of ["Mono", "Godot4"]) test(`Godot released v0.5.1 ${variant} restores missing saves to the active original and keeps conflicts`, async t => {
  const f = fixture(t);fs.mkdirSync(f.original);
  fs.writeFileSync(path.join(f.original, "config.cfg"), "authoritative original config");
  const generation = f.mkdir((variant === "Mono" ? "mono-projects/" + "a".repeat(24) : "source-projects/" + "b".repeat(20)));
  const project = path.join(generation, "project");fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "project-save.dat"), "private project progress");
  fs.writeFileSync(path.join(project, "config.cfg"), "different private config");
  if (variant === "Godot4") {
    // v0.5.1 main.js:1084 used dirname(target.path), so the accepted
    // source-projects/<20hex> generation was the actual non-Mono process cwd.
    fs.writeFileSync(path.join(generation, "cwd-save.dat"), "released parent-cwd progress");
    fs.writeFileSync(path.join(generation, "prepared.json"), JSON.stringify({schema: 1, input: "released fingerprint", version: "4.6.3-stable", source: f.original, preparedAt: 1}));
    fs.writeFileSync(path.join(generation, "import.log"), "owned import output");
  } else {
    // v0.5.1 mono.js:110-115 returned mono-projects/<24hex>/project as cwd.
    fs.writeFileSync(path.join(generation, "prepared.json"), JSON.stringify({schema: 2, key: "a".repeat(24), version: "3.5.2-stable", createdAt: 1, leaseManaged: false}));
  }
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
  const results = [];
  for (const row of rows) results.push(await retireLegacyGameMirror(row, {userDataDir: f.userDataDir}));
  assert.ok(results.every(result => result.complete), JSON.stringify(results));
  assert.equal(fs.readFileSync(path.join(f.original, "project-save.dat"), "utf8"), "private project progress");
  if (variant === "Godot4") assert.equal(fs.readFileSync(path.join(f.original, "cwd-save.dat"), "utf8"), "released parent-cwd progress");
  assert.equal(fs.readFileSync(path.join(f.original, "config.cfg"), "utf8"), "authoritative original config");
  const conflicts = fs.readdirSync(f.original).filter(name => name.startsWith("config.cfg.MacLauncher-conflict-"));
  assert.equal(conflicts.length, 1);assert.equal(fs.readFileSync(path.join(f.original, conflicts[0]), "utf8"), "different private config");
  assert.equal(fs.existsSync(generation), false);
});

test("Godot released v0.5.1 import editor HOME maps proven macOS config and cache to their active locations", async t => {
  const f = fixture(t);fs.mkdirSync(f.original);
  const homeDir = path.join(f.root, "ordinary-home"), generation = f.mkdir("source-projects/" + "c".repeat(20));
  fs.writeFileSync(path.join(generation, "prepared.json"), JSON.stringify({schema: 1, source: f.original}));
  const relatives = ["Library/Application Support/Godot", "Library/Caches/Godot"];
  for (const relative of relatives) {
    const old = path.join(generation, "editor-home", relative), current = path.join(homeDir, relative);
    fs.mkdirSync(old, {recursive: true});fs.mkdirSync(current, {recursive: true});
    fs.writeFileSync(path.join(old, "private.cfg"), relative + " private config");
    fs.writeFileSync(path.join(old, "conflict.cfg"), "private changed config");fs.writeFileSync(path.join(current, "conflict.cfg"), "authoritative current config");
  }
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir, homeDir});
  const homeRows = rows.filter(row => row.mirrorRoot.startsWith(path.join(generation, "editor-home") + path.sep));
  assert.equal(homeRows.length, 2);
  const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
  for (const row of homeRows) {
    const result = await retireLegacyGameMirror(row, {userDataDir: f.userDataDir});assert.equal(result.complete, true, JSON.stringify(result));
    const relative = path.relative(path.join(generation, "editor-home"), row.mirrorRoot), current = path.join(homeDir, relative);
    assert.equal(row.sourceRoot, current);assert.equal(fs.readFileSync(path.join(current, "private.cfg"), "utf8"), relative + " private config");
    assert.equal(fs.readFileSync(path.join(current, "conflict.cfg"), "utf8"), "authoritative current config");
    const conflicts = fs.readdirSync(current).filter(name => name.startsWith("conflict.cfg.MacLauncher-conflict-"));assert.equal(conflicts.length, 1);
    assert.equal(fs.readFileSync(path.join(current, conflicts[0]), "utf8"), "private changed config");
  }
  assert.equal(fs.existsSync(path.join(f.original, "editor-home")), false, "tool config must not be stranded in an inactive game subfolder");
});

test("Godot released v0.5.1 unknown editor HOME blocks parent recovery without misrouting any private bytes", async t => {
  const f = fixture(t);fs.mkdirSync(f.original);
  const homeDir = path.join(f.root, "ordinary-home"), generation = f.mkdir("source-projects/" + "d".repeat(20));fs.mkdirSync(homeDir);
  const oldHome = path.join(generation, "editor-home");fs.mkdirSync(oldHome);fs.writeFileSync(path.join(oldHome, "unknown-plugin.cfg"), "unattributed XDG or HOME config");
  fs.writeFileSync(path.join(generation, "cwd-save.dat"), "released parent-cwd save");
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir, homeDir});
  const parent = rows.find(row => row.mirrorRoot === generation);assert.deepEqual(parent.retainedDirectories, ["editor-home"]);
  assert.equal(parent.sourceRoot, null, "the current shared helper cannot safely skip an unknown editor-home subtree");
  const result = await require("../src/core/backcompat/legacy-game-mirrors").retireLegacyGameMirror(parent, {userDataDir: f.userDataDir});
  assert.equal(result.complete, false, "unknown tool config must be reported, not considered recovered");
  assert.equal(fs.readFileSync(path.join(generation, "cwd-save.dat"), "utf8"), "released parent-cwd save");
  assert.equal(fs.existsSync(path.join(f.original, "cwd-save.dat")), false, "parent-cwd recovery is explicitly blocked, not claimed complete");
  assert.equal(fs.readFileSync(path.join(oldHome, "unknown-plugin.cfg"), "utf8"), "unattributed XDG or HOME config");
  assert.equal(fs.existsSync(path.join(f.original, "editor-home")), false);assert.equal(fs.existsSync(path.join(homeDir, "unknown-plugin.cfg")), false);
});

test("Godot released v0.5.1 editor config creates absent active destinations within the existing home and preserves conflicts", async t => {
  const f = fixture(t);fs.mkdirSync(f.original);
  const homeDir = path.join(f.root, "ordinary-home"), generation = f.mkdir("source-projects/" + "e".repeat(20));fs.mkdirSync(homeDir);
  const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");
  for (const relative of ["Library/Application Support/Godot", "Library/Caches/Godot"]) {
    const old = path.join(generation, "editor-home", relative);fs.mkdirSync(old, {recursive: true});fs.writeFileSync(path.join(old, "private.cfg"), "private tool config");
    const row = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir, homeDir}).find(row => row.mirrorRoot === old);
    assert.equal(row.sourceRoot, path.join(homeDir, relative));assert.equal(row.createSourceWithin, homeDir);
    assert.equal(fs.existsSync(row.sourceRoot), false, "only the ordinary home anchor exists initially");
    const result = await retireLegacyGameMirror(row, {userDataDir: f.userDataDir});
    assert.equal(result.complete, true, JSON.stringify(result));assert.equal(fs.readFileSync(path.join(row.sourceRoot, "private.cfg"), "utf8"), "private tool config");
    assert.equal(fs.existsSync(old), false);
    fs.mkdirSync(old, {recursive: true});fs.writeFileSync(path.join(old, "private.cfg"), "different legacy config");
    const conflict = await retireLegacyGameMirror(row, {userDataDir: f.userDataDir});assert.equal(conflict.complete, true, JSON.stringify(conflict));
    assert.equal(fs.readFileSync(path.join(row.sourceRoot, "private.cfg"), "utf8"), "private tool config");
    const siblings = fs.readdirSync(row.sourceRoot).filter(name => name.startsWith("private.cfg.MacLauncher-conflict-"));assert.equal(siblings.length, 1);
    assert.equal(fs.readFileSync(path.join(row.sourceRoot, siblings[0]), "utf8"), "different legacy config");
  }
  assert.equal(fs.existsSync(path.join(f.original, "editor-home")), false);
});

test("Godot graphics adapter descriptors precede the old shared and project views they can reference", t => {
  const f = fixture(t), writable = f.mkdir("writable-input/files"), pack = path.join(writable, "Game.pck");fs.writeFileSync(pack, "old private pack");
  const identity = require("node:crypto").createHash("sha256").update("pack\0" + pack).digest("hex").slice(0, 16);
  const graphics = f.mkdir("graphics/" + identity);fs.symlinkSync(pack, path.join(graphics, "Game.pck"));
  const mono = f.mkdir("mono-projects/" + "a".repeat(24) + "/project");
  f.entry.moduleData.writableInput = {schemaVersion: 1, root: writable, sourceRoot: f.original};
  const rows = Godot.legacyGameMirrors(f.entry, {userDataDir: f.userDataDir});
  assert.equal(rows[0].mirrorRoot, graphics);assert.equal(rows[0].sourceRoot, writable);
  assert.equal(rows[1].mirrorRoot, writable);assert.equal(rows[1].sourceRoot, f.original);
  assert.ok(rows.findIndex(row => row.mirrorRoot === mono) > 1, "graphics links must be inspected before their obsolete targets are retired");
});
