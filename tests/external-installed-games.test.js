const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { discoverExternalInstalledGames, discoverDownloadedGames } = require("../src/core/external-installed-games");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-discovery-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"); fs.mkdirSync(homeDir);
  return { root, homeDir, userDataDir: path.join(root, "profile"), sharedDir: path.join(root, "Shared"), systemApplicationsDir: path.join(root, "Applications") };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "object" ? JSON.stringify(value) : value); return file; }
function game(root, name) { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true }); return target; }
function nativeApp(root, cpu = 0x0100000c) {
  fs.mkdirSync(path.join(root, "Contents/MacOS"), { recursive: true });
  write(path.join(root, "Contents/Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Game</string></dict></plist>');
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(cpu, 4); header.writeUInt32LE(2, 12);
  fs.writeFileSync(path.join(root, "Contents/MacOS/Game"), header);
}

test('Google Play APK sets remain in Downloaded and import their base APK with version metadata', async t => {
  const f = fixture(t), target = game(f.userDataDir, 'external/downloads/google-play/com.example.game/version-120');
  const input = write(path.join(target, 'base.apk'), 'base'), split = write(path.join(target, 'split_config.arm64_v8a.apk'), 'split');
  const metadata = { store: 'google-play', appId: 'com.example.game', name: 'Android Example', platform: 'android', version: '1.2', buildId: '120',
    path: target, importPath: input, complete: true };
  write(path.join(target, '.maclauncher-external.json'), metadata);
  write(path.join(f.userDataDir, 'external/installations.json'), [metadata]);
  assert.deepEqual(await discoverExternalInstalledGames(f), []);
  const [row] = await discoverDownloadedGames({ ...f, games: [{ gameId: 'imported', gamePath: input }] });
  assert.equal(row.platform, 'android'); assert.equal(row.store, 'google-play'); assert.equal(row.importPath, fs.realpathSync(input));
  assert.equal(row.versionName, '1.2'); assert.equal(row.buildId, '120'); assert.equal(row.imported, true);
  assert.equal(fs.existsSync(split), true);
});

test('Android repositories retain distinct source tags and exact build identities in Downloaded', async t => {
  const f = fixture(t), index = [];
  for (const store of ['fdroid', 'izzy']) {
    const target = game(f.userDataDir, `external/downloads/${store}/org.example.game/build-42`);
    const input = write(path.join(target, 'base.apk'), store);
    const metadata = { store, appId: 'org.example.game', name: 'Android Example', platform: 'android', version: '1.2', buildId: '42',
      versionId: `${store}-sha256`, path: target, importPath: input, complete: true };
    write(path.join(target, '.maclauncher-external.json'), metadata); index.push(metadata);
  }
  write(path.join(f.userDataDir, 'external/installations.json'), index);
  assert.deepEqual(await discoverExternalInstalledGames(f), []);
  const rows = await discoverDownloadedGames(f);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.store).sort(), ['fdroid', 'izzy']);
  assert.ok(rows.every(row => row.platform === 'android' && row.buildId === '42' && row.importPath.endsWith('base.apk')));
});

test("offline External discovery merges Steam, native Epic, Legendary and Heroic with imports and platform tags", async t => {
  const f = fixture(t); t.mock.method(globalThis, "fetch", () => assert.fail("Installed External scanning must stay offline"));
  const steam = game(f.homeDir, "Library/Application Support/Steam/steamapps/common/Steam Game");
  fs.mkdirSync(path.join(steam, "Game.app/Contents"), { recursive: true });
  write(path.join(f.homeDir, "Library/Application Support/Steam/steamapps/appmanifest_480.acf"), '"AppState" { "appid" "480" "installdir" "Steam Game" "name" "Steam Game" }');
  const epic = game(f.systemApplicationsDir, "Epic Game");
  const epicApp = game(epic, "Game.app/Contents");
  nativeApp(path.dirname(epicApp));
  write(path.join(f.sharedDir, "Epic Games/Launcher/Data/Manifests/epic.item"), { AppName: "EpicExample", DisplayName: "Epic Game", AppVersionString: "1.2.3", InstallLocation: epic, LaunchExecutable: "Game.app/Contents/MacOS/Game" });
  const heroic = path.join(f.homeDir, "Library/Application Support/heroic"), epicWindows = game(f.homeDir, "Games/Windows Game");
  write(path.join(heroic, "legendaryConfig/legendary/installed.json"), { WindowsExample: { app_name: "WindowsExample", title: "Windows Game", platform: "Windows", install_path: epicWindows } });
  const linux = game(f.homeDir, "Games/Linux Game");
  write(path.join(heroic, "gog_store/installed.json"), { installed: [{ appName: "123456", title: "Linux Game", platform: "Linux", install_path: linux }] });
  const duplicate = path.join(f.homeDir, "Epic alias"); fs.symlinkSync(epicWindows, duplicate);
  write(path.join(f.homeDir, ".config/legendary/installed.json"), { WindowsExample: { app_name: "WindowsExample", title: "Windows Game", platform: "Windows", install_path: duplicate } });
  const rows = await discoverExternalInstalledGames({ ...f, games: [{ gameId: "existing", gamePath: path.dirname(epicApp), importPath: epic }] });
  assert.equal(rows.length, 4); assert.deepEqual(new Set(rows.map(row => row.store)), new Set(["steam", "epic", "gog"]));
  const native = rows.find(row => row.appId === "EpicExample");
  assert.equal(native.platform, "macos"); assert.equal(native.imported, true); assert.deepEqual(native.importedGameIds, ["existing"]);
  assert.equal(native.versionName, "1.2.3");
  assert.equal(native.architectureLabel, "Apple Silicon"); assert.equal(native.architectureSource, "binary");
  assert.equal(rows.find(row => row.appId === "WindowsExample").platform, "windows");
  assert.equal(rows.find(row => row.appId === "123456").platform, "linux");
});

