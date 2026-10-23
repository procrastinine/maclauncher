const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Steam = require("../src/modules/shared/runtime/steamworks/installed-client");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-installed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "steamapps"), installRoot = path.join(library, "common", "Example Game");
  const appPath = path.join(installRoot, "Example.app");
  fs.mkdirSync(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  const manifest = (id = 480, installDir = "Example Game", fileId = id) => {
    const file = path.join(library, `appmanifest_${fileId}.acf`);
    fs.writeFileSync(file, `"AppState" { "appid" "${id}" "installdir" "${installDir}" }`);
    return file;
  };
  return { root, library, installRoot, appPath, manifest };
}

test("native Steam launch resolves only the selected installation and preserves publisher files and effects", async t => {
  const f = fixture(t), file = f.manifest(), before = fs.readFileSync(file);
  f.manifest(481, "Unrelated Game");
  const base = { SteamAppId: "999", SteamGameId: "999", SteamOverlayGameId: "999", DYLD_INSERT_LIBRARIES: "/effects.dylib", RESHADE_CONFIG: "/game/ReShade.ini" };
  const prepared = await Steam.prepareNativeLaunch(f.appPath, { baseEnvironment: base });
  assert.equal(prepared.installation.appId, 480);
  assert.equal(prepared.installation.installRoot, fs.realpathSync(f.installRoot));
  assert.equal(prepared.environment.SteamAppId, "480");
  assert.equal(prepared.environment.SteamGameId, "480");
  assert.equal(prepared.environment.SteamOverlayGameId, undefined);
  assert.equal(prepared.environment.DYLD_INSERT_LIBRARIES, base.DYLD_INSERT_LIBRARIES);
  assert.equal(prepared.environment.RESHADE_CONFIG, base.RESHADE_CONFIG);
  assert.equal(base.SteamAppId, "999");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(path.join(f.appPath, "Contents", "MacOS")), []);
  assert.equal(prepared.environment.GseSavePath, undefined);
});

test("optional Steam integration preserves offline launches and unrelated apps do no Steam work", async t => {
  const f = fixture(t); f.manifest();
  const prepared = await Steam.prepareNativeLaunch(f.appPath, { baseEnvironment: {} });
  assert.deepEqual(prepared.environment, { SteamAppId: "480", SteamGameId: "480" });
  const base = { PATH: "/usr/bin" }, other = path.join(f.root, "Other.app"); fs.mkdirSync(other);
  const result = await Steam.prepareNativeLaunch(other, { baseEnvironment: base });
  assert.equal(result.environment, base);
  assert.equal(result.installation, null);
});

test("Steam manifest identity rejects conflicting, mismatched and escaping installations", t => {
  const f = fixture(t);
  f.manifest(480, "../Example Game");
  f.manifest(480, "Example Game", 481);
  const outside = path.join(f.root, "outside.acf"); fs.writeFileSync(outside, '"AppState" { "appid" "482" "installdir" "Example Game" }');
  fs.symlinkSync(outside, path.join(f.library, "appmanifest_482.acf"));
  assert.equal(Steam.findInstalledApp(f.appPath), null);
  f.manifest(483); f.manifest(484);
  assert.throws(() => Steam.findInstalledApp(f.appPath), { code: "STEAM_APP_ID_CONFLICT" });
});

test("Steam detection follows an app alias to the actual installed game", t => {
  const f = fixture(t); f.manifest();
  const link = path.join(f.root, "Game.app"); fs.symlinkSync(f.appPath, link);
  assert.equal(Steam.findInstalledApp(link).appId, 480);
  const unrelated = path.join(f.root, "Uninstalled.app"); fs.mkdirSync(unrelated);
  fs.symlinkSync(unrelated, path.join(f.installRoot, "Outside.app"));
  assert.equal(Steam.findInstalledApp(path.join(f.installRoot, "Outside.app")), null);
});
