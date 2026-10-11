const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Inspect = require("../src/modules/gamemaker/inspect");
const Detect = require("../src/modules/gamemaker/detect");
const Exports = require("../src/modules/gamemaker/export");
const Tools = require("../src/modules/gamemaker/tools");
const Module = require("../src/modules/gamemaker/main");
const Butterscotch = require("../src/modules/gamemaker/runtime/butterscotch").manager;
const Umt = require("../src/modules/gamemaker/runtime/undertale-mod-tool").manager;
const Gm8 = require("../src/modules/gamemaker/runtime/gm8-decompiler").manager;
const { BUTTERSCOTCH_BUILDS, UMT_REVISION } = require("../src/modules/gamemaker/runtime/catalog");
const Official = require("../src/modules/gamemaker/runtime/official");
const OfficialPackages = require("../src/modules/gamemaker/runtime/official-packages");
const OfficialInstaller = require("../src/modules/gamemaker/runtime/official-installer");
const OfficialLaunch = require("../src/modules/gamemaker/runtime/official-launch");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-gamemaker-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function form({ wad = 16, code = "vm", extensionCount = 0, name = "gml_Script_start", extraChunks = [], compact = false } = {}) {
  const gen = Buffer.alloc(compact ? 84 : 128);
  gen[0] = 1; gen[1] = wad;
  [1, 4, 9999, 0].forEach((value, i) => gen.writeUInt32LE(value, 44 + i * 4));
  gen.writeUInt32LE(640, 60); gen.writeUInt32LE(480, 64);
  const text = ["Tiny Game", name].map(value => Buffer.from(value + "\0"));
  const strg = Buffer.alloc(12 + text.reduce((n, bytes) => n + 4 + bytes.length, 0));
  strg.writeUInt32LE(2, 0);
  const extn = Buffer.alloc(4 + extensionCount * 4); extn.writeUInt32LE(extensionCount, 0);
  const codeData = code === "absent" ? null : code === "empty" ? Buffer.alloc(0) : code === "zero-count" ? Buffer.alloc(4) : Buffer.alloc(wad <= 14 ? 20 : 32);
  const chunks = [{ id: "GEN8", data: gen }, { id: "EXTN", data: extn }, { id: "STRG", data: strg },
    ...(codeData ? [{ id: "CODE", data: codeData }] : []), ...extraChunks];
  let offset = 8;
  for (const chunk of chunks) { chunk.offset = offset; chunk.dataOffset = offset + 8; offset += 8 + chunk.data.length; }
  const strgOffset = chunks.find(chunk => chunk.id === "STRG").dataOffset;
  const strings = [];
  let at = 12;
  text.forEach((bytes, i) => {
    strg.writeUInt32LE(strgOffset + at, 4 + i * 4);
    strg.writeUInt32LE(bytes.length - 1, at);
    bytes.copy(strg, at + 4);
    strings.push(strgOffset + at + 4);
    at += 4 + bytes.length;
  });
  if (!compact) { gen.writeUInt32LE(strings[0], 40); gen.writeUInt32LE(strings[0], 100); }
  if (codeData && codeData.length > 4) {
    const codeOffset = chunks.find(chunk => chunk.id === "CODE").dataOffset;
    const pointer = codeOffset + (wad <= 14 ? 8 : 12);
    codeData.writeUInt32LE(1, 0); codeData.writeUInt32LE(pointer, 4);
    const entryAt = pointer - codeOffset;
    codeData.writeUInt32LE(strings[1], entryAt); codeData.writeUInt32LE(4, entryAt + 4);
    if (wad > 14) codeData.writeInt32LE(-16, entryAt + 12);
  }
  const output = Buffer.alloc(offset);
  output.write("FORM", 0); output.writeUInt32LE(offset - 8, 4);
  chunks.forEach(chunk => {
    output.write(chunk.id, chunk.offset); output.writeUInt32LE(chunk.data.length, chunk.offset + 4);
    chunk.data.copy(output, chunk.dataOffset);
  });
  return output;
}

function writeForm(root, options, name = "data.win") {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, form(options));
  return target;
}
function detect(inputPath) { return Detect.detectGame({ inputPath, stat: fs.statSync(inputPath), rootDir: path.dirname(inputPath) }); }
function entry(root, options) {
  const detected = detect(writeForm(root, options));
  return { ...detected, gameId: "tiny-game", moduleId: "gamemaker" };
}
function nativeBinary(root, name = "runner") {
  const target = path.join(root, name);
  const data = Buffer.alloc(64);
  data.writeUInt32LE(0xfeedfacf, 0); data.writeUInt32LE(0x0100000c, 4); data.writeUInt32LE(2, 12);
  fs.writeFileSync(target, data, { mode: 0o755 });
  return target;
}
function classic(version = "8.0") {
  const is81 = version === "8.1";
  const data = Buffer.alloc(is81 ? 0x300030 : 0x144b00);
  data.write("MZ", 0); data.writeUInt32LE(0x80, 0x3c);
  Buffer.from([0x50, 0x45, 0, 0, 0x4c, 1]).copy(data, 0x80);
  Buffer.from(is81 ? [0xe8, 0x80, 0xf2, 0xdd, 0xff, 0xc7, 0x45, 0xf0] : [0x8b, 0x45, 0xf4, 0xe8, 0x2a, 0xbd, 0xfd, 0xff]).copy(data, is81 ? 0x226cf3 : 0xa49be);
  data.writeUInt32LE(is81 ? 0x300000 : 0x144ad0, is81 ? 0x226cfb : 0x144ac0);
  return data;
}

function audioArchive(root, name, withPath) {
  const bytes = form({ wad: 17, extraChunks: [{ id: "UILR", data: Buffer.alloc(0) }, { id: "AGRP", data: Buffer.alloc(withPath ? 16 : 12) }] });
  let strg, audio;
  for (let offset = 8; offset < bytes.length; offset += 8 + bytes.readUInt32LE(offset + 4)) {
    const id = bytes.toString("ascii", offset, offset + 4);
    if (id === "STRG") strg = offset + 8;
    if (id === "AGRP") audio = offset + 8;
  }
  const namePointer = bytes.readUInt32LE(strg + 4) + 4;
  bytes.writeUInt32LE(1, audio); bytes.writeUInt32LE(audio + 8, audio + 4); bytes.writeUInt32LE(namePointer, audio + 8);
  if (withPath) bytes.writeUInt32LE(namePointer, audio + 12);
  const file = path.join(root, name); fs.writeFileSync(file, bytes); return file;
}

