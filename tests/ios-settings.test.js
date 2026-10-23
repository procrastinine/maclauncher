const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Settings = require("../src/modules/ios/settings");
test("PlayCover window and input settings produce a complete offline PlayTools configuration", () => {
  const settings = Settings.playToolsSettings({ keymapping: false, mouseSensitivity: 125, pauseKeymappingOnTextInput: true,
    scrollWheel: false, windowMode: "resizable", windowWidth: 1440, windowHeight: 900, deviceModel: "iPad8,6" });
  assert.equal(settings.keymapping, false); assert.equal(settings.sensitivity, 125);
  assert.equal(settings.resolution, 6); assert.equal(settings.windowWidth, 1440); assert.equal(settings.windowHeight, 900);
  assert.equal(settings.noKMOnInput, true); assert.equal(settings.enableScrollWheel, false); assert.equal(settings.iosDeviceModel, "iPad8,6");
  assert.equal(settings.discordActivity.enable, false); assert.equal(settings.bypass, false); assert.equal(settings.playChain, false);
  assert.equal(Settings.playToolsSettings({}).resolution, 6); assert.equal(Settings.playToolsSettings({}).noKMOnInput, true);
  assert.equal(Settings.playToolsSettings({ windowMode: "native" }).resolution, 0);
  assert.equal(Settings.playToolsSettings({ windowMode: "fixed", pauseKeymappingOnTextInput: false }).resolution, 2);
  assert.equal(Settings.playToolsSettings({ pauseKeymappingOnTextInput: false }).noKMOnInput, false);
  for (const input of [{ mouseSensitivity: NaN }, { windowWidth: 0 }, { windowHeight: 100000 }, { windowWidth: 800.5 },
    { keymapping: "true" }, { deviceModel: "arbitrary" }, { windowMode: "arbitrary" }]) assert.throws(() => Settings.normalize(input));
});
test("PlayTools settings are private, valid plists, warm-write stable and do not change keymaps", { skip: process.platform !== "darwin" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-settings-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, bundleId: "org.example.app", settings: { mouseSensitivity: 70 } };
  const file = Settings.writeSettings(options), modified = fs.statSync(file).mtimeMs;
  const decoded = JSON.parse(require("node:child_process").execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  assert.deepEqual(decoded, Settings.playToolsSettings(options.settings));
  Settings.writeSettings(options); assert.equal(fs.statSync(file).mtimeMs, modified);
  const keymaps = path.join(root, "data/home/Library/Containers/io.playcover.PlayCover/Keymapping"); fs.mkdirSync(keymaps);
  const keymap = path.join(keymaps, "org.example.app.plist"); fs.writeFileSync(keymap, "existing keymap");
  Settings.writeSettings({ ...options, settings: { mouseSensitivity: 90 } }); assert.equal(fs.readFileSync(keymap, "utf8"), "existing keymap");
  assert.throws(() => Settings.writeSettings({ ...options, bundleId: "../../outside" }), /identifier/);
  const outside = path.join(root, "original"); fs.writeFileSync(outside, "original"); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  Settings.writeSettings(options); assert.equal(fs.readFileSync(outside, "utf8"), "original"); assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
});
