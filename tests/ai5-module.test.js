const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("../src/modules/ai5/main");
const Inspect = require("../src/modules/ai5/inspect");
const runtimeFixture = { version: "fixture-ai5", revision: "a".repeat(40) };
const { archiveFixture } = require("./helpers/ai5-fixture");
const { peFixture, versionResource } = require("./helpers/pe-fixture");
const { createRuntimeSettingsStore } = require("../src/core/runtime-settings");
const { isoFixture } = require("./helpers/iso-fixture");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai5-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function gameFixture(root, { ini = "[CONFIG]\nTITLE=YU-NO - The Girl that Chants Love at the Edge of the World\nSTARTMES=START.MES\n[FILE]\nbARCMES=1\nARCMESNAME=MES.ARC\n", runner } = {}) {
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "AI5ENG.INI"), ini);
  fs.writeFileSync(path.join(root, "MES.ARC"), archiveFixture().bytes);
  if (runner) fs.writeFileSync(path.join(root, "AI5ENG.EXE"), runner);
  return { root, ini: path.join(root, "AI5ENG.INI"), script: path.join(root, "MES.ARC"), exe: path.join(root, "AI5ENG.EXE") };
}
function detection(root, inputPath = root) { return Module.detectGame({ rootDir: root, inputPath, isAppBundle: false }); }
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(root, entry.name)).map(file => entry.name + "/" + file) : [entry.name]);
}
function hashes(root) { return Object.fromEntries(files(root).map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])); }
function installFixture(root, { adapter = true, disc = true, version = runtimeFixture.version, embeddedVersion = version } = {}) {
  const executablePath = path.join(root, "bin/ai5"), fonts = path.join(root, "share/ai5-sdl2/fonts");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true }); fs.mkdirSync(fonts, { recursive: true });
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); bytes.writeUInt32LE(2, 12);
  const markers = ["MACLAUNCHER_AI5_SAVE_DIR", "MACLAUNCHER_AI5_OUTPUT_DIR", "MACLAUNCHER_AI5_FONT_DIR", "MACLAUNCHER_AI5_INI", ...(disc ? ["MACLAUNCHER_AI5_RESOURCE_DIR"] : []), embeddedVersion].join("\0");
  fs.writeFileSync(executablePath, Buffer.concat([bytes, Buffer.from(adapter ? markers : "stock interpreter")]), { mode: 0o755 });
  for (const name of ["DotGothic16-Regular.ttf", "Kosugi-Regular.ttf", "NotoSansJP-Thin.ttf", "wine_tahoma.ttf"]) fs.writeFileSync(path.join(fonts, name), "font fixture");
  return { version, upstreamRevision: runtimeFixture.revision, executablePath,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex") };
}

test("AI5 accepts any interpreter with the save adapter and reads the disc adapter from its markers", t => {
  const root = temporary(t);
  for (const version of ["fixture-ai5-a", "fixture-ai5-b", "fixture-ai5-c"]) {
    const install = installFixture(path.join(root, version), { version });
    assert.deepEqual(Module.__test.verifyProfile(install), { disc: true });
    assert.deepEqual(Module.__test.verifyProfile({ ...install, upstreamRevision: "0".repeat(40) }), { disc: true }, "A later source revision is accepted");
  }
  const stock = installFixture(path.join(root, "stock"), { adapter: false });
  assert.throws(() => Module.__test.verifyProfile(stock), /lacks per-game save support/);
});

test("AI5 v3 preserves original-file preparation and records its own runtime version", t => {
  const root = temporary(t), game = gameFixture(path.join(root, "source")), before = hashes(game.root);
  const install = installFixture(path.join(root, "native"), { version: runtimeFixture.version });
  const entry = { gameId: "portable-v3", gamePath: game.root }, context = { userDataDir: path.join(root, "userData"), runtimeSettings: {} };
  const launch = Module.__test.prepareLaunch(entry, context, install);
  assert.deepEqual(launch.args, ["--game", "yuno-eng", game.ini]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(launch.directory, "preparation.json"))).runtimeVersion, runtimeFixture.version);
  assert.deepEqual(hashes(game.root), before);
  assert.equal(launch.env.MACLAUNCHER_AI5_FONT_DIR, path.join(root, "native/share/ai5-sdl2/fonts"));
});