test("Studio detection validates structure and records VM evidence without promising compatibility", t => {
  const root = temporary(t);
  const file = writeForm(root);
  const info = Inspect.inspectStudio(file, { includeNames: true });
  assert.equal(info.executionKind, "studio-vm");
  assert.equal(info.codeCount, 1);
  assert.equal(info.codeBytes, 4);
  assert.equal(info.wadVersion, 16);
  assert.equal(info.name, "Tiny Game");
  assert.equal(info.codeEntries[0].name, "gml_Script_start");
  assert.equal(info.compatibility, "format-candidate");
  assert.equal(info.butterscotchCandidate, true);
  assert.equal(detect(root).moduleData.dataPath, file);
  const exe = path.join(root, "Tiny.exe"); fs.writeFileSync(exe, "MZ");
  assert.equal(detect(exe).moduleData.executionKind, "studio-vm");
  assert.equal(fs.readFileSync(file).equals(form()), true);
});

test("old inline WAD code and newer relative code are distinct parsed layouts", t => {
  const root = temporary(t);
  for (const wad of [8, 13, 14, 15, 16, 17]) {
    const info = Inspect.inspectStudio(writeForm(root, { wad }));
    assert.equal(info.codeBytes, 4);
    assert.equal(info.wadVersion, wad);
  }
  const compact = Inspect.inspectStudio(writeForm(root, { wad: 8, compact: true }));
  assert.equal(compact.gen8VersionTuple, null);
  assert.equal(compact.rawVersionReliable, false);
  assert.equal(compact.detectedVersion, "1.0.198+");
  assert.equal(compact.versionEvidence.some(item => item.kind === "header-tuple"), false);
});

test("YYC/code-free, earlier formats, newer formats and extensions remain unqualified", t => {
  const root = temporary(t);
  for (const code of ["absent", "empty", "zero-count"]) {
    const game = entry(root, { code });
    assert.equal(game.moduleData.executionKind, "native-or-no-code");
    assert.equal(game.moduleData.butterscotchCandidate, false);
    assert.deepEqual(Module.filterRuntimeSupport(game, ["butterscotch", "native", "inspection"]), ["inspection"]);
  }
  for (const options of [{ wad: 7 }, { wad: 18 }, { extensionCount: 1 }]) {
    const info = Inspect.inspectStudio(writeForm(root, options));
    assert.equal(info.butterscotchCandidate, false);
    assert.ok(info.reasons.length);
  }
});

test("random data.win names, duplicate chunks, truncation and malicious CODE pointers are rejected", t => {
  const root = temporary(t);
  const file = path.join(root, "data.win");
  fs.writeFileSync(file, "a file named data.win does not establish GameMaker");
  assert.equal(detect(root), null);
  for (const bytes of [form().subarray(0, 100), form({ extraChunks: [{ id: "GEN8", data: Buffer.alloc(0) }] })]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => Inspect.inspectStudio(file));
  }
  const bytes = form(); const code = bytes.indexOf(Buffer.from("CODE"));
  bytes.writeUInt32LE(0xfffffff0, code + 12);
  fs.writeFileSync(file, bytes);
  assert.throws(() => Inspect.inspectStudio(file), /outside CODE/);
  const hugeCount = form(); hugeCount.writeUInt32LE(0xffffffff, code + 8);
  fs.writeFileSync(file, hugeCount);
  assert.throws(() => Inspect.inspectStudio(file), /CODE table/);
  assert.equal(detect(file), null);
});

test("ambiguous multiple archives require a direct data import and native apps need a Mac executable", t => {
  const root = temporary(t);
  writeForm(root); writeForm(root, {}, "game.ios");
  assert.equal(detect(root), null);
  assert.equal(detect(path.join(root, "game.ios")).engine, "gamemaker");
  const app = path.join(root, "Tiny.app");
  writeForm(app, {}, "Contents/Resources/game.ios");
  const game = detect(app);
  assert.equal(game.nativeAppPath, app);
  assert.equal(Module.resolveNativeLaunchPath(game), null);
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  nativeBinary(path.join(app, "Contents/MacOS"));
  assert.equal(Module.resolveNativeLaunchPath(game), app);
});

test("Classic loader signatures stay separate from Studio and ordinary Windows PE files", t => {
  const root = temporary(t);
  const exe = path.join(root, "Classic.exe");
  for (const version of ["8.0", "8.1"]) {
    fs.writeFileSync(exe, classic(version));
    const info = Inspect.inspectClassic(exe);
    assert.equal(info.classicVersion, version);
    assert.equal(info.assetsVerified, false);
    assert.equal(info.compatibility, "format-candidate");
    const game = detect(exe);
    assert.equal(game.moduleData.executionKind, "classic");
    assert.deepEqual(Module.filterRuntimeSupport(game, ["butterscotch", "native", "inspection"]), ["inspection"]);
    assert.equal(Module.canLaunchRuntime("butterscotch", game), false);
  }
  const bytes = classic(); bytes.fill(0, 0xa49be, 0xa49c6); fs.writeFileSync(exe, bytes);
  assert.equal(Inspect.inspectClassic(exe), null);
  assert.equal(detect(exe), null);
  writeForm(root);
  assert.equal(detect(exe).moduleData.executionKind, "studio-vm");
});

test("raw chunk exports preserve payload bytes, offsets and hashes without editing the game", t => {
  const root = temporary(t);
  const game = entry(root);
  const source = fs.readFileSync(game.moduleData.dataPath);
  const context = { userDataDir: path.join(root, "launcher") };
  const report = Exports.exportInspection(game, context);
  assert.equal(JSON.parse(fs.readFileSync(report.reportPath)).compatibility, "format-candidate");
  const result = Exports.exportChunks(game, context);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outputDir, "manifest.json")));
  assert.equal(manifest.representation, "raw-chunk-payloads-with-original-absolute-pointers");
  for (const file of manifest.files) {
    assert.deepEqual(fs.readFileSync(path.join(result.outputDir, file.filename)), source.subarray(file.sourceOffset, file.sourceOffset + file.bytes));
    assert.equal(Inspect.hashFile(path.join(result.outputDir, file.filename)), file.sha256);
  }
  assert.deepEqual(fs.readFileSync(game.moduleData.dataPath), source);
  assert.notEqual(Exports.exportChunks(game, context).outputDir, result.outputDir);
});

