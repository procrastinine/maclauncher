const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectGame } = require("../src/modules/wolfrpg/detect");
const Archive = require("../src/modules/wolfrpg/archive");
const Preparation = require("../src/modules/wolfrpg/prepare");
const Core = require("../src/modules/wolfrpg/runtime/core");
const Manager = require("../src/modules/wolfrpg/runtime/manager");
const Wolf = require("../src/modules/wolfrpg/main");
const { createRuntimeSettingsStore } = require("../src/core/runtime-settings");
const { bridgeSaves } = require("../src/modules/wolfrpg/electron");
const Modern = require("../src/modules/wolfrpg/archive-modern");
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-wolf-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function legacyFixture(file, name = "Game.dat", content = Buffer.from("Game contents")) {
  function recordName(value) {
    const bytes = Buffer.from(value), padded = Math.ceil((bytes.length + 1) / 4) * 4, output = Buffer.alloc(4 + padded * 2);
    output.writeUInt16LE(padded / 4); bytes.toString().toUpperCase() && Buffer.from(bytes.toString().toUpperCase()).copy(output, 4); bytes.copy(output, 4 + padded); return output;
  }
  const names = Buffer.concat([Buffer.alloc(4), recordName("BasicData"), recordName(name)]), files = Buffer.alloc(44 * 3), dirs = Buffer.alloc(32), header = Buffer.alloc(24);
  files.writeUInt32LE(16, 4); files.writeUInt32LE(0xffffffff, 40);
  files.writeUInt32LE(4, 44); files.writeUInt32LE(16, 48); files.writeUInt32LE(16, 76); files.writeUInt32LE(0xffffffff, 84);
  files.writeUInt32LE(4 + recordName("BasicData").length, 88); files.writeUInt32LE(content.length, 124); files.writeUInt32LE(0xffffffff, 128);
  dirs.writeUInt32LE(0xffffffff, 4); dirs.writeUInt32LE(1, 8); dirs.writeUInt32LE(44, 12);
  dirs.writeUInt32LE(44, 16); dirs.writeUInt32LE(1, 24); dirs.writeUInt32LE(88, 28);
  const tables = Buffer.concat([names, files, dirs]); header.write("DX"); header.writeUInt16LE(3, 2); header.writeUInt32LE(tables.length, 4);
  header.writeUInt32LE(24, 8); header.writeUInt32LE(24 + content.length, 12); header.writeUInt32LE(names.length, 16); header.writeUInt32LE(names.length + files.length, 20);
  const raw = Buffer.concat([header, content, tables]); for (let index = 0; index < raw.length; index++) raw[index] ^= 255; fs.writeFileSync(file, raw);
}
function fakeRuntime(userDataDir, version = "0.6.2.0") {
  const installDir = Core.getInstallDir({ userDataDir, version }), contentRoot = path.join(installDir, "public");
  for (const name of Core.REQUIRED_FILES) { fs.mkdirSync(path.dirname(path.join(contentRoot, name)), { recursive: true }); fs.writeFileSync(path.join(contentRoot, name), name === "index.html" ? '<script src="lib/system.js"></script><script async src="woditor.js"></script>' : "runtime"); }
  fs.writeFileSync(path.join(installDir, "BrowserWoditor.dat"), "0.2"); fs.writeFileSync(path.join(installDir, "install.json"), JSON.stringify({ version }));
  return Core.resolveInstalled({ userDataDir, version });
}
test("WOLF RPG detects a folder, executable and archive without detecting native app bundles", t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, "Game.ini"), "WindowModeFlag=1"); fs.writeFileSync(path.join(dir, "Game.exe"), "MZ"); legacyFixture(path.join(dir, "Data.wolf"));
  for (const input of [dir, path.join(dir, "Game.exe"), path.join(dir, "Data.wolf")]) {
    const detected = detectGame({ rootDir: dir, inputPath: input, stat: fs.statSync(input) });
    assert.equal(detected.moduleId, "wolfrpg"); assert.equal(detected.gamePath, dir); assert.equal(detected.runtimeId, "browser-woditor");
  }
  assert.equal(detectGame({ rootDir: dir, isAppBundle: true }), null);
  const plain = path.join(dir, "other"); fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, "Game.exe"), "MZ"); assert.equal(detectGame({ rootDir: plain }), null);
});
test("legacy archive reader decodes independent DX3 fixture and rejects unsafe names", t => {
  const dir = fixture(t), archivePath = path.join(dir, "Data.wolf"); legacyFixture(archivePath);
  const archive = Archive.openLegacyArchive(archivePath);
  assert.equal(archive.version, 3); assert.deepEqual(archive.entries.map(entry => entry.name), ["BasicData/Game.dat"]);
  assert.equal(archive.readEntry(archive.entries[0]).toString(), "Game contents"); archive.close();
  legacyFixture(archivePath, "../escape"); assert.throws(() => Archive.openLegacyArchive(archivePath), /Unsafe/);
  fs.writeFileSync(archivePath, "not an archive"); assert.equal(Archive.openLegacyArchive(archivePath), null);
});
test("legacy compression validates references, output sizes and truncation", () => {
  const header = Buffer.alloc(9); header.writeUInt32LE(6); header.writeUInt32LE(14, 4); header[8] = 254;
  assert.equal(Archive.decodeLz(Buffer.concat([header, Buffer.from([65, 66, 254, 0, 1])]), 6).toString(), "ABABAB");
  assert.throws(() => Archive.decodeLz(Buffer.concat([header, Buffer.from([65, 66, 254, 0, 9])]), 6), /back-reference/);
  assert.throws(() => Archive.decodeLz(Buffer.concat([header, Buffer.from([65, 66, 254, 0])]), 6), /Invalid compressed/);
});
test("modern archive writer rejects case ambiguity, escape paths and oversized entries", t => {
  const dir = fixture(t), dest = path.join(dir, "Data.wolf");
  for (const entries of [[{ name: "A", size: 1 }, { name: "a", size: 1 }], [{ name: "../a", size: 1 }], [{ name: "a", size: 300 * 1024 ** 2 }]]) assert.throws(() => Archive.writeModernArchive(entries, () => Buffer.from("a"), dest), /Duplicate|Unsafe|Invalid/);
  assert.equal(fs.existsSync(dest), false);
  const signal = AbortSignal.abort(); assert.throws(() => Archive.writeModernArchive([{ name: "a", size: 1 }], () => Buffer.from("a"), dest, { signal }), /cancel/); assert.equal(fs.existsSync(dest), false);
});
function fixedHuffman(bytes) {
  const fields = [], bits = (count, value) => { for (let bit = count - 1; bit >= 0; bit--) fields.push(Number(BigInt(value) >> BigInt(bit) & 1n)); };
  for (const size of [bytes.length, bytes.length]) { const width = Math.max(1, Math.ceil(Math.log2(size + 1))); bits(6, width - 1); bits(width, size); }
  for (let index = 0; index < 256; index++) { bits(3, 0); bits(1, 0); bits(2, index ? 0 : 1); }
  const header = Buffer.alloc(Math.ceil(fields.length / 8)); fields.forEach((bit, index) => header[index >>> 3] |= bit << (7 - index % 8));
  const payload = Buffer.from(bytes);
  for (let index = 0; index < payload.length; index++) { let reversed = 0; for (let bit = 0; bit < 8; bit++) reversed = reversed << 1 | payload[index] >>> bit & 1; payload[index] = reversed; }
  return Buffer.concat([header, payload]);
}
test("DX8 Huffman reader decodes independent frequency/payload data and rejects oversized/truncated streams", () => {
  const source = Buffer.from("A browser-compatible modern archive"), compressed = fixedHuffman(source);
  assert.deepEqual(Modern.decodeHuffman(compressed), source);
  assert.throws(() => Modern.decodeHuffman(compressed, 1), /output size/);
  assert.throws(() => Modern.decodeHuffman(compressed.subarray(0, -1)), /stored size/);
});
test("DX8 archives decode encrypted compressed tables and per-file keys without changing game bytes", t => {
  const dir = fixture(t), file = path.join(dir, "Data.wolf"), source = Buffer.from("A readable asset"), keyString = Modern.__test.KEYS[0];
  Archive.writeModernArchive([{ name: "BasicData/Game.dat", size: source.length }], () => source, file);
  const raw = fs.readFileSync(file), header = Buffer.from(raw.subarray(0, 64)), nameStart = Number(header.readBigUInt64LE(16));
  const table = raw.subarray(nameStart), literal = Buffer.alloc(9 + table.length); literal.writeUInt32LE(table.length); literal.writeUInt32LE(literal.length, 4); literal[8] = 254;
  // None of the little fixture's table bytes equal the literal marker.
  // Escape any that do using the format's repeated-marker convention.
  const chunks = [...table].flatMap(value => value === 254 ? [254,254] : [value]);
  const lz = Buffer.concat([literal.subarray(0, 9), Buffer.from(chunks)]); lz.writeUInt32LE(lz.length, 4);
  const packedTables = Archive.__test.xorBytes(fixedHuffman(lz), Modern.modernKey(keyString));
  header.writeUInt32LE(0, 44); const assets = Buffer.from(raw.subarray(64, nameStart));
  const fileKey = Modern.modernKey(Buffer.concat([keyString, Buffer.from("GAME.DATBASICDATA")]));
  Archive.__test.xorBytes(source, fileKey, source.length).copy(assets);
  fs.writeFileSync(file, Buffer.concat([header, assets, packedTables]));
  const archive = Archive.openArchive(file); assert.equal(archive.version, 8); assert.equal(archive.entries.length, 1);
  assert.deepEqual(archive.readEntry(archive.entries[0]), source); archive.close();
  header.writeBigUInt64LE(0xffffffffffffffffn, 16); fs.writeFileSync(file, Buffer.concat([header, assets, packedTables]));
  assert.throws(() => Archive.openArchive(file), /too large/);
});
test("publisher download catalog includes all distinct four-part versions in numeric order", () => {
  const html = '<a href="/files/BrowserWoditor_0_6_2_0.zip">new</a><a href="/files/BrowserWoditor_0_6_1_2.zip">old</a><a href="/files/BrowserWoditor_0_6_2_0.zip">duplicate</a><a href="https://other.test/BrowserWoditor_9_0_0_0.zip">foreign</a>';
  const catalog = Core.collectCatalog(html); assert.deepEqual(catalog.versions, ["0.6.2.0", "0.6.1.2"]); assert.equal(catalog.releasesByVersion["0.6.1.2"].downloadUrl, "https://frostyhowl.com/files/BrowserWoditor_0_6_1_2.zip");
  assert.equal(Core.normalizeVersion("v0.6.2.0"), "0.6.2.0"); assert.throws(() => Core.normalizeVersion("../../escape"), /Invalid/);
});
test("manager keeps exact versions separate without persisting global defaults", t => {
  const userDataDir = fixture(t); fakeRuntime(userDataDir, "0.6.1.2"); fakeRuntime(userDataDir, "0.6.2.0");
  assert.deepEqual(Core.listInstalled(userDataDir).map(item => item.version), ["0.6.2.0", "0.6.1.2"]);
  assert.equal(Core.resolveInstalled({ userDataDir, version: "0.5.9.2" }), null);
  assert.equal(Manager.updateSettingsAfterInstall({ defaultVersion: "0.6.1.2" }, { version: "0.6.2.0" }), undefined);
  assert.equal(Manager.getState({ settings: { defaultVersion: "0.6.1.2" }, userDataDir }).sections[0].defaultVersion, null);
  assert.equal(Manager.getState({ settings: {}, userDataDir }).supportsDefault, false);
  Core.uninstallVersion({ userDataDir, version: "0.6.2.0", installDir: path.dirname(userDataDir) }); assert.equal(fs.existsSync(userDataDir), true); assert.equal(Core.listInstalled(userDataDir).length, 1);
});
test("preparation is automatic, reuses staged data and preserves originals", t => {
  const dir = fixture(t), game = path.join(dir, "game"), userDataDir = path.join(dir, "state"); fs.mkdirSync(game); fs.mkdirSync(userDataDir);
  const source = path.join(game, "Data.wolf"); legacyFixture(source); fs.writeFileSync(path.join(game, "Game.ini"), "WindowModeFlag=1");
  const original = fs.readFileSync(source), install = fakeRuntime(userDataDir), entry = { ...detectGame({ rootDir: game }), gameId: "wolf-game", name: "Sample" };
  const context = { userDataDir, settings: { runtimes: {"browser-woditor": {defaultVersion: "0.5.9.2"}} }, runtimeSettings: { limitFPS: "30" } };
  assert.equal(Wolf.actions.runtimeStatus(entry, {}, context).version, install.version);
  assert.throws(() => Preparation.prepareLaunch({...entry, runtimeData: {"browser-woditor": {version: "0.5.9.2"}}}, context), /not installed/);
  const stage = Preparation.prepareLaunch(entry, context), stat = fs.statSync(path.join(stage.contentRoot, "Data.wolf"));
  assert.equal(fs.readFileSync(path.join(stage.contentRoot, "Data.wolf")).toString("ascii", 0, 2), "DX"); assert.deepEqual(fs.readFileSync(source), original);
  assert.match(fs.readFileSync(entry.indexHtml, "utf8"), /MacLauncherWolf/); assert.match(fs.readFileSync(path.join(stage.contentRoot, "settings.js"), "utf8"), /"limitFPS":30/);
  assert.equal(Preparation.prepareLaunch(entry, context).contentRoot, stage.contentRoot); assert.equal(fs.statSync(path.join(stage.contentRoot, "Data.wolf")).mtimeMs, stat.mtimeMs);
  assert.deepEqual(Preparation.contentReadRoots(entry, context), [game, install.contentRoot].map(value => fs.realpathSync(value)));
  const save = path.join(entry.defaultSaveDir, "Save"); fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, "slot.sav"), "saved");
  context.runtimeSettings.limitFPS = "60"; assert.notEqual(Preparation.prepareLaunch(entry, context).contentRoot, stage.contentRoot); assert.equal(fs.readFileSync(path.join(save, "slot.sav"), "utf8"), "saved");
});
test("unmarked modern archives are prepared with an internal runtime marker", t => {
  const dir = fixture(t), game = path.join(dir, "game"), userDataDir = path.join(dir, "state"); fs.mkdirSync(game); fs.mkdirSync(userDataDir);
  Archive.writeModernArchive([{ name: "BasicData/Game.dat", size: 4 }], () => Buffer.from("game"), path.join(game, "Data.wolf"));
  fs.writeFileSync(path.join(game, "Game.ini"), "WindowModeFlag=1"); fakeRuntime(userDataDir);
  const entry = { ...detectGame({ rootDir: game }), gameId: "modern-game" }, stage = Preparation.prepareLaunch(entry, { userDataDir });
  const archive = Archive.openArchive(path.join(stage.contentRoot, "Data.wolf"));
  assert.deepEqual(archive.entries.map(item => item.name).sort(), ["BasicData/BrowserWoditor.dat", "BasicData/Game.dat"]);
  assert.equal(archive.readEntry(archive.entries.find(item => item.name.endsWith("BrowserWoditor.dat"))).toString(), "0.2"); archive.close();
});
test("asset tools list and atomically extract archives while keeping source data unchanged", t => {
  const dir = fixture(t), game = path.join(dir, "game"), userDataDir = path.join(dir, "state"); fs.mkdirSync(game); fs.mkdirSync(userDataDir);
  const source = path.join(game, "Data.wolf"); legacyFixture(source); fs.writeFileSync(path.join(game, "Game.ini"), "WindowModeFlag=1");
  const original = fs.readFileSync(source), entry = { ...detectGame({ rootDir: game }), gameId: "asset-game" }, context = { userDataDir };
  const list = Wolf.actions.listArchive(entry, {}, context); assert.equal(list.fileCount, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(list.outputPath)).files, [{ name: "Data/BasicData/Game.dat", size: 13 }]);
  const result = Wolf.actions.extractAssets(entry, {}, context), file = path.join(result.outputDir, "Data/BasicData/Game.dat");
  assert.equal(fs.readFileSync(file, "utf8"), "Game contents"); assert.deepEqual(fs.readFileSync(source), original);
  legacyFixture(source, "Game.dat", Buffer.from("replacement"));
  assert.throws(() => Wolf.actions.extractAssets(entry, {}, { ...context, signal: AbortSignal.abort() }), /cancel/);
  assert.equal(fs.readFileSync(file, "utf8"), "Game contents");
  assert.equal(fs.readdirSync(path.dirname(result.outputDir)).some(name => name.startsWith(".extract-")), false);
  Wolf.actions.extractAssets(entry, {}, context); assert.equal(fs.readFileSync(file, "utf8"), "replacement");
  let revealed; Wolf.actions.revealAssets(entry, {}, { ...context, ui: { shell: { showItemInFolder: value => revealed = value } } }); assert.equal(revealed, result.outputDir);
  Wolf.actions.removeAssets(entry, {}, context); assert.equal(fs.existsSync(result.outputDir), false); assert.equal(entry.moduleData.assetExportDir, null);
  const other = path.join(dir, "unrelated"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "keep"), "unchanged"); fs.symlinkSync(other, result.outputDir);
  assert.throws(() => Wolf.actions.extractAssets(entry, {}, context), /aliases/); assert.equal(fs.readFileSync(path.join(other, "keep"), "utf8"), "unchanged");
});
test("frame rate settings survive shared default/per-game normalization", t => {
  const userDataDir = fixture(t), store = createRuntimeSettingsStore({ userDataDir }), entry = { gameId: "settings", moduleId: "wolfrpg", runtimeId: "browser-woditor" };
  assert.equal(store.resolveForEntry(entry, {}, Wolf.manifest, "browser-woditor").limitFPS, "60");
  const settings = { modules: { wolfrpg: { runtimeSettings: { "browser-woditor": { limitFPS: "30" } } } } };
  // Per-game fields are stored by the same service used by the inspector.
  entry.runtimeSettings = { "browser-woditor": { limitFPS: "30" } };
  store.writeDefaults("browser-woditor", Wolf.manifest, { limitFPS: "60" });
  assert.equal(store.resolveForEntry(entry, settings, Wolf.manifest, "browser-woditor").limitFPS, "30");
});
function memoryFS() {
  const dirs = new Set(["/", "/data0"]), files = new Map();
  return { mkdirTree(name) { let current = ""; for (const part of name.split("/").filter(Boolean)) { current += "/" + part; dirs.add(current); } },
    writeFile(name, value) { files.set(name, Buffer.from(value)); }, readFile: name => files.get(name),
    readdir(name) { const prefix = name + "/", children = [...dirs, ...files.keys()].filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length).split("/")[0]); return [".", "..", ...new Set(children)]; },
    stat(name) { return dirs.has(name) ? { mode: 0o40755, size: 0 } : { mode: 0o100600, size: files.get(name).length }; },
    analyzePath: name => ({ exists: dirs.has(name) || files.has(name) }), isDir: mode => (mode & 0o170000) === 0o40000,
    syncfs(_populate, callback) { callback(null); }, unlink(name) { files.delete(name); } };
}
test("native save bridge survives a new browser origin and mirrors deleted saves", t => {
  const dir = fixture(t), first = memoryFS(), mount = "/data0/game-Save";
  first.mkdirTree(mount + "/Save"); const bridge = bridgeSaves(first, dir, "game"); first.syncfs(true, assert.ifError);
  first.writeFile(mount + "/Save/slot.sav", Buffer.from([1, 2, 3])); bridge.flush(); assert.deepEqual(fs.readFileSync(path.join(dir, "Save/slot.sav")), Buffer.from([1, 2, 3]));
  const second = memoryFS(); second.mkdirTree(mount); bridgeSaves(second, dir, "game"); second.syncfs(true, assert.ifError); assert.deepEqual(second.readFile(mount + "/Save/slot.sav"), Buffer.from([1, 2, 3]));
  first.unlink(mount + "/Save/slot.sav"); bridge.flush(); assert.equal(fs.existsSync(path.join(dir, "Save/slot.sav")), false);
});