test("AI5 archive detection validates ARC XOR variants, DAT and shuffled Kakyuusei indices", t => {
  const root = temporary(t);
  for (const type of ["arc", "dat", "kakyuusei"]) {
    for (const offsetFirst of type === "arc" ? [false, true] : [false]) {
      const file = path.join(root, type === "dat" ? "MES.DAT" : "MES.ARC"), fixture = archiveFixture({ type, offsetFirst });
      fs.writeFileSync(file, fixture.bytes);
      const archive = Inspect.inspectArchive(file, type === "kakyuusei" ? "kakyuusei" : "yuno", null, "start.mes");
      assert.equal(archive.count, 4); assert.equal(archive.inspectedEntries, 4); assert.equal(archive.wantedEntry.name, "START.MES");
      assert.equal(archive.wantedEntry.offset, fixture.table); assert.equal(archive.wantedEntry.size, 256);
      assert.equal(Inspect.inspectArchive(file, type === "kakyuusei" ? "kakyuusei" : "yuno", null, "MISSING.MES"), null);
    }
  }
  for (const nameBytes of [12, 16, 20, 30, 32, 256]) {
    const file = path.join(root, "MES.ARC"); fs.writeFileSync(file, archiveFixture({ nameBytes }).bytes);
    assert.equal(Inspect.inspectArchive(file, "yuno", null, "START.MES").entryBytes, nameBytes + 8);
  }
});

test("AI5 rejects fake archives, late invalid entries and malformed byte ranges without decompressing payloads", t => {
  const root = temporary(t), file = path.join(root, "MES.ARC");
  fs.writeFileSync(file, "AI5WIN START.MES".repeat(80)); assert.equal(Inspect.inspectArchive(file, "yuno"), null);
  const fixture = archiveFixture({ count: 100 }), reads = [];
  fixture.bytes.writeUInt32LE((fixture.bytes.length + 4096) ^ fixture.offsetKey, fixture.index + 99 * fixture.stride + 24);
  fs.writeFileSync(file, fixture.bytes); assert.equal(Inspect.inspectArchive(file, "yuno"), null);
  const valid = archiveFixture({ count: 100 }); fs.writeFileSync(file, valid.bytes);
  const result = Inspect.inspectArchive(file, "yuno", { stat: fs.statSync, readBytes: (_file, offset, length) => {
    reads.push({ offset, length }); return valid.bytes.subarray(offset, offset + length);
  } });
  assert.equal(result.names.length, 16); assert.equal(result.inspectedEntries, 100);
  assert.ok(reads.every(read => read.offset + read.length <= valid.table));
  valid.bytes[valid.index + 99 * valid.stride] = 0x80 ^ valid.nameKey;
  fs.writeFileSync(file, valid.bytes); assert.equal(Inspect.inspectArchive(file, "yuno"), null);
});

test("AI5 requires coherent configuration plus real script metadata and separates game versions from engine versions", t => {
  const root = temporary(t), game = gameFixture(root);
  assert.equal(detection(root, game.exe).moduleId, "ai5");
  assert.equal(detection(root).moduleData.gameProfile, "yuno-eng");
  assert.equal(detection(root).moduleData.detectedVersion, null);
  fs.writeFileSync(game.exe, peFixture({ version: versionResource({ strings: { ProductName: "A Game", FileDescription: "A Game application" } }) }).bytes);
  assert.equal(detection(root, game.exe).moduleData.detectedVersion, null);
  assert.equal(detection(root, game.exe).moduleData.originalRunner.fileVersion, "1.5.7.23");
  fs.writeFileSync(game.exe, peFixture().bytes);
  assert.equal(detection(root, game.exe).moduleData.detectedVersion, "1.5.7.23");
  assert.match(detection(root, game.exe).moduleData.detectedVersionSource, /RT_VERSION/);
  assert.equal(Module.detectGame({ rootDir: root, inputPath: root, isAppBundle: true }), null);
  fs.writeFileSync(game.script, "not an archive"); assert.equal(detection(root), null);
});