test("export destinations reject traversal and symlinked launcher cache paths", t => {
  const root = temporary(t);
  const game = entry(root);
  const context = { userDataDir: path.join(root, "launcher") };
  assert.throws(() => Exports.resolveOutputRoot({ ...game, gameId: "../../outside" }, context), /invalid/);
  fs.mkdirSync(context.userDataDir);
  fs.symlinkSync(root, path.join(context.userDataDir, "games"));
  assert.throws(() => Exports.exportChunks(game, context), /symlink/);
});

test("selecting Studio launches without a hidden setting, validates current data and supplies private saves", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t);
  const game = entry(root);
  const userDataDir = path.join(root, "launcher");
  const version = BUTTERSCOTCH_BUILDS[0].version;
  const executable = nativeBinary(root);
  const installed = Butterscotch.core.registerLocal({ userDataDir, version, runtimePath: executable });
  game.runtimeData = { ...game.runtimeData, butterscotch: { version } };
  let spawned = false;
  const context = { userDataDir, settings: {}, runtimeSettings: {}, spawnDetachedChecked() { spawned = true; } };
  context.spawnDetachedChecked = (command, args, options) => {
    spawned = true;
    assert.equal(command, executable);
    assert.deepEqual(args, [game.moduleData.dataPath, "--save-folder", game.defaultSaveDir, "--renderer", "legacy-gl"]);
    assert.equal(options.cwd, root);
    assert.ok(game.defaultSaveDir.startsWith(userDataDir));
    return { pid: 123 };
  };
  assert.deepEqual(await Module.launchRuntime("butterscotch", game, context), { pid: 123 });
  assert.equal(spawned, true);
  assert.equal(game.moduleData.lastRuntimeSha256, installed.binarySha256);
  assert.equal(game.moduleData.lastRuntimeVersion, version);
  fs.appendFileSync(executable, "changed");
  assert.equal(Module.actions.runtimeStatus(game, {}, context).ready, false);
  await assert.rejects(Module.launchRuntime("butterscotch", game, context), /not installed|changed/);
  writeForm(root, { extensionCount: 1 });
  await assert.rejects(Module.launchRuntime("butterscotch", game, context), /extensions/i);
});

test("decompilation uses the pinned CLI dump command and rejects traversal/YYC input", async t => {
  const root = temporary(t);
  const game = entry(root);
  const context = { userDataDir: path.join(root, "launcher") };
  const selection = { version: "0.9.2.0-arm64", install: { executablePath: "/test/UndertaleModCli", upstreamRevision: UMT_REVISION, binarySha256: "a".repeat(64) } };
  const calls = [];
  const runProcess = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "--version") return { stdout: `0.9.2.0+${UMT_REVISION}\n`, stderr: "" };
    assert.equal(args[0], "dump");
    assert.deepEqual(args.slice(-3), ["--code", "UMT_DUMP_ALL", "--strings"]);
    assert.equal(args.includes("--scripts"), false);
    assert.equal(args.includes("load"), false);
    const destination = args[args.indexOf("--output") + 1];
    fs.mkdirSync(path.join(destination, "CodeEntries"));
    fs.writeFileSync(path.join(destination, "CodeEntries", "gml_Script_start.gml"), "return 1;");
    return { stdout: "decompiled", stderr: "" };
  };
  const before = Inspect.hashFile(game.moduleData.dataPath);
  const result = await Tools.decompileStudio(game, context, selection, { runProcess });
  assert.equal(result.codeCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(Inspect.hashFile(game.moduleData.dataPath), before);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outputDir, "manifest.json")));
  assert.equal(manifest.upstreamRevision, UMT_REVISION);
  assert.equal(manifest.binarySha256, "a".repeat(64));
  writeForm(root, { code: "empty" });
  await assert.rejects(Tools.decompileStudio(game, context, selection, { runProcess }), /YYC/);
  writeForm(root, { name: "../escape" });
  await assert.rejects(Tools.decompileStudio(game, context, selection, { runProcess }), /unsafe/);
  writeForm(root);
  await assert.rejects(Tools.decompileStudio(game, context, selection, { runProcess: async () => ({ stdout: "wrong-version", stderr: "" }) }), /pinned/);
});

test("a tool that claims success without producing GML leaves no successful export", async t => {
  const root = temporary(t); const game = entry(root);
  const context = { userDataDir: path.join(root, "launcher") };
  const selection = { version: "0.9.2.0-arm64", install: { executablePath: "/test/tool", upstreamRevision: UMT_REVISION } };
  await assert.rejects(Tools.decompileStudio(game, context, selection, { runProcess: async (_cmd, args) => ({ stdout: args[0] === "--version" ? `0.9.2.0+${UMT_REVISION}` : "", stderr: "" }) }), /no GML/);
  assert.deepEqual(fs.readdirSync(Exports.resolveOutputRoot(game, context)), []);
});

