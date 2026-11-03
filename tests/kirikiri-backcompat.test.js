const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Kiri = require("../src/modules/kirikiri/main");
const Backcompat = require("../src/modules/kirikiri/backcompat");
const XP3 = require("../src/modules/kirikiri/xp3");
const { runDataMigrations } = require("../src/core/backcompat/data-migrations");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kiri-backcompat-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function chunk(name, bytes) {
  const header = Buffer.alloc(12);header.write(name);header.writeBigUInt64LE(BigInt(bytes.length), 4);
  return Buffer.concat([header, bytes]);
}
function configArchive(file, config) {
  const bytes = Buffer.from(config), name = Buffer.from("Config.tjs", "utf16le"), info = Buffer.alloc(22);
  info.writeBigUInt64LE(BigInt(bytes.length), 4);info.writeBigUInt64LE(BigInt(bytes.length), 12);info.writeUInt16LE(name.length / 2, 20);
  const segment = Buffer.alloc(28);segment.writeBigUInt64LE(19n, 4);segment.writeBigUInt64LE(BigInt(bytes.length), 12);segment.writeBigUInt64LE(BigInt(bytes.length), 20);
  const checksum = Buffer.alloc(4);checksum.writeUInt32LE(XP3.adler32(bytes));
  const index = chunk("File", Buffer.concat([chunk("info", Buffer.concat([info, name])), chunk("segm", segment), chunk("adlr", checksum)]));
  const header = Buffer.alloc(19);XP3.MAGIC.copy(header);header.writeBigUInt64LE(BigInt(19 + bytes.length), 11);
  const block = Buffer.alloc(9);block.writeBigUInt64LE(BigInt(index.length), 1);
  fs.writeFileSync(file, Buffer.concat([header, bytes, block, index]));
}
function entryFixture(root, sourceKind, expression = "System.dataPath") {
  const contentRootDir = path.join(root, "original");fs.mkdirSync(contentRootDir);
  const config = `;saveDataLocation = ${expression};\n;dataName = "${sourceKind}";\n;saveDataID = "authored ${sourceKind} ID";`;
  const moduleData = { sourceKind };
  if (sourceKind === "xp3") {
    moduleData.archivePath = path.join(contentRootDir, "data.xp3");moduleData.kagVersion = "3.24";
    configArchive(moduleData.archivePath, config);
  } else fs.writeFileSync(path.join(contentRootDir, "Config.tjs"), config);
  return { moduleId: "kirikiri", gameId: "released-" + sourceKind, contentRootDir, moduleData };
}
async function migrate(entry, userDataDir) {
  let persisted;
  const result = await runDataMigrations({ settings: {}, games: [entry], userDataDir,
    registry: { getModule: () => Backcompat }, saveSettings: async () => {},
    saveEntry: async saved => { persisted = structuredClone(saved); } });
  return { result, persisted };
}

test("KiriKiri released loose and XP3 saves restore to actual current read paths with persisted records", { skip: process.platform !== "darwin" }, async t => {
  for (const sourceKind of ["project", "xp3"]) {
    const root = fixture(t), home = path.join(root, "home"), userDataDir = path.join(root, "profile");
    fs.mkdirSync(home);t.mock.method(os, "homedir", () => home);
    const entry = entryFixture(root, sourceKind);
    // Actual v0.5.1 main.js:97–100,143–155 selects this folder for both layouts.
    const oldSaves = path.join(userDataDir, "games", entry.gameId, "modules", "kirikiri", "saves");
    fs.mkdirSync(oldSaves, { recursive: true });
    const bytes = Buffer.from("released " + sourceKind + " save\0payload\n"), filename = sourceKind + "sc.ksd";
    fs.writeFileSync(path.join(oldSaves, filename), bytes);
    entry.defaultSaveDir = oldSaves;entry.saveLocations = [{ directory: oldSaves }];
    const fact = Kiri.resolveSaveIdentity(entry), readRoot = fact.directory;
    assert.equal(fs.existsSync(readRoot), false);
    const { result, persisted } = await migrate(entry, userDataDir);
    assert.equal(result.complete, true);assert.deepEqual(result.pendingIds, []);
    assert.equal(persisted.saveDirOverride, undefined, "no unproven collision means direct route is retained");
    assert.equal(persisted.defaultSaveDir, readRoot);
    assert.deepEqual(persisted.saveLocations.map(row => row.directory), [readRoot]);
    assert.deepEqual(fs.readFileSync(path.join(readRoot, filename)), bytes);
    assert.equal(fs.existsSync(oldSaves), false);
    fs.rmSync(userDataDir, { recursive: true });
    assert.deepEqual(fs.readFileSync(path.join(readRoot, filename)), bytes, "actual engine read path survives MacLauncher profile deletion");
  }
});

test("KiriKiri released save recovery preserves explicit current folders and conflicts", { skip: process.platform !== "darwin" }, async t => {
  for (const mode of ["override", "native-argument"]) {
    const root = fixture(t), userDataDir = path.join(root, "profile"), portable = path.join(root, "chosen");
    const entry = entryFixture(root, "project");
    if (mode === "override") entry.saveDirOverride = portable;
    else entry.launchArguments = '-datapath="' + portable + '"';
    const oldSaves = path.join(userDataDir, "games", entry.gameId, "modules", "kirikiri", "saves");
    fs.mkdirSync(oldSaves, { recursive: true });fs.mkdirSync(portable);
    fs.writeFileSync(path.join(oldSaves, "projectsc.ksd"), "released private bytes");
    fs.writeFileSync(path.join(portable, "projectsc.ksd"), "current native bytes");
    const { result, persisted } = await migrate(entry, userDataDir);
    assert.deepEqual(result.pendingIds, []);
    assert.equal(persisted.saveDirOverride, mode === "override" ? portable : undefined);
    assert.equal(persisted.launchArguments, entry.launchArguments);
    assert.equal(persisted.defaultSaveDir, portable);
    assert.equal(fs.readFileSync(path.join(portable, "projectsc.ksd"), "utf8"), "current native bytes");
    const conflicts = fs.readdirSync(portable).filter(name => name.startsWith("projectsc.ksd.MacLauncher-conflict-"));
    assert.equal(conflicts.length, 1);
    assert.equal(fs.readFileSync(path.join(portable, conflicts[0]), "utf8"), "released private bytes");
  }
});

test("KiriKiri backcompat skips absent old saves and retains unknown dynamic paths once", { skip: process.platform !== "darwin" }, async t => {
  const root = fixture(t), userDataDir = path.join(root, "profile"), home = path.join(root, "home");
  fs.mkdirSync(userDataDir);fs.mkdirSync(home);t.mock.method(os, "homedir", () => home);
  const entry = entryFixture(root, "project", "chooseSaveLocation()");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, { userDataDir }), []);
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
  const oldSaves = path.join(userDataDir, "games", entry.gameId, "modules", "kirikiri", "saves");
  fs.mkdirSync(oldSaves, { recursive: true });fs.writeFileSync(path.join(oldSaves, "unknown.ksd"), "unique old bytes");
  const { result } = await migrate(entry, userDataDir);
  assert.deepEqual(result.pendingIds, [entry.gameId]);
  assert.match(result.settings.dataMigrations["original-game-mirrors-v1"].retained[0].failures[0].reason, /dynamic or unavailable/);
  assert.equal(fs.readFileSync(path.join(oldSaves, "unknown.ksd"), "utf8"), "unique old bytes");
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
  assert.equal(Kiri.resolveSaveIdentity(entry), null);
});