test("WOLF RPG delivers literal game arguments to Emscripten once and leaves empty startup arguments unchanged", () => {
  const {install} = require("../src/modules/wolfrpg/electron");
  for (const gameArguments of [undefined, [], ["--title", "A quoted title", "", "$(touch forbidden)", "first\nsecond"]]) {
    const target = {setInterval() {return 1;}, addEventListener() {}}, initial = ["publisher-default"], runtime = {arguments: initial};
    const before = gameArguments && [...gameArguments];
    install({config: {gameDataDir: "/unused-game-data", gameArguments}}, target);
    target.MacLauncherWolf.configure(runtime);
    assert.deepEqual(runtime.arguments, [...initial, ...(gameArguments || [])]);
    if (!gameArguments?.length) assert.equal(runtime.arguments, initial);
    else assert.notEqual(runtime.arguments, gameArguments);
    target.MacLauncherWolf.configure(runtime);
    assert.deepEqual(runtime.arguments, [...initial, ...(gameArguments || [])], "repeated configure cannot append arguments twice");
    assert.deepEqual(gameArguments, before);
  }
  const target = {setInterval() {return 1;}, addEventListener() {}}, runtime = {};
  install({config: {gameDataDir: "/unused-game-data", gameArguments: []}}, target);
  target.MacLauncherWolf.configure(runtime);
  assert.equal(Object.hasOwn(runtime, "arguments"), false);
});

