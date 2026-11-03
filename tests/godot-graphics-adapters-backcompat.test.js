const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const {legacyGraphicsAdapters} = require("../src/modules/godot/backcompat/graphics-adapters");
const {retireLegacyGameMirror} = require("../src/core/backcompat/legacy-game-mirrors");

const identity = (kind, source) => crypto.createHash("sha256").update(kind + "\0" + source).digest("hex").slice(0, 16);
const write = (file, text) => {fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, text);};

// The v0.5.1 layout as graphics/index.js wrote it for a pack and a project.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-graphics-backcompat-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const userDataDir = path.join(root, "profile"), adapters = path.join(userDataDir, "games/godot-game/modules/godot/graphics");
  const pack = path.join(root, "packed/game.pck"), project = path.join(root, "project");
  write(pack, "GDPC");write(path.join(root, "packed/override.cfg"), "[application]\n");
  write(path.join(project, "project.godot"), "[application]\n");write(path.join(project, "main.gd"), "extends Node\n");
  write(path.join(project, ".godot/imported/asset.ctex"), "original cache");write(path.join(project, ".godot/uid_cache.bin"), "rewritten later");
  const packView = path.join(adapters, identity("pack", pack));
  fs.mkdirSync(packView, {recursive: true});fs.symlinkSync(pack, path.join(packView, "game.pck"));
  write(path.join(packView, "override.cfg"), "[application]\n\n[autoload]\nMacLauncherTemporalCamera=\"*/runtime/autoload.gd\"\n");
  write(path.join(packView, "camera.gdextension"), "[configuration]\n");
  const projectView = path.join(adapters, identity("project", project)), view = path.join(projectView, "project");
  fs.mkdirSync(view, {recursive: true});
  for (const name of ["project.godot", "main.gd"]) fs.symlinkSync(path.join(project, name), path.join(view, name));
  write(path.join(view, ".godot/imported/asset.ctex"), "original cache");write(path.join(view, ".godot/uid_cache.bin"), "older cache");
  write(path.join(view, "override.cfg"), "\n[autoload]\nMacLauncherTemporalCamera=\"*/runtime/autoload.gd\"\n");
  write(path.join(view, "save.dat"), "written by the game");write(path.join(projectView, "camera.gdextension"), "[configuration]\n");
  return {root, userDataDir, adapters, pack, project, packView, projectView, entry: {gameId: "godot-game", moduleId: "godot"}};
}

test("old Godot graphics adapter folders retire once, restoring only game-written bytes", async t => {
  const f = fixture(t), descriptors = legacyGraphicsAdapters(f.entry, {userDataDir: f.userDataDir});
  const projectFirst = identity("project", f.project) < identity("pack", f.pack);
  const projectDescriptors = [
    {mirrorRoot: path.join(f.projectView, "project"), sourceRoot: f.project,
      generated: ["override.cfg", "override.cfg.tmp", ".godot/imported/asset.ctex", ".godot/uid_cache.bin"]},
    {mirrorRoot: f.projectView, sourceRoot: f.project, generated: ["override.cfg", "override.cfg.tmp", "camera.gdextension", "camera.gdextension.tmp"]}];
  const packDescriptor = {mirrorRoot: f.packView, sourceRoot: path.dirname(f.pack), generated: ["override.cfg", "override.cfg.tmp", "camera.gdextension", "camera.gdextension.tmp"]};
  const sorted = value => ({...value, generated: [...value.generated].sort()});
  assert.deepEqual(descriptors.map(sorted), (projectFirst ? [...projectDescriptors, packDescriptor] : [packDescriptor, ...projectDescriptors]).map(sorted));
  for (const descriptor of descriptors)
    assert.deepEqual(await retireLegacyGameMirror(descriptor, {userDataDir: f.userDataDir}), {complete: true,
      ...(descriptor.mirrorRoot.endsWith("project") ? {recoveredFiles: [path.join(f.project, "save.dat")]} : {})});
  assert.deepEqual(fs.readdirSync(f.adapters), []);
  assert.equal(fs.readFileSync(path.join(f.project, "save.dat"), "utf8"), "written by the game");
  assert.equal(fs.readFileSync(path.join(f.project, ".godot/uid_cache.bin"), "utf8"), "rewritten later");
  assert.deepEqual(fs.readdirSync(path.join(f.project, ".godot")).sort(), ["imported", "uid_cache.bin"]);
  assert.equal(fs.existsSync(path.join(f.project, "override.cfg")), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.pack), "override.cfg"), "utf8"), "[application]\n");
  assert.equal(fs.readFileSync(f.pack, "utf8"), "GDPC");
});

test("old Godot graphics folders without a verified source are kept with a reason", async t => {
  const f = fixture(t), unknown = path.join(f.adapters, "0".repeat(16));
  write(path.join(unknown, "override.cfg"), "unknown");fs.symlinkSync(f.pack, path.join(unknown, "game.pck"));
  const descriptor = legacyGraphicsAdapters(f.entry, {userDataDir: f.userDataDir}).find(row => row.mirrorRoot === unknown);
  assert.equal(descriptor.sourceRoot, null);
  const result = await retireLegacyGameMirror(descriptor, {userDataDir: f.userDataDir});
  assert.equal(result.complete, false);assert.equal(fs.readFileSync(path.join(unknown, "override.cfg"), "utf8"), "unknown");
  assert.deepEqual(legacyGraphicsAdapters({gameId: "other-game"}, {userDataDir: f.userDataDir}), []);
});