test("AI5 handles original Japanese INIs, case and Windows installation paths without following escaping paths", t => {
  const root = temporary(t), game = gameFixture(root, { ini: '[config]\nTitle=YU-NO - The Girl that Chants Love at the Edge of the World\n[file]\nMES=C:\\Old Install\\Mes.Arc\nVOICE=MissingVoice.ARC\n' });
  assert.equal(detection(root).moduleData.scriptArchivePath, game.script);
  assert.deepEqual(detection(root).moduleData.missingOptionalArchives, ["MissingVoice.ARC"]);
  assert.equal(Inspect.decodeIni(Buffer.from([0x89, 0xba, 0x8b, 0x89, 0x90, 0xb6])), "下級生");
  assert.equal(Inspect.decodeIni(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("臭作", "utf16le")])), "臭作");
  const unsafe = ['../MES.ARC', '/tmp/MES.ARC', '\\\\server\\MES.ARC', 'C:relative.ARC'];
  for (const value of unsafe) {
    fs.writeFileSync(game.ini, `[config]\nTITLE=DOUKYUSEI\n[file]\nMES=${value}\n`); assert.equal(detection(root), null);
  }
  const outside = temporary(t); fs.writeFileSync(path.join(outside, "MES.ARC"), archiveFixture().bytes);
  fs.rmSync(game.script); fs.symlinkSync(path.join(outside, "MES.ARC"), game.script);
  fs.writeFileSync(game.ini, "[config]\nTITLE=DOUKYUSEI\n[file]\nMES=MES.ARC\n"); assert.equal(detection(root), null);
});

test("AI5 final archive aliases and companion INI follow native assignment order", t => {
  const root = temporary(t), game = gameFixture(root, { ini: "[CONFIG]\nTITLE=DOUKYUSEI\n[FILE]\nMES=wrong.arc\nARCMESNAME=MES.ARC\nbARCMES=1\n" });
  assert.equal(detection(root).moduleData.scriptArchivePath, game.script);
  fs.writeFileSync(path.join(root, "AI5SDL2.INI"), "[FILE]\nMES=MES.ARC\n[AI5SDL2]\nFONT=C:\\Windows\\Fonts\\old.ttf\n");
  assert.equal(detection(root).moduleData.archiveReferences.find(item => item.type === "mes").key, "mes");
  fs.writeFileSync(path.join(root, "AI5SDL2.INI"), "[FILE]\nMES=missing.arc\n"); assert.equal(detection(root), null);
});

test("AI5 loose scripts require independently identified original AI5 PE resources", t => {
  const root = temporary(t), game = gameFixture(root, { ini: "[CONFIG]\nTITLE=DOUKYUSEI\n[FILE]\nbARCMES=0\n[MES]\nbMESTYPE=1\n" });
  fs.writeFileSync(path.join(root, "START.MES"), Buffer.from([0, 1, 2]));
  assert.equal(detection(root), null);
  fs.writeFileSync(game.exe, peFixture().bytes); assert.ok(detection(root, game.exe));
  // An alias enables archive mode at its point in the INI. A later native
  // bARCMES=0 disables it, so an unused stale archive path must not block Play.
  fs.writeFileSync(game.ini, "[CONFIG]\nTITLE=DOUKYUSEI\n[FILE]\nMES=unused.arc\nbARCMES=0\n[MES]\nbMESTYPE=1\n");
  assert.ok(detection(root, game.exe));
  fs.writeFileSync(path.join(root, "START.MES"), Buffer.alloc(0)); assert.equal(detection(root, game.exe), null);
});