test("ordinary Play asks for a missing runtime, respects cancellation and prepares after installation", async t => {
  const { createLauncher } = require("../src/core/launcher");
  const dir = fixture(t), game = path.join(dir, "game"), userDataDir = path.join(dir, "state"); fs.mkdirSync(game); fs.mkdirSync(userDataDir);
  legacyFixture(path.join(game, "Data.wolf")); fs.writeFileSync(path.join(game, "Game.ini"), "WindowModeFlag=1");
  const originalFetch = Core.fetchAvailableVersions, originalInstall = Manager.installRuntime;
  Core.fetchAvailableVersions = async () => ({ versions: ["0.6.2.0", "0.6.1.2"], releasesByVersion: {}, source: "Browser Woditor downloads" });
  let installations = 0, hosted = 0, approved = false, consent = [];
  Manager.installRuntime = async ({ userDataDir, version }) => { installations++; return fakeRuntime(userDataDir, version); };
  t.after(() => { Core.fetchAvailableVersions = originalFetch; Manager.installRuntime = originalInstall; });
  await Manager.refreshCatalog({ force: true });
  const registry = { listModules: () => [Wolf.manifest], listModuleIds: () => ["wolfrpg"], getModule: () => Wolf,
    getModuleInfo: () => Wolf.manifest, listSharedRuntimeManagers: () => [], detectGame: input => detectGame({ rootDir: input }) };
  const launcher = createLauncher({ userDataDir, registry, confirmRuntimeInstall: plan => { consent.push(plan); return approved; },
    launchHosted: async entry => { hosted++; assert.equal(fs.existsSync(entry.indexHtml), true); return {}; } });
  const entry = await launcher.resolveEntry(game);
  const cancelled = await launcher.launchEntry(entry);
  assert.equal(cancelled.kind, "cancelled"); assert.equal(installations, 0); assert.equal(hosted, 0);
  assert.equal(consent[0].managerId, "browser-woditor"); assert.equal(consent[0].version, "0.6.2.0");
  approved = true; await launcher.launchEntry(entry); assert.equal(installations, 1); assert.equal(hosted, 1);
  await launcher.launchEntry(entry); assert.equal(installations, 1); assert.equal(consent.length, 2);
});
