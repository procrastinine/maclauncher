const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Godot = require("../src/modules/godot/main"), Project = require("../src/modules/godot/project");
const {pack, settings} = require("./helpers/godot-pack");

function fixture(t, kind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "godot-original-route-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const original = path.join(root, "original"), userDataDir = path.join(root, "profile");fs.mkdirSync(original);
  const appPath = path.join(userDataDir, "runtimes/godot/4.6.3-stable/standard/Godot.app");
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), {recursive: true});
  fs.writeFileSync(path.join(appPath, "Contents/MacOS/Godot"), "routing fixture only", {mode: 0o755});
  fs.writeFileSync(path.join(appPath, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Godot</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const target = kind === "project" ? original : path.join(original, "Game.pck");
  const moduleData = {detectedMajor: 4, detectedVersion: "4.6.3"};
  if (kind === "project") {
    moduleData.projectRoot = original;fs.writeFileSync(path.join(original, "project.godot"), 'config_version=5\n[application]\nconfig/name="Original"\n');
    fs.mkdirSync(path.join(original, ".godot/imported"), {recursive: true});fs.writeFileSync(path.join(original, ".godot/imported/asset.ctex"), "original imported asset");
  } else {
    const value = pack({"project.binary": settings({"application/config/name": "Original"}), "Main.gdc": Buffer.from("GDSC")}, {version: 2, offset: 0});
    fs.writeFileSync(target, value.buffer);moduleData.packPath = target;
  }
  const entry = {gameId: "game", moduleId: "godot", gamePath: target, runtimeId: "godot",
    runtimeData: {godot: {version: "4.6.3-stable", variant: "standard"}}, moduleData};
  const prepare = Project.prepare;
  t.mock.method(Project, "prepare", (entry, options) => prepare(entry, {...options, run: () => assert.fail("Imported project must not launch a tool or create a mirror")}));
  return {original, userDataDir, appPath, target, entry};
}

for (const kind of ["project", "pack"]) test("Godot4 " + kind + " Play without a camera adapter preserves original target and working directory", async t => {
  const f = fixture(t, kind);let launched;
  await Godot.launchRuntime("godot", f.entry, {userDataDir: f.userDataDir, graphicsRoot: path.join(f.original, "no-camera-provider"), settings: {}, platform: "darwin",
    gameArguments: ["--original-route"], spawnDetachedChecked: (executable, args, options) => {launched = {executable, args, options};return {pid: 42, exitCode: 0};}});
  assert.equal(launched.executable, path.join(f.appPath, "Contents/MacOS/Godot"));
  assert.deepEqual(launched.args, [kind === "project" ? "--path" : "--main-pack", f.target, "--original-route"]);
  assert.equal(launched.options.cwd, f.original);assert.equal(launched.options.env, undefined);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "games")), false, "ordinary Play creates no per-game mirror or receipts");
});