test("AI5 preparation reads original assets, writes only private config and preserves existing saves", t => {
  const root = temporary(t), game = gameFixture(path.join(root, "source"), { ini: '[CONFIG]\nTITLE=YU-NO - The Girl that Chants Love at the Edge of the World\n[FILE]\nMES=C:\\old\\Mes.ARC\n' });
  fs.writeFileSync(path.join(game.root, "AI5SDL2.INI"), "[AI5SDL2]\nFONT=C:\\Windows\\Fonts\\old.ttf\nFONTFACE=0\nTEXTHOOKCLIPBOARD=1\n");
  fs.writeFileSync(path.join(game.root, "SAVE00.DAT"), "portable player save");
  const before = hashes(game.root), install = installFixture(path.join(root, "native"));
  const entry = { gameId: "original-data", gamePath: game.root, moduleData: detection(game.root).moduleData };
  const context = { userDataDir: path.join(root, "userData"), runtimeSettings: { textCapture: "console" } };
  Module.onImport(entry, context); assert.match(entry.defaultSaveDir, /original-data.*saves/);
  const launch = Module.__test.prepareLaunch(entry, context, install);
  assert.equal(launch.root, game.root); assert.deepEqual(launch.args, ["--game", "yuno-eng", "--texthook-stdout", game.ini]);
  assert.equal(launch.env.MACLAUNCHER_AI5_SAVE_DIR, entry.defaultSaveDir);
  assert.match(fs.readFileSync(launch.configPath, "utf8"), new RegExp("MES=" + game.script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!fs.readFileSync(launch.configPath, "utf8").includes("C:\\Windows"));
  assert.equal(Inspect.parseIni(fs.readFileSync(launch.configPath, "utf8")).ai5sdl2.texthookclipboard, "0");
  assert.equal(Inspect.parseIni(fs.readFileSync(launch.configPath, "utf8")).ai5sdl2.texthookstdout, "1");
  assert.deepEqual(files(launch.directory).sort(), ["AI5SDL2.INI", "preparation.json"]);
  assert.deepEqual(hashes(game.root), before);
  fs.writeFileSync(path.join(launch.saves, "SAVE00.DAT"), "private player progress");
  Module.__test.prepareLaunch(entry, context, install);
  assert.equal(fs.readFileSync(path.join(launch.saves, "SAVE00.DAT"), "utf8"), "private player progress");
  assert.deepEqual(hashes(game.root), before);
});

test("AI5 Play preflights data and supported profiles before requesting an install", t => {
  const root = temporary(t), game = gameFixture(path.join(root, "source")), entry = { gameId: "play", gamePath: game.root };
  const context = { userDataDir: path.join(root, "userData"), settings: {}, runtimeSettings: {} };
  const requirement = Module.ensureRuntime(entry, context), selected = Module.runtimeManagers[0].resolveSelection(entry, context.settings, context.userDataDir);
  if (selected.ready) {
    assert.equal(requirement, null); assert.equal(selected.install.bundledExecution, "direct");
    assert.equal(fs.existsSync(path.join(context.userDataDir, "runtimes")), false);
  } else {
    assert.equal(requirement.managerId, "ai5");assert.equal(requirement.version, null);
    assert.equal(requirement.discoveryRequired, true);assert.equal(requirement.selectionRequired, true);
  }
  require("../src/modules/shared/runtime/runtime-catalog").writeRuntimeCatalog({ userDataDir: context.userDataDir, managerId: "ai5", source: "https://github.com/nunuhara/ai5-sdl2/releases",
    entries: [{ version: "fixture-source", upstreamRevision: "a".repeat(40), localBuild: false, installReason: "Source release only" }] });
  entry.runtimeData = { ai5: { version: "fixture-source" } };
  assert.throws(() => Module.ensureRuntime(entry, context), /Source release only/);
  delete entry.runtimeData;
  context.runtimeSettings.gameProfile = "unsupported-remake";
  assert.throws(() => Module.ensureRuntime(entry, context), /unrecognized/);
  delete context.runtimeSettings.gameProfile; fs.rmSync(game.script);
  assert.throws(() => Module.ensureRuntime(entry, context), /not found/);
});

test("AI5 normalized automatic settings retain the detected English edition on Play", t => {
  const root = temporary(t), game = gameFixture(path.join(root, "source"));
  const entry = { gameId: "english-profile", gamePath: game.root, moduleId: "ai5", moduleData: detection(game.root).moduleData };
  const userDataDir = path.join(root, "userData"), store = createRuntimeSettingsStore({ userDataDir });
  const context = { userDataDir, runtimeSettings: store.resolveForEntry(entry, {}, Module.manifest, "ai5") };
  assert.equal(context.runtimeSettings.gameProfile, "auto");
  const install = installFixture(path.join(root, "native"));
  assert.deepEqual(Module.__test.prepareLaunch(entry, context, install).args, ["--game", "yuno-eng", game.ini]);
  entry.runtimeSettings = { ai5: { gameProfile: "yuno" } };
  context.runtimeSettings = store.resolveForEntry(entry, {}, Module.manifest, "ai5");
  assert.deepEqual(Module.__test.prepareLaunch(entry, context, install).args, ["--game", "yuno", game.ini]);
});

test("AI5 original-disc compatibility follows installed adapter markers and preserves choices", t => {
  const root = temporary(t), game = gameFixture(path.join(root, "source"));
  fs.writeFileSync(path.join(game.root, "ORIGINAL.bin"), isoFixture({ raw: true }).bytes);
  const entry = { gameId: "disc-selection", gamePath: game.root, runtimeData: {} };
  const context = { userDataDir: path.join(root, "userData"), settings: { runtimes: { ai5: { defaultVersion: "fixture-without-disc" } } }, runtimeSettings: {} };
  const legacy = installFixture(path.join(root, "native"), { version: "fixture-without-disc", disc: false });
  const manager = Module.runtimeManagers[0];
  t.mock.method(manager, "resolveSelection", (value, settings) => {
    const version = value?.runtimeData?.ai5?.version || settings?.runtimes?.ai5?.defaultVersion;
    return version === legacy.version ? { version, ready: true, install: legacy } : { version: null, ready: false, selectionRequired: true };
  });
  assert.throws(() => Module.ensureRuntime(entry, context), /original disc layout needs an interpreter/);
  assert.equal(context.settings.runtimes.ai5.defaultVersion, "fixture-without-disc");
  context.settings.runtimes.ai5.defaultVersion = "auto";
  const requirement = Module.ensureRuntime(entry, context);
  assert.equal(requirement.version, null); assert.equal(requirement.selectionRequired, true);
  assert.deepEqual(entry.runtimeData, {});
  entry.runtimeData.ai5 = { version: "fixture-without-disc" };
  assert.throws(() => Module.ensureRuntime(entry, context), /original disc layout needs an interpreter/);
  assert.equal(entry.runtimeData.ai5.version, "fixture-without-disc");
});

test("AI5 refuses runtimes without the private-save adapter before publishing local registration", { skip: process.platform !== "darwin" }, t => {
  const root = temporary(t), install = installFixture(path.join(root, "stock"), { adapter: false }), context = { userDataDir: path.join(root, "userData") };
  require("../src/modules/shared/runtime/runtime-catalog").writeRuntimeCatalog({ userDataDir: context.userDataDir, managerId: "ai5", source: "https://github.com/nunuhara/ai5-sdl2/releases",
    entries: [{ version: install.version, upstreamRevision: install.upstreamRevision, localBuild: false }] });
  assert.throws(() => Module.actions.registerRuntime({}, { version: install.version, upstreamRevision: install.upstreamRevision, runtimePath: install.executablePath }, context), /lacks per-game save support/);
  assert.equal(Module.runtimeManagers[0].core.resolveRegistered({ userDataDir: context.userDataDir, version: runtimeFixture.version }), null);
  assert.deepEqual(Module.runtimeManagers[0].getState({ userDataDir: context.userDataDir }).installed, []);
  assert.throws(() => Module.__test.verifyProfile({ ...install, version: "1.4.1" }), /lacks per-game save support/);
});

test("AI5 catalogs are empty before Refresh and retain an explicit version choice", t => {
  const userDataDir = temporary(t), managerPath = require.resolve("../src/modules/ai5/runtime/manager");
  require("node:child_process").execFileSync(process.execPath, ["-e", '\n' +
    'const assert = require("node:assert/strict"), manager = require(' + JSON.stringify(managerPath) + '), userDataDir = process.argv[1];\n' +
    'assert.deepEqual(manager.core.listCatalog({userDataDir}), []);\n' +
    'const state = manager.getState({userDataDir}); assert.deepEqual(state.catalog.versions, []); assert.deepEqual(state.catalog.includedVersions, []);\n' +
    'assert.equal(manager.resolveSelection({runtimeData:{ai5:{version:"fixture-choice"}}},{},userDataDir).version,"fixture-choice");', userDataDir]);
});
