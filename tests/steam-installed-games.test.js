const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { discoverInstalledSteamGames, discoverManagedSteamDownloads, parseSteamVdf } = require("../src/core/steam-installed-games");

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-discovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, native: path.join(homeDir, "Library/Application Support/Steam"), userDataDir: path.join(homeDir, "profile") };
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}
function quoted(value) { return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
function installed(root, appId, name, options = {}) {
  const gamePath = path.join(root, "steamapps/common", options.installDir || name);
  fs.mkdirSync(gamePath, { recursive: true });
  const file = write(path.join(root, "steamapps", `appmanifest_${options.fileId || appId}.acf`),
    `"AppState" { "appid" "${appId}" "name" ${quoted(name)} "installdir" ${quoted(options.installDir || name)} "buildid" "123" ${options.extra || ""} }`);
  if (options.app) fs.mkdirSync(path.join(gamePath, "Example.app/Contents/MacOS"), { recursive: true });
  if (options.magic) write(path.join(gamePath, options.filename || "game.exe"), Buffer.from(options.magic, "hex"));
  return { gamePath, file };
}

test("Steam VDF parsing preserves escaped names, Windows paths, old libraries and comments", () => {
  const parsed = parseSteamVdf('\ufeff// comment\n"libraryfolders" { "0" "C:\\Games" "1" { "path" "C:\\\\Steam\\\" Library" } } "__proto__" { "safe" "yes" }');
  assert.equal(parsed.libraryfolders[0], "C:\\Games");
  assert.equal(parsed.libraryfolders[1].path, 'C:\\Steam" Library');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.__proto__.safe, "yes");
  assert.throws(() => parseSteamVdf('"AppState" { "appid" "480"'), /unclosed object/);
  assert.throws(() => parseSteamVdf('"AppState" { "appid" "480 }'), /unterminated string/);
  assert.throws(() => parseSteamVdf('{ "appid" "480" }'), /invalid key/);
});

test("offline discovery finds native and CrossOver libraries, local artwork, imports and aliases", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("Steam discovery must stay offline"));
  const mac = installed(f.native, "480", 'Example "Mac" Game', { app: true });
  const extra = path.join(f.homeDir, 'External "Steam"');
  const external = installed(extra, "481", "External Game", { magic: "4d5a0000" });
  const alias = path.join(f.homeDir, "Steam alias"); fs.symlinkSync(extra, alias);
  write(path.join(f.native, "steamapps/libraryfolders.vdf"), `"libraryfolders" { "0" { "path" ${quoted(f.native)} } "1" { "path" ${quoted(extra)} } "2" ${quoted(alias)} }`);
  const bottles = path.join(f.homeDir, "Library/Application Support/CrossOver/Bottles");
  const bottle = path.join(bottles, "Example Bottle"), drive = path.join(bottle, "drive_c");
  const client = path.join(drive, "Program Files (x86)/Steam");
  const windows = installed(client, "482", "Windows Game", { magic: "4d5a0000" });
  const secondLibrary = path.join(drive, "Games");
  const extraWindows = installed(secondLibrary, "483", "Second Windows Game");
  const thirdLibrary = path.join(f.homeDir, "Other Drive");
  const otherWindows = installed(thirdLibrary, "484", "Other Drive Game");
  fs.mkdirSync(path.join(bottle, "dosdevices")); fs.symlinkSync(thirdLibrary, path.join(bottle, "dosdevices/d:"));
  write(path.join(client, "steamapps/libraryfolders.vdf"), '"libraryfolders" { "1" { "path" "C:\\\\Games" } "2" { "path" "D:\\\\" } }');
  // A second conventional bottle root is supported without recursively scanning home.
  const alternative = path.join(f.homeDir, "Applications/CrossOver/Bottles/Other/drive_c/Program Files/Steam");
  const alternativeGame = installed(alternative, "485", "Alternative Bottle Game");
  const icon = write(path.join(f.native, "appcache/librarycache/480", "a".repeat(40) + ".jpg"), "local icon");
  const importAlias = path.join(f.homeDir, "Imported.app"); fs.symlinkSync(path.join(mac.gamePath, "Example.app"), importAlias);
  const before = fs.readFileSync(mac.file);
  const rows = await discoverInstalledSteamGames({ ...f, games: [{ gameId: "imported", gamePath: importAlias }] });
  assert.equal(rows.length, 6);
  assert.deepEqual(new Set(rows.map(row => row.gamePath)), new Set([mac, external, windows, extraWindows, otherWindows, alternativeGame].map(item => fs.realpathSync(item.gamePath))));
  const macRow = rows.find(row => row.appId === "480");
  assert.equal(macRow.platform, "macos"); assert.equal(macRow.platformSource, "binary");
  assert.equal(macRow.iconPath, fs.realpathSync(icon)); assert.ok(macRow.iconUrl.startsWith("file:"));
  assert.equal(macRow.imported, true); assert.deepEqual(macRow.importedGameIds, ["imported"]);
  assert.equal(rows.find(row => row.appId === "481").platform, "windows", "local binary evidence overrides client placement");
  assert.equal(rows.find(row => row.appId === "482").bottle, "Example Bottle");
  assert.equal(rows.find(row => row.appId === "483").platformSource, "client");
  assert.ok(rows.filter(row => row.source === "crossover").every(row => row.platform === "windows"));
  assert.deepEqual(fs.readFileSync(mac.file), before, "Steam metadata remains unchanged");
  const repeated = await discoverInstalledSteamGames(f);
  assert.deepEqual(repeated.map(row => row.id), rows.map(row => row.id), "identities are stable across discovery and import state");
});