test("Decompile installs the exact missing native tool and validates input before installation", { skip: process.platform !== "darwin" }, async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), context = { userDataDir, settings: {} };
  const game = entry(path.join(root, "studio"));
  const selectedVersion = Umt.core.catalog[0].version;
  game.runtimeData = { "undertale-mod-cli": { version: selectedVersion } };
  let installs = 0, exports = 0, prompts = 0;
  context.confirmRuntimeInstall = async plan => {
    prompts++; assert.equal(plan.managerId, Umt.id); assert.equal(plan.version, selectedVersion);
    assert.equal(plan.confirmLabel, "Download and Continue"); return { approved: true };
  };
  t.mock.method(Umt, "installRuntime", async options => {
    installs++;
    assert.equal(options.version, selectedVersion);
    return Umt.core.registerLocal({ ...options, runtimePath: nativeBinary(root, "umt") });
  });
  t.mock.method(Tools, "decompileStudio", async (selectedEntry, selectedContext, selection) => {
    exports++;
    assert.equal(selectedEntry, game); assert.equal(selectedContext, context);
    assert.equal(selection.version, selectedVersion); assert.ok(selection.install.binarySha256);
    return { outputDir: path.join(userDataDir, "export"), codeCount: 1, version: selection.version };
  });
  await Module.actions.decompile(game, {}, context);
  assert.equal(installs, 1); assert.equal(exports, 1); assert.equal(prompts, 1);
  assert.equal(game.moduleData.lastExportDir, path.join(userDataDir, "export"));
  await Module.actions.decompile(game, {}, context);
  assert.equal(installs, 1); assert.equal(exports, 2); assert.equal(prompts, 1);
  const invalid = entry(path.join(root, "invalid"), { name: "../unsafe" });
  await assert.rejects(Module.actions.decompile(invalid, {}, context), /unsafe/);
  const yyc = entry(path.join(root, "yyc"), { code: "empty" });
  await assert.rejects(Module.actions.decompile(yyc, {}, context), /YYC/);
  assert.equal(installs, 1); assert.equal(exports, 2);
  context.confirmRuntimeInstall = () => assert.fail("The included native decompiler needs no download");

  const exe = path.join(root, "Classic.exe"); fs.writeFileSync(exe, classic());
  const classicEntry = { ...detect(exe), gameId: "classic" };
  const classicSelection = Gm8.resolveSelection(classicEntry, {}, userDataDir);
  const classicVersion = classicSelection.version;
  t.mock.method(Gm8, "installRuntime", async options => {
    installs++;
    assert.equal(options.version, classicVersion);
    return Gm8.core.registerLocal({ ...options, runtimePath: nativeBinary(root, "gm8decompiler") });
  });
  t.mock.method(Tools, "decompileClassic", async (_entry, _context, selection) => {
    assert.equal(selection.version, classicVersion); assert.ok(selection.install.binarySha256);
    return { outputDir: path.join(userDataDir, "classic-export"), version: selection.version };
  });
  await Module.actions.decompile(classicEntry, {}, context);
  assert.equal(installs, classicSelection.ready ? 1 : 2);
  if (classicSelection.install?.bundledExecution === "direct") {
    assert.equal(classicSelection.install.readOnly, true);
    assert.equal(fs.existsSync(Gm8.core.getInstallDir({ userDataDir, version: classicVersion })), false);
  }
  assert.equal(classicEntry.moduleData.lastExportDir, path.join(userDataDir, "classic-export"));
});

test("declining GameMaker decompiler installation neither downloads nor exports", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher"), game = entry(path.join(root, "studio"));
  const context = { userDataDir, settings: {}, confirmRuntimeInstall: async () => false };
  t.mock.method(Umt, "installRuntime", () => assert.fail("Declined installation cannot download"));
  t.mock.method(Tools, "decompileStudio", () => assert.fail("Declined installation cannot export"));
  await assert.rejects(Module.actions.decompile(game, {}, context), { code: "ABORT_ERR" });
  assert.equal(game.moduleData.lastExportDir, undefined);
  context.confirmRuntimeInstall = () => assert.fail("An unknown explicit version cannot prompt");
  await assert.rejects(Module.actions.decompile(game, { version: "unknown" }, context), /Unsupported.*version/);
});

test("Classic decompilation stays strict and never starts the OpenGMK Wine helper", async t => {
  const root = temporary(t);
  const exe = path.join(root, "Classic.exe"); fs.writeFileSync(exe, classic());
  const game = { ...detect(exe), gameId: "classic-game" };
  const context = { userDataDir: path.join(root, "launcher") };
  const selection = { version: "2.2.0-9ccc47a9", install: { executablePath: "/test/gm8decompiler", upstreamRevision: "9ccc47a9cab4681a889866f7233a6b016d36a15e", binarySha256: "b".repeat(64) } };
  const result = await Tools.decompileClassic(game, context, selection, { runProcess: async (cmd, args) => {
    assert.equal(cmd, "/test/gm8decompiler");
    if (args[0] === "--help") return { stdout: "GM8Decompiler v2.2.0 #9ccc47a", stderr: "" };
    assert.equal(args.includes("--lazy"), false); assert.equal(args.includes("wine"), false);
    assert.equal(args[args.indexOf("--deobfuscate") + 1], "off");
    fs.writeFileSync(args[args.indexOf("--output") + 1], "project");
    return { stdout: "ok", stderr: "" };
  } });
  assert.equal(path.extname(result.projectPath), ".gmk");
});

test("tool catalogs start without factory release rows while exact acquisition pins and strict selections remain available", t => {
  const root = temporary(t);
  const state = Umt.getState({ userDataDir: root, settings: {} });
  assert.deepEqual(state.catalog.versions, []);
  assert.deepEqual(state.catalog.installableVersions, []);
  assert.deepEqual(new Set(Umt.core.catalog.map(pin => pin.version)), new Set(["0.9.2.0-arm64", "0.9.2.0-x86_64"]));
  for (const pin of Umt.core.catalog) {
    assert.equal(pin.upstreamRevision, UMT_REVISION);
    assert.match(pin.asset.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Umt.core.normalizeVersion(pin.version), pin.version);
  }
  const preferred = process.arch === "x64" ? "0.9.2.0-x86_64" : "0.9.2.0-arm64";
  assert.equal(Umt.resolveSelection({}, {}, root).version, preferred);
  const missing = Umt.resolveSelection({ runtimeData: { "undertale-mod-cli": { version: "unlisted-nightly" } } }, {}, root);
  assert.equal(missing.ready, false);
  assert.equal(missing.version, "unlisted-nightly");
  assert.match(missing.reason, /unlisted-nightly.*not available/);
  assert.throws(() => Butterscotch.core.normalizeVersion("latest"), /Unsupported/);
  assert.equal(Module.manifest.supports.cheats, false);
  assert.equal(Module.manifest.supports.saveEditing, false);
});