test("CrossOver Epic manifests and native or bottled GOG info identify only actual metadata-backed installations", async t => {
  const f = fixture(t), bottle = path.join(f.homeDir, "Library/Application Support/CrossOver/Bottles/Store Bottle"), drive = path.join(bottle, "drive_c");
  const epic = game(drive, "Program Files/Epic Games/Example");
  write(path.join(drive, "ProgramData/Epic/EpicGamesLauncher/Data/Manifests/epic.item"), { AppName: "BottleEpic", DisplayName: "Bottle Epic", InstallLocation: "C:\\Program Files\\Epic Games\\Example", LaunchExecutable: "Game.exe" });
  const gog = game(drive, "GOG Games/Example");
  write(path.join(gog, "goggame-12345.info"), { gameId: "12345", name: "Bottle GOG", playTasks: [{ isPrimary: true, path: "game.exe" }] });
  const native = game(f.systemApplicationsDir, "Native GOG.app");
  nativeApp(native, 0x01000007);
  write(path.join(native, "Contents/Resources/game/goggame-67890.info"), { gameId: "67890", name: "Native GOG" });
  const icon = write(path.join(native, "Contents/Resources/game/goggame-67890.png"), "local art");
  game(drive, "GOG Games/No Metadata");
  write(path.join(f.sharedDir, "Epic Games/Launcher/Data/Manifests/partial.item"), { AppName: "Pending", InstallLocation: epic, bIsIncompleteInstall: true });
  write(path.join(drive, "ProgramData/Epic/EpicGamesLauncher/Data/Manifests/traversal.item"), { AppName: "Traversal", InstallLocation: "C:\\..\\drive_c\\Program Files\\Epic Games\\Example" });
  write(path.join(gog, "goggame-99999.info"), { gameId: "12345", name: "Mismatch" });
  const rows = await discoverExternalInstalledGames(f);
  assert.equal(rows.length, 3); assert.equal(rows.find(row => row.appId === "BottleEpic").gamePath, fs.realpathSync(epic));
  assert.ok(rows.filter(row => row.source === "crossover").every(row => row.platform === "windows" && row.bottle === "Store Bottle"));
  const nativeRow = rows.find(row => row.appId === "67890"); assert.equal(nativeRow.platform, "macos"); assert.equal(nativeRow.iconPath, fs.realpathSync(icon));
  assert.equal(nativeRow.architectureLabel, "Intel 64-bit");
});

test("managed External index includes complete Epic and GOG installs while rejecting malformed metadata", async t => {
  const f = fixture(t), installations = [];
  for (const [store, appId, extra] of [["epic", "Example", {}], ["gog", "12345", {}], ["gog", "67890", { complete: false }], ["other", "999", {}]]) {
    const target = game(f.root, `downloads/${store}-${appId}`);
    const metadata = { store, appId, name: "Managed Game", platform: "windows", path: target, complete: true, ...extra };
    if (appId === "12345") metadata.importPath = write(path.join(target, "setup.exe"), "installer");
    write(path.join(target, ".maclauncher-external.json"), metadata); installations.push(metadata);
  }
  installations.push({ path: "relative" }); write(path.join(f.userDataDir, "external/installations.json"), installations);
  assert.deepEqual(await discoverExternalInstalledGames(f), [], "Downloaded versions do not appear as store installations");
  const rows = await discoverDownloadedGames(f);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.source === "managed" && row.platform === "windows"));
  assert.deepEqual(new Set(rows.map(row => row.store)), new Set(["epic", "gog"]));
  assert.ok(rows.find(row => row.appId === "12345").importPath.endsWith("setup.exe"), "A downloaded installer keeps its import entry after restart");
});

test('itch.io receipts identify native and CrossOver installations without network', async t => {
  const f = fixture(t), zlib = require('node:zlib');
  t.mock.method(globalThis, 'fetch', () => assert.fail('Installed scan must stay offline'));
  const native = game(f.homeDir, 'Library/Application Support/itch/apps/example');
  nativeApp(game(native, 'Game.app'));
  const compressed = path.join(native, '.itch/receipt.json.gz'); fs.mkdirSync(path.dirname(compressed));
  fs.writeFileSync(compressed, zlib.gzipSync(JSON.stringify({ game: { id: 42, title: 'Itch Mac' }, upload: { platforms: { osx: true } }, build: { id: 123, userVersion: '2.0' } })));
  const bottled = game(f.homeDir, 'Library/Application Support/CrossOver/Bottles/Itch/drive_c/users/crossover/AppData/Roaming/itch/apps/example');
  write(path.join(bottled, '.itch/receipt.json'), { game: { id: 43, title: 'Itch Windows' }, upload: { platforms: { windows: true } } });
  const rows = await discoverExternalInstalledGames({ ...f, games: [{ gameId: 'existing', gamePath: native }] });
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.store === 'itch'));
  assert.equal(rows.find(row => row.appId === '42').platform, 'macos');
  assert.equal(rows.find(row => row.appId === '42').imported, true);
  assert.equal(rows.find(row => row.appId === '42').versionName, '2.0');
  assert.equal(rows.find(row => row.appId === '42').buildId, '123');
  assert.equal(rows.find(row => row.appId === '42').architectureLabel, 'Apple Silicon');
  assert.equal(rows.find(row => row.appId === '43').platform, 'windows');
  assert.equal(rows.find(row => row.appId === '43').source, 'crossover');
});