test("discovery rejects mismatched IDs, traversal, missing installs and escaping manifest or game links", async t => {
  const f = fixture(t);
  installed(f.native, "480", "Valid Game", { app: true });
  installed(f.native, "481", "Mismatch", { fileId: "482" });
  installed(f.native, "483", "Traversal", { installDir: "../Outside" });
  installed(f.native, "484", "Windows Traversal", { installDir: "..\\Outside" });
  const missing = installed(f.native, "485", "Missing"); fs.rmSync(missing.gamePath, { recursive: true });
  const link = installed(f.native, "486", "Escaping Link"); fs.rmSync(link.gamePath, { recursive: true });
  const outside = path.join(f.homeDir, "Outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, link.gamePath);
  const manifest = installed(f.native, "487", "Manifest Link"); fs.renameSync(manifest.file, path.join(f.homeDir, "outside.acf"));
  fs.symlinkSync(path.join(f.homeDir, "outside.acf"), manifest.file);
  write(path.join(f.native, "steamapps/appmanifest_488.acf"), '"AppState" { "appid" "488" ');
  installed(f.native, "489", "Partial Download", { extra: '"StateFlags" "1026"' });
  assert.deepEqual((await discoverInstalledSteamGames(f)).map(row => row.appId), ["480"]);
});

test("platform overrides and ELF or Mach-O evidence distinguish downloads in a native library", async t => {
  const f = fixture(t);
  installed(f.native, "480", "Windows Override", { app: true, extra: '"UserConfig" { "platform_override_dest" "windows" }' });
  installed(f.native, "481", "Linux Binary", { magic: "7f454c46", filename: "game.x86_64" });
  installed(f.native, "482", "Mac Binary", { magic: "cffaedfe", filename: "game" });
  const rows = await discoverInstalledSteamGames(f);
  assert.equal(rows.find(row => row.appId === "480").platform, "windows");
  assert.equal(rows.find(row => row.appId === "480").platformSource, "manifest");
  assert.equal(rows.find(row => row.appId === "481").platform, "linux");
  assert.equal(rows.find(row => row.appId === "482").platform, "macos");
});

test("managed download index includes completed installations and preserves version identities", async t => {
  const f = fixture(t), records = [];
  for (const [version, options] of [["current", {}], ["old", { buildId: "100" }], ["pending", { complete: false }], ["wrong-path", { path: f.homeDir }]]) {
    const location = path.join(f.userDataDir, "steam/downloads/480/windows", version);
    const metadata = { schema: 1, appId: "480", name: "Managed Game", platform: "windows", branch: "public", buildId: "200", complete: true, path: location, ...options };
    write(path.join(location, ".maclauncher-steam.json"), JSON.stringify(metadata)); records.push({ path: location });
  }
  const custom = path.join(f.homeDir, "Custom Downloads/Linux Game");
  write(path.join(custom, ".maclauncher-steam.json"), JSON.stringify({ appId: 481, name: "Linux Game", platform: "linux", complete: true, path: custom })); records.push(custom);
  records.push(records[0], { path: "relative" }, { path: f.homeDir });
  write(path.join(f.userDataDir, "steam/installations.json"), JSON.stringify(records));
  const imported = records[0].path;
  assert.deepEqual(await discoverInstalledSteamGames(f), [], "Downloaded versions stay separate from store installations");
  const rows = await discoverManagedSteamDownloads({ ...f, games: [{ gameId: "managed", importPath: imported }] });
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(row => row.id)).size, 3);
  assert.ok(rows.every(row => row.source === "managed"));
  assert.equal(rows.filter(row => row.imported).length, 1);
  assert.equal(rows.find(row => row.appId === "481").platform, "linux");
  assert.deepEqual(new Set(rows.filter(row => row.appId === "480").map(row => row.buildId)), new Set(["100", "200"]));
});