test("game version evidence separates GEN8 tuple, WAD generation and structural version floors", t => {
  const root = temporary(t);
  const file = writeForm(root, { wad: 17, extraChunks: [{ id: "FEAT", data: Buffer.alloc(4) }, { id: "UILR", data: Buffer.alloc(0) }] });
  const bytes = fs.readFileSync(file);
  bytes.writeUInt32LE(2, 16 + 44); bytes.writeUInt32LE(0, 16 + 48); bytes.writeUInt32LE(0, 16 + 52); bytes.writeUInt32LE(0, 16 + 56);
  fs.writeFileSync(file, bytes);
  const info = Inspect.inspectStudio(file);
  assert.deepEqual(info.gen8VersionTuple, [2, 0, 0, 0]);
  assert.equal(info.exactEngineVersion, null);
  assert.equal(info.detectedVersion, "2024.13+");
  assert.equal(info.detectedVersionConfidence, "format-minimum");
  assert.equal(info.rawVersionReliable, false);
  assert.ok(info.versionEvidence.some(item => item.source === "FEAT chunk" && item.value === "2022.8"));
  assert.ok(info.versionEvidence.some(item => item.kind === "format-version" && item.value === 17));
  const game = detect(file);
  assert.equal(game.moduleData.candidateRuntimeBuilds[0].version, "d66464857303-appkit");
  assert.equal(game.moduleData.detectedVersion, "2024.13+");
});

test("audio-group path evidence bounds official runner selection across the 2024.14 layout change", t => {
  const root = temporary(t);
  const legacy = audioArchive(root, "legacy.win", false), old = Inspect.inspectStudio(legacy);
  assert.equal(old.detectedVersion, "2024.13–<2024.14");
  assert.equal(old.maximumOfficialRuntimeExclusive, "2024.14");
  assert.equal(old.exactEngineVersion, null);
  assert.ok(old.versionEvidence.some(item => item.source === "AGRP audio-group path field"));
  assert.throws(() => OfficialLaunch.preflight(legacy, "2026.0.0.23"), /AGRP/);
  assert.equal(OfficialLaunch.preflight(legacy, "2024.13.1.242").audioGroupLayout, "legacy-name-only-or-null-path");
  assert.equal(detect(legacy).moduleData.maximumOfficialRuntimeExclusive, "2024.14");
  assert.equal(detect(legacy).moduleData.candidateRuntimeBuilds.some(item => item.runtimeId === "official-studio" && item.version === "2026.0.0.23"), false);
  const modern = audioArchive(root, "modern.win", true);
  assert.equal(Inspect.inspectStudio(modern).minimumEngineVersion, "2024.14");
  assert.throws(() => OfficialLaunch.preflight(modern, "2024.13.1.242"), /predates/);
});

test("Steam is detected from format fields and missing native support fails before runner staging", async t => {
  const root = temporary(t), file = writeForm(root), before = fs.readFileSync(file);
  const bytes = Buffer.from(before), gen8 = 16;
  bytes.writeUInt32LE(0x1000, gen8 + 68); bytes.writeInt32LE(480, gen8 + 120); fs.writeFileSync(file, bytes);
  const info = Inspect.inspectStudio(file);
  assert.equal(info.steamEnabled, true); assert.equal(info.steamAppId, 480);
  assert.equal(detect(file).moduleData.steamEnabled, true);
  const selected = { version: "1.4.9999", install: { launchReady: true, runnerAppPath: path.join(root, "missing.app") } };
  await assert.rejects(OfficialLaunch.launchOfficial({ ...detect(file), gameId: "steam-fixture" }, { userDataDir: path.join(root, "launcher") }, selected),
    error => error.code === "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED" && error.fallbackRuntimeId === "butterscotch");
  assert.equal(fs.existsSync(path.join(root, "launcher")), false);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.doesNotThrow(() => OfficialLaunch.validateNativeDependencies({ steamEnabled: false }, file, selected.install));
});

test("legacy GEN8 Steam function classification requires native support even with its info flag clear", async t => {
  const root = temporary(t), file = writeForm(root);
  const bytes = fs.readFileSync(file), gen8 = 16;
  // These are distinct serialized fields, not a synthetic InfoFlags shortcut.
  bytes.writeUInt32LE(0x08b2, gen8 + 68);
  bytes.writeBigUInt64LE(0x2000000000000000n, gen8 + 112);
  bytes.writeInt32LE(-480, gen8 + 120);
  fs.writeFileSync(file, bytes);
  const info = Inspect.inspectStudio(file);
  assert.equal(info.steamEnabled, false);
  assert.equal(info.steamFunctions, true);
  assert.equal(info.steamRequired, true);
  assert.equal(info.steamAppId, -480, "retain the raw signed field rather than inventing an app ID");
  assert.equal(info.functionClassifications, "0x2000000000000000");
  assert.equal(detect(file).moduleData.steamRequired, true);
  await assert.rejects(OfficialLaunch.launchOfficial({ ...detect(file), gameId: "legacy-functions" },
    { userDataDir: path.join(root, "launcher") }, { version: "1.4.9999", install: {
      launchReady: true, runnerAppPath: path.join(root, "missing.app") } }),
    { code: "GAMEMAKER_STEAM_DEPENDENCY_REQUIRED" });
  assert.equal(fs.existsSync(path.join(root, "launcher")), false, "must reject before runner copies/private saves");
  assert.deepEqual(fs.readFileSync(file), bytes);
  bytes.writeBigUInt64LE(0n, gen8 + 112); fs.writeFileSync(file, bytes);
  assert.equal(Inspect.inspectStudio(file).steamRequired, false, "an app ID alone is not subsystem initialization evidence");
});

