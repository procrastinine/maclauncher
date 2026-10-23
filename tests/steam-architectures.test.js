const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { normalizeVersions } = require("../src/core/steam-downloads");
const { inspectMachOArchitecture, inspectInstalledMacArchitecture, matchesSteamArchitecture, steamLibraryArchitectures } = require("../src/core/steam-architectures");
const { discoverInstalledSteamGames } = require("../src/core/steam-installed-games");
function thin(cpu, wide = true) { const header = Buffer.alloc(wide ? 32 : 28); header.writeUInt32LE(wide ? 0xfeedfacf : 0xfeedface, 0); header.writeUInt32LE(cpu, 4); header.writeUInt32LE(2, 12); return header; }
function universal() {
  const intel = thin(0x01000007), arm = thin(0x0100000c), header = Buffer.alloc(48);
  header.writeUInt32BE(0xcafebabe); header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0x01000007, 8); header.writeUInt32BE(48, 16); header.writeUInt32BE(intel.length, 20);
  header.writeUInt32BE(0x0100000c, 28); header.writeUInt32BE(48 + intel.length, 36); header.writeUInt32BE(arm.length, 40);
  return Buffer.concat([header, intel, arm]);
}
test("Android depots retain their platform and declared ARM64 independently of PC and shared content", () => {
  const result = normalizeVersions(710000, { common: { oslist: "windows,android" }, config: { launch: {
    0: { executable: "game.apk", config: { oslist: "android", osarch: "arm64" } }
  } }, depots: {
    710001: { config: { oslist: "windows", osarch: "x86_64" } },
    710002: { config: { oslist: "android", osarch: "arm64" } },
    710003: { config: { oslist: "android", osarch: "64" } }, 710004: {}
  } });
  assert.deepEqual(result.platforms, ["windows", "android"]);
  assert.deepEqual(result.depots.map(depot => depot.platforms), [["windows"], ["android"], ["android"], []]);
  assert.deepEqual(result.architectures.android, ["64", "arm64"]);
  assert.equal(result.architectureLabels.android.arm64, "ARM64");
  assert.doesNotMatch(result.architectureNotes.android, /Apple Silicon/);
  assert.deepEqual(result.architectures.windows, ["64"]);
  assert.deepEqual(normalizeVersions(710000, { depots: { 710002: { config: { oslist: "android" } } } }).platforms, ["android"]);
  assert.deepEqual(normalizeVersions(710000, { common: { oslist: "android" }, depots: { 710002: { config: { oslist: "android", osarch: "64" } } } }).architectures.android, ["64"]);
});
test("Steam does not manufacture 32-bit and 64-bit editions from untagged Alcatraz depots", () => {
  // Public app metadata: 255280 has a Mac app launch but no architecture flags.
  const result = normalizeVersions(255280, { common: { name: "1954 Alcatraz", oslist: "windows,macos", osarch: "", osextended: "" },
    config: { launch: { 0: { executable: "Alcatraz.exe", config: { oslist: "windows" } }, 1: { executable: "Alcatraz.app", config: { oslist: "macos" } } } },
    depots: { 255283: { config: { oslist: "macos" }, manifests: { public: { gid: "5512676998400895932" } } }, 255284: { config: { oslist: "macos" } } } });
  assert.deepEqual(result.architectures.macos, ["unspecified"]);
  assert.deepEqual(result.launchOptions[1].architectures, []);
  assert.match(result.architectureNotes.macos, /does not specify/);
  assert.equal(result.depots[0].architectureSource, "unspecified");
});
test("Apple Silicon metadata works with 64-bit depots while explicit CPU depots stay separate", () => {
  const result = normalizeVersions(275850, { common: { oslist: "windows,macos", osarch: "64", osextended: "macos64,macosapplesilicon,macosnotarized" },
    config: { launch: { 0: { executable: "Example.app", config: { oslist: "macos" } } } }, depots: {
      275852: { config: { oslist: "macos", osarch: "64" } }, 275853: { config: { oslist: "macos", osarch: "x86_64" } },
      275854: { config: { oslist: "macos", osarch: "arm64" } }, 275855: {} } });
  assert.deepEqual(result.architectures.macos, ["64", "arm64"]);
  assert.equal(result.architectures.macos.includes("universal"), false, "platform support alone does not establish a universal Mach-O");
  assert.equal(matchesSteamArchitecture(result.depots[0], "arm64"), true, "osarch64 is bitness, not an Intel-only CPU declaration");
  assert.equal(matchesSteamArchitecture(result.depots[1], "arm64"), false);
  assert.equal(matchesSteamArchitecture(result.depots[2], "64"), true, "the generic64-bit filter does not pretend to identify an Intel CPU");
  assert.equal(matchesSteamArchitecture(result.depots[3], "arm64"), true, "shared resources remain included");
  assert.equal(result.architectureLabels.macos["64"], "64-bit (CPU not specified)");
  assert.equal(steamLibraryArchitectures({ common: { oslist: "macos", osextended: "macos64,macosapplesilicon" } }).nativeAppleSilicon, true);
});
test("launch architecture belongs to the executable rather than every shared depot", () => {
  const result = normalizeVersions(710000, { common: { oslist: "macos" }, config: { launch: {
    0: { executable: "Game32.app", config: { oslist: "macos", osarch: "32" } },
    1: { executable: "Game64.app", config: { oslist: "macos", osarch: "64" } }
  } }, depots: { 710001: {} } });
  assert.deepEqual(result.architectures.macos, ["32", "64"]);
  assert.deepEqual(result.launchOptions.map(row => row.architectures), [["32"], ["64"]]);
  assert.deepEqual(result.depots[0].architectures, []);
  assert.match(result.architectureNotes.macos, /one depot can contain several/);
});
test("offline game entry inspection distinguishes Intel32, Intel64, Apple Silicon and universal binaries", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-architecture-")); t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const steamapps = path.join(homeDir, "Library/Application Support/Steam/steamapps");
  for (const [id, bytes, label] of [[710001, thin(7, false), "Intel 32-bit"], [710002, thin(0x01000007), "Intel 64-bit"], [710003, thin(0x0100000c), "Apple Silicon"], [710004, universal(), "Universal (Intel and Apple Silicon)"]]) {
    const root = path.join(steamapps, "common", String(id)), bundle = path.join(root, "Game.app/Contents");
    fs.mkdirSync(path.join(bundle, "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Info.plist"), '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Game</string></dict></plist>');
    const executable = path.join(bundle, "MacOS/Game"); fs.writeFileSync(executable, bytes);
    fs.writeFileSync(path.join(steamapps, `appmanifest_${id}.acf`), `"AppState" { "appid" "${id}" "name" "Game ${id}" "installdir" "${id}" }`);
    assert.equal(inspectMachOArchitecture(executable).architectureLabel, label);
    assert.equal((await inspectInstalledMacArchitecture(path.join(root, "Game.app"))).architectureLabel, label);
    assert.equal((await inspectInstalledMacArchitecture(executable)).architectureLabel, label);
  }
  const rows = await discoverInstalledSteamGames({ homeDir });
  assert.deepEqual(rows.map(row => row.architectureLabel), ["Intel 32-bit", "Intel 64-bit", "Apple Silicon", "Universal (Intel and Apple Silicon)"]);
  assert.ok(rows.every(row => row.architectureSource === "binary"));
  assert.deepEqual(rows[3].architectureCpu, ["x86_64", "arm64"]);
});
