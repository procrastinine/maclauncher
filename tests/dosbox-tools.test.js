const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Tools = require("../src/modules/dosbox/tools");
const Native = require("../src/modules/shared/decompilation/native");

function setup(t, extension, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dos-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "original game"), executable = path.join(source, "GAME." + extension);
  fs.mkdirSync(source); fs.writeFileSync(executable, bytes);
  const entry = { gameId: "dos-input", engine: "dosbox", gamePath: source, contentRootDir: source, moduleData: { executablePath: executable, format: extension.toLowerCase() } };
  const context = { userDataDir: path.join(root, "profile"), settings: {} };
  const install = { version: "2.5.0", installDir: path.join(root, "tool"), executablePath: path.join(root, "tool/bin/rizin") };
  const manager = { id: "native-inspector", resolveSelection: () => ({ ready: true, version: install.version, install }) };
  return { root, source, executable, entry, context, manager };
}
function mz() {
  const bytes = Buffer.alloc(80); bytes.write("MZ"); bytes.writeUInt16LE(80, 2); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(4, 8);
  bytes.set([0xb8, 0, 0x4c, 0xcd, 0x21, 0xc3], 64); return bytes;
}
const withRuntimeUse = async (_ids, work) => work({ bind: async () => {} });
function exportResult(options) {
  fs.writeFileSync(path.join(options.cwd, "functions.json"), JSON.stringify([{ name: "entry0", bits: 16 }]));
  fs.writeFileSync(path.join(options.cwd, "decompiled.c"), "void entry0(void) { return; }\n");
}

test("DOS inspection exports MZ fields and file names offline without changing original data", t => {
  const bytes = mz(), { entry, context, source, executable } = setup(t, "EXE", bytes);
  fs.writeFileSync(path.join(source, "DATA.DAT"), "original assets");
  context.confirmRuntimeInstall = () => assert.fail("Header inspection stays offline");
  const result = Tools.inspectExecutable(entry, {}, context);
  assert.equal(result.format, "exe"); assert.equal(result.bits, 16); assert.equal(result.headerBytes, 64);
  assert.equal(result.fileCount, 2); assert.equal(result.bytes, bytes.length);
  assert.deepEqual(result.files, ["DATA.DAT", "GAME.EXE"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.outputRoot, "inspection.json"))).initialIP, 0);
  assert.deepEqual(fs.readFileSync(executable), bytes);
  assert.equal(entry.moduleData.nativeInspectionRoot, result.outputRoot);
});

test("COM decompilation selects raw real-mode x86 at origin 100h through the existing inspector", async t => {
  const bytes = Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21, 0xc3]);
  const { entry, context, manager, executable } = setup(t, "COM", bytes);
  const result = await Tools.decompile(entry, {}, context, { manager, withRuntimeUse, runCommand: async (_file, args, options) => {
    assert.ok(args.includes("-NN")); assert.ok(args.includes("-x")); assert.ok(args.includes("-n"));
    assert.equal(args[args.indexOf("-a") + 1], "x86"); assert.equal(args[args.indexOf("-b") + 1], "16");
    assert.equal(args[args.indexOf("-m") + 1], "256"); assert.equal(args[args.indexOf("-s") + 1], "256");
    assert.ok(args.includes("analysis.in=io.maps")); assert.ok(args.includes("ghidra.lang=x86:LE:16:Real Mode"));
    assert.match(args[args.indexOf("-c") + 1], /^af @ 256;aa;/);
    assert.ok(!args.includes("-w") && !args.includes("-d")); assert.equal(args.at(-1), executable);
    exportResult(options);
  } });
  assert.equal(result.functionCount, 1); assert.equal(result.analysisProfile.entryAddress, 256);
  assert.deepEqual(fs.readFileSync(executable), bytes); assert.equal(entry.moduleData.nativeInspectionRoot, result.outputRoot);
});

test("MZ decompilation retains binary-parser architecture discovery and honors install cancellation", async t => {
  const { entry, context, manager } = setup(t, "EXE", mz());
  await Tools.decompile(entry, {}, context, { manager, withRuntimeUse, runCommand: async (_file, args, options) => {
    assert.ok(!args.includes("-n")); assert.ok(!args.includes("ghidra.lang=x86:LE:16:Real Mode")); exportResult(options);
  } });
  manager.resolveSelection = () => ({ ready: false, version: "2.5.0" });
  manager.installRuntime = () => assert.fail("Declined downloads do not install");
  context.confirmRuntimeInstall = async () => false;
  await assert.rejects(Tools.decompile(entry, {}, context, { manager }), { code: "ABORT_ERR" });
});

test("batch actions preserve readable script bytes without invoking a decompiler", async t => {
  const bytes = Buffer.from([64, 101, 99, 104, 111, 32, 111, 102, 102, 13, 10, 130, 13, 10]);
  const { entry, context } = setup(t, "BAT", bytes);
  context.confirmRuntimeInstall = () => assert.fail("Batch source requires no download");
  const result = await Tools.decompile(entry, {}, context, { manager: { resolveSelection: () => assert.fail("Batch source requires no inspector") } });
  assert.deepEqual(fs.readFileSync(result.sourceFile), bytes);
  assert.match(result.scriptPreview, /\\x82/); assert.equal(result.functionCount, undefined);
  assert.match(result.description, /batch source/);
});

test("stale DOS metadata cannot admit a Windows executable or a file outside the imported folder", async t => {
  const { root, executable, entry, context } = setup(t, "EXE", mz());
  const bytes = Buffer.alloc(100); mz().copy(bytes); bytes.writeUInt16LE(100, 2); bytes.writeUInt32LE(64, 60); bytes.write("PE\0\0", 64);
  fs.writeFileSync(executable, bytes);
  await assert.rejects(Tools.decompile(entry, {}, context), /missing or invalid/);
  const outside = path.join(root, "outside.com"); fs.writeFileSync(outside, Buffer.from([0xc3])); entry.moduleData.executablePath = outside;
  assert.throws(() => Tools.inspectExecutable(entry, {}, context), /inside the imported folder/);
});

test("Show export uses the UI shell and rejects an export outside the game's private module data", t => {
  const { root, entry, context } = setup(t, "COM", Buffer.from([0xc3]));
  const result = Tools.inspectExecutable(entry, {}, context), shown = [];
  context.ui = { shell: { showItemInFolder: file => shown.push(file) } };
  assert.deepEqual(Tools.revealExport(entry, {}, context), { outputRoot: result.outputRoot }); assert.deepEqual(shown, [result.outputRoot]);
  entry.moduleData.nativeInspectionRoot = root;
  assert.throws(() => Tools.revealExport(entry, {}, context), /No DOS program export/);
});

test("raw analysis profile values cannot inject Rizin commands", async t => {
  const { entry, context, manager } = setup(t, "COM", Buffer.from([0xc3]));
  await assert.rejects(Native.inspect(entry, {}, context, { moduleId: "dosbox", manager, resolveInput: () => entry.moduleData.executablePath,
    analysisProfile: { raw: true, architecture: "x86", bits: 16, loadAddress: 256, entryAddress: "256;!touch file", language: "x86:LE:16:Real Mode" } }), /Invalid raw binary analysis/);
});