test("explicit Play prepares exact runtimes and rejects unsupported formats before catalog downloads", async t => {
  const root = temporary(t), userDataDir = path.join(root, "launcher");
  let refreshes = 0;
  const Catalog = require("../src/modules/gamemaker/runtime/official-catalog");
  t.mock.method(Official.manager, "refreshCatalog", async options => {
    refreshes++;
    const version = "2024.13.1.242", signature = "ABCDEFGHIJKLMNOPQRSTUVWX==";
    const attributes = file => `url="https://gms.yoyogames.com/${file}.zip" sparkle:version="${version}" length="3" sparkle:dsaSignature="${signature}"`;
    const body = Buffer.from(`<rss><channel><item><enclosure ${attributes("core")}><module name="mac" ${attributes("mac")}/><module name="macYYC" ${attributes("yyc")}/></enclosure></item></channel></rss>`);
    return Catalog.refreshCatalog({ ...options, fetch: async url => {
      const pin = require("../src/modules/gamemaker/runtime/official-legacy").BUILD.packages[0];
      const legacy = Buffer.from(`<rss><channel><item><enclosure sparkle:version="1.4.9999"><module name="Mac" url="${pin.publishedUrl}" length="${pin.bytes}" sparkle:dsaSignature="${pin.signature}"/></enclosure></item></channel></rss>`);
      return { status: 200, body: url.includes("update-studio.rss") ? legacy : body };
    } });
  });
  const context = { userDataDir, settings: {}, runtimeSettings: {}, runtimeId: "official-studio" };
  const earlier = entry(path.join(root, "earlier"), { wad: 16 });
  assert.ok(Module.filterRuntimeSupport(earlier, ["butterscotch", "official-studio"]).includes("official-studio"));
  assert.equal(Official.manager.resolveSelection(earlier, {}, userDataDir).version, "1.4.9999");
  assert.deepEqual(await Module.ensureRuntime(earlier, context), { managerId: "gamemaker-official", version: "1.4.9999", installOptions: {} });
  const extensions = entry(path.join(root, "extensions"), { wad: 17, extensionCount: 1 });
  await assert.rejects(Module.ensureRuntime(extensions, context), /native extensions/);
  const yyc = entry(path.join(root, "yyc"), { wad: 17, code: "empty" });
  await assert.rejects(Module.ensureRuntime(yyc, context), /YYC/);
  assert.equal(refreshes, 0);

  const legacyPath = audioArchive(root, "legacy.win", false);
  const legacy = { ...detect(legacyPath), gameId: "legacy", moduleId: "gamemaker" };
  const source = fs.readFileSync(legacyPath);
  assert.deepEqual(await Module.ensureRuntime(legacy, context), { managerId: "gamemaker-official", version: "2024.13.1.242", installOptions: {} });
  assert.equal(refreshes, 1);
  assert.deepEqual(await Module.ensureRuntime(legacy, context), { managerId: "gamemaker-official", version: "2024.13.1.242", installOptions: {} });
  assert.equal(refreshes, 1);
  legacy.runtimeData = { "official-studio": { version: "2026.0.0.23" } };
  await assert.rejects(Module.ensureRuntime(legacy, context), /AGRP/);
  assert.equal(refreshes, 1);
  assert.equal(legacy.runtimeData["official-studio"].version, "2026.0.0.23");
  assert.deepEqual(fs.readFileSync(legacyPath), source);

  earlier.runtimeData = { ...earlier.runtimeData, butterscotch: { version: BUTTERSCOTCH_BUILDS[0].version } };
  const butterContext = { ...context, runtimeId: "butterscotch" };
  const butterSelection = Butterscotch.resolveSelection(earlier, {}, userDataDir);
  assert.deepEqual(await Module.ensureRuntime(earlier, butterContext), butterSelection.ready ? null :
    { managerId: "butterscotch", version: BUTTERSCOTCH_BUILDS[0].version, installOptions: {} });
  if (butterSelection.install?.bundledExecution === "direct") {
    assert.equal(butterSelection.install.readOnly, true);
    assert.equal(fs.existsSync(Butterscotch.core.getInstallDir({ userDataDir, version: butterSelection.version })), false);
  }
  await assert.rejects(Module.ensureRuntime(extensions, butterContext), /extensions/i);
  if (process.platform === "darwin") {
    Butterscotch.core.registerLocal({ userDataDir, version: BUTTERSCOTCH_BUILDS[0].version, runtimePath: nativeBinary(root) });
    assert.equal(await Module.ensureRuntime(earlier, butterContext), null);
  }
  assert.equal(await Module.ensureRuntime(earlier, { ...context, runtimeId: "inspection" }), null);
});

function officialFixture(root, version = "2026.0.0.23") {
  const runtimeRoot = path.join(root, `runtime-${version}`);
  fs.mkdirSync(path.join(runtimeRoot, "manifest"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "receipt.json"), JSON.stringify({ version, accountToken: "do-not-expose-this" }));
  fs.writeFileSync(path.join(runtimeRoot, "manifest", "mac.json"), "manifest fixture");
  const app = path.join(runtimeRoot, "mac", "YoYo Runner.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  nativeBinary(path.join(app, "Contents/MacOS"), "Mac_Runner");
  return runtimeRoot;
}

test("official installed runtimes have exact vendor version and immutable local inventory, without asserting launch support", t => {
  const root = temporary(t);
  const runtimeRoot = officialFixture(root);
  const info = Official.inspectOfficialRuntime(runtimeRoot);
  assert.equal(info.version, "2026.0.0.23");
  assert.equal(info.versionSource, "vendor-receipt");
  assert.equal(info.runnerAvailable, true);
  assert.equal(info.launchReady, false);
  assert.deepEqual(info.runners[0].architectures, ["arm64"]);
  assert.equal(info.vendorIntegrityVerified, false);
  assert.equal(JSON.stringify(info).includes("do-not-expose-this"), false);
  const userDataDir = path.join(root, "launcher");
  Official.registerOfficialRuntime({ userDataDir, runtimeRoot });
  const state = Official.manager.getState({ userDataDir });
  assert.deepEqual(state.catalog.versions, ["2026.0.0.23"]);
  assert.equal(state.installed[0].version, "2026.0.0.23");
  assert.equal(OfficialInstaller.resolveBuild({ userDataDir, version: "1.4.9999" }).version, "1.4.9999");
  assert.equal(state.installed[0].launchReady, false);
  assert.throws(() => Official.registerOfficialRuntime({ userDataDir, runtimeRoot }), /already registered/);
  fs.appendFileSync(info.runners[0].executablePath, "replaced");
  assert.equal(Official.manager.core.resolveInstalled({ userDataDir, version: "2026.0.0.23" }), null);
  assert.equal(Official.manager.getState({ userDataDir }).installed[0].status, "damaged");
  assert.deepEqual(Official.manager.getState({ userDataDir }).catalog.versions, ["2026.0.0.23"]);
  Official.manager.uninstallRuntime({ userDataDir, version: "2026.0.0.23" });
  assert.deepEqual(Official.manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(fs.existsSync(runtimeRoot), true);
});

test("official inventory rejects conflicting build IDs, missing receipts/manifests and ZIP input", async t => {
  const root = temporary(t);
  const runtimeRoot = officialFixture(root);
  fs.writeFileSync(path.join(runtimeRoot, "receipt.json"), JSON.stringify({ version: "2026.0.0.24" }));
  assert.throws(() => Official.inspectOfficialRuntime(runtimeRoot), /disagree/);
  fs.rmSync(path.join(runtimeRoot, "receipt.json"));
  assert.throws(() => Official.inspectOfficialRuntime(runtimeRoot));
  const zip = path.join(root, "runtime.zip"); fs.writeFileSync(zip, "zip");
  assert.throws(() => Official.inspectOfficialRuntime(zip), /vendor ZIPs/);
  await assert.rejects(Official.manager.installRuntime({ userDataDir: path.join(root, "launcher"), version: "latest" }), /exact official/);
});

test("public official downloads require a reviewed exact version and reject changed package bytes", async t => {
  const root = temporary(t);
  let requests = 0;
  const download = async (url, destination) => {
    requests += 1;
    assert.equal(new URL(url).hostname, "gms.yoyogames.com");
    fs.writeFileSync(destination, "wrong-package");
  };
  await assert.rejects(OfficialPackages.downloadPublicPackages({ userDataDir: root, version: "latest", download }), /catalog/);
  assert.equal(requests, 0);
  await assert.rejects(OfficialPackages.downloadPublicPackages({ userDataDir: root, version: "2026.0.0.23", download }), /SHA-256/);
  assert.equal(requests, 1);
  assert.equal(OfficialPackages.cachedPackages(root, "2026.0.0.23"), null);
  const packages = path.join(root, "runtimes/gamemaker-official/packages");
  assert.deepEqual(fs.readdirSync(packages), []);
  const build = OfficialPackages.CATALOG[0];
  assert.equal(build.launchReady, false);
  assert.equal(build.packageFormat, "encrypted-vendor-zip");
  assert.deepEqual(build.packages.map(item => item.module), ["core", "mac"]);
});

test("official native installer refuses unpinned bootstrap bytes before any native tool executes", async t => {
  const root = temporary(t);
  let downloads = 0, executions = 0;
  await assert.rejects(OfficialInstaller.installOfficialVersion({ userDataDir: root, version: "2026.0.0.23", dependencies: {
    downloadToFile: async (url, output) => { downloads++; assert.equal(url, OfficialInstaller.BOOTSTRAP.url); fs.writeFileSync(output, "changed mutable vendor bootstrap"); },
    runProcess: async () => { executions++; }
  } }), /SHA-256/);
  assert.equal(downloads, 1); assert.equal(executions, 0);
  assert.equal(fs.existsSync(path.join(root, "runtimes/gamemaker-official/2026.0.0.23")), false);
  const feed = OfficialInstaller.pinnedFeed("http://127.0.0.1:12345");
  assert.equal(feed.includes("https://"), false);
  assert.equal(feed.includes("Version 2026.0.0.23"), true);
  assert.equal((feed.match(/<module /g) || []).length, 3);
  assert.deepEqual(OfficialInstaller.BUILD.packages.map(item => item.module), ["core", "base-module-osx-arm64", "mac", "macYYC"]);
});

test("vendor empty manifests are inventory evidence only with complete Mac module receipt and disk image", t => {
  const root = temporary(t), runtimeRoot = officialFixture(root);
  fs.rmSync(path.join(runtimeRoot, "manifest/mac.json"));
  assert.throws(() => Official.inspectOfficialRuntime(runtimeRoot), /missing its Mac module metadata/);
  fs.writeFileSync(path.join(runtimeRoot, "receipt.json"), JSON.stringify({ base: "vendor-core-id", mac: "vendor-mac-id" }));
  fs.writeFileSync(path.join(runtimeRoot, "mac/Mac-YoYoRunner-Release.dmg"), "disk image inventory fixture");
  const info = Official.inspectOfficialRuntime(runtimeRoot);
  assert.equal(info.versionSource, "runtime-folder-name");
  assert.equal(info.manifestCount, 0);
  assert.equal(info.vendorIntegrityVerified, false);
  assert.equal(info.launchReady, false);
  assert.equal(info.diskImages.length, 1);
});

test("official runner selection keeps compatible explicit builds and gates VM generations before execution", async t => {
  const root = temporary(t), context = { userDataDir: path.join(root, "launcher"), runtimeSettings: {} };
  const game = entry(root, { wad: 17 });
  assert.deepEqual(Module.filterRuntimeSupport(game, ["butterscotch", "official-studio", "inspection"]), ["butterscotch", "official-studio", "inspection"]);
  assert.equal(Official.manager.resolveSelection({ runtimeData: { "gamemaker-official": { version: "2.2.5.378" } } }, {}, root).version, "2.2.5.378");
  const overridden = Official.manager.resolveSelection({ runtimeData: {
    "official-studio": { version: "2.2.5.378" }, "gamemaker-official": { version: "2026.0.0.23" }
  } }, { runtimes: { "gamemaker-official": { defaultVersion: "2026.0.0.23" } } }, root);
  assert.equal(overridden.version, "2.2.5.378");
  assert.equal(overridden.ready, false);
  assert.equal(Official.manager.resolveSelection({ runtimeData: {
    "official-studio": { version: null }, "gamemaker-official": { version: "2.2.5.378" }
  } }, { runtimes: { "gamemaker-official": { defaultVersion: "2026.0.0.23" } } }, root).version, "2026.0.0.23");
  assert.equal(Official.manager.resolveSelection({}, { runtimes: { "gamemaker-official": { defaultVersion: "unavailable-build" } } }, root).version, "2026.0.0.23");
  await assert.rejects(OfficialLaunch.launchOfficial(game, context, {}), /installed official native runner/);
  await assert.rejects(OfficialLaunch.launchOfficial(game, context, { reason: "exact requested build missing" }), /exact requested build missing/);
  writeForm(root, { wad: 17, code: "empty" }); assert.throws(() => OfficialLaunch.preflight(game.moduleData.dataPath), /YYC/);
  writeForm(root, { wad: 16 });
  assert.equal(OfficialLaunch.preflight(game.moduleData.dataPath, "1.4.9999").wadVersion, 16);
  assert.equal(OfficialLaunch.preflight(game.moduleData.dataPath, "2.2.5.378").wadVersion, 16);
  assert.throws(() => OfficialLaunch.preflight(game.moduleData.dataPath, "2.3.7.606"), /WAD 16/);
  writeForm(root, { wad: 17, extensionCount: 1 }); assert.throws(() => OfficialLaunch.preflight(game.moduleData.dataPath), /native extensions/);
  writeForm(root, { wad: 17 });
  context.runtimeSettings.softwareOpenGLFallback = "enabled";
  await assert.rejects(OfficialLaunch.launchOfficial(game, context, { version: "2026.0.0.23", install: { launchReady: true,
    binarySha256: "0".repeat(64) } }), /checksum/);
});

test("official install stores the runtime version key used by the inspector and removes its old manager alias", async t => {
  const root = temporary(t), game = entry(root, { wad: 17 });
  game.runtimeData = { "gamemaker-official": { version: "2.2.5.378" }, butterscotch: { version: "keep" } };
  t.mock.method(Official.manager, "installRuntime", async options => ({ version: options.version }));
  await Module.actions.installOfficialRuntime(game, { version: "2026.0.0.23" }, { userDataDir: root, settings: {} });
  assert.equal(game.runtimeData["official-studio"].version, "2026.0.0.23");
  assert.equal(Object.hasOwn(game.runtimeData, "gamemaker-official"), false);
  assert.equal(game.runtimeData.butterscotch.version, "keep");
  assert.equal(Official.manager.resolveSelection(game, {}, root).version, game.runtimeData["official-studio"].version);
});

test("official import and per-game staging preserve vendor bytes, verify whole bundles and isolate saves with owned aliases", async t => {
  const root = temporary(t), version = "2024.14.4.268";
  const runtimeRoot = officialFixture(root, version), userDataDir = path.join(root, "launcher");
  const sourceApp = path.join(runtimeRoot, "mac/YoYo Runner.app");
  fs.writeFileSync(path.join(sourceApp, "Contents/Info.plist"), "<plist><dict><key>CFBundleExecutable</key><string>Mac_Runner</string><key>CFBundleIdentifier</key><string>com.yoyogames.macyoyorunner</string></dict></plist>");
  const before = OfficialLaunch.hashRunnerTree(sourceApp);
  const operations = [];
  const runProcess = async (executable, args) => {
    operations.push({ executable, args });
    if (executable === "/usr/bin/ditto") fs.cpSync(args[0], args[1], { recursive: true });
    if (executable === "/usr/libexec/PlistBuddy") fs.writeFileSync(args[2], "<plist><dict><key>CFBundleExecutable</key><string>Mac_Runner</string><key>CFBundleIdentifier</key><string>" + args[1].split(" ").at(-1) + "</string></dict></plist>");
    return { stdout: "", stderr: "" };
  };
  const installed = await Official.importOfficialRuntime({ userDataDir, runtimeRoot, dependencies: { runProcess } });
  assert.equal(installed.version, version); assert.equal(installed.launchReady, true);
  assert.equal(installed.gameplayQualified, false); assert.equal(installed.artifactsPinned, false);
  const game = entry(path.join(root, "game"), { wad: 17 });
  const context = { userDataDir, runtimeSettings: {}, spawnDetachedChecked: (executable, args, options) => ({ executable, args, options }) };
  const selection = Official.manager.resolveSelection({ runtimeData: { "gamemaker-official": { version } } }, {}, userDataDir);
  const launched = await OfficialLaunch.launchOfficial(game, context, selection, { runProcess, homeDir: path.join(root, "home") });
  assert.deepEqual(launched.args, ["-game", game.moduleData.dataPath]);
  assert.equal(launched.options.cwd, path.dirname(game.moduleData.dataPath));
  assert.equal(launched.executable.startsWith(path.join(userDataDir, "games/tiny-game")), true);
  assert.equal(OfficialLaunch.hashRunnerTree(sourceApp), before);
  assert.equal(operations.filter(item => item.executable === "/usr/bin/codesign").length, 1);
  const locations = OfficialLaunch.privateSaveLocations(game, context, { homeDir: path.join(root, "home") });
  assert.equal(fs.readlinkSync(locations.alias), game.defaultSaveDir);
  assert.equal(game.defaultSaveDir.startsWith(path.join(userDataDir, "games/tiny-game")), true);
  await OfficialLaunch.launchOfficial(game, context, selection, { runProcess, homeDir: path.join(root, "home") });
  assert.equal(operations.filter(item => item.executable === "/usr/bin/codesign").length, 1);
  fs.writeFileSync(path.join(installed.runnerAppPath, "Contents", "injected-resource"), "changed resource");
  assert.equal(Official.manager.core.resolveInstalled({ userDataDir, version }), null);
  OfficialLaunch.cleanupGameData(game, context, { homeDir: path.join(root, "home") });
  assert.equal(fs.existsSync(locations.alias), false);
  assert.equal(fs.existsSync(game.defaultSaveDir), true);
  assert.equal(fs.existsSync(runtimeRoot), true);
});

test("official save aliases refuse preexisting user files and preserve unrelated symlinks during cleanup", t => {
  const root = temporary(t), game = entry(root, { wad: 17 });
  const context = { userDataDir: path.join(root, "launcher") };
  const options = { homeDir: path.join(root, "home") };
  const locations = OfficialLaunch.privateSaveLocations(game, context, options);
  fs.mkdirSync(locations.support, { recursive: true });
  fs.mkdirSync(locations.alias);
  fs.writeFileSync(path.join(locations.alias, "user-save"), "preserve");
  assert.throws(() => OfficialLaunch.ensurePrivateSaves(locations), /belongs to another/);
  OfficialLaunch.cleanupGameData(game, context, options);
  assert.equal(fs.readFileSync(path.join(locations.alias, "user-save"), "utf8"), "preserve");
  fs.rmSync(locations.alias, { recursive: true });
  fs.symlinkSync(root, locations.alias);
  assert.throws(() => OfficialLaunch.ensurePrivateSaves(locations), /belongs to another/);
  OfficialLaunch.cleanupGameData(game, context, options);
  assert.equal(fs.readlinkSync(locations.alias), root);
});
