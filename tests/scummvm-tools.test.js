const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Tools = require("../src/modules/scummvm/tools");
const { createManager, DEFAULT_ENTRY } = require("../src/modules/scummvm/runtime/tools-manager");
const Module = require("../src/modules/scummvm/main");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scummvm-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function stk(name = "INTRO.TOT") {
  const data = Buffer.alloc(28); data.writeUInt16LE(1); data.write(name, 2, 13, "latin1");
  data.writeUInt32LE(4, 15); data.writeUInt32LE(24, 19); data.write("data", 24); return data;
}
function pak(name = "INTRO.EMC") {
  const first = 4 + Buffer.byteLength(name) + 1 + 4, data = Buffer.alloc(first + 4);
  data.writeUInt32LE(first); data.write(name, 4, "latin1"); data.write("data", first); return data;
}
test("ScummVM tools reject archive traversal and malformed tables before invoking downloaded tools", t => {
  const root = temporary(t), gob = path.join(root, "intro.stk"), kyra = path.join(root, "intro.pak");
  fs.writeFileSync(gob, stk()); assert.equal(Tools.validateArchive(gob, "extract_gob_stk"), 1);
  fs.writeFileSync(kyra, pak()); assert.equal(Tools.validateArchive(kyra, "extract_kyra"), 1);
  fs.writeFileSync(gob, stk("../escape")); assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /unsafe/);
  fs.writeFileSync(kyra, pak("..\\escape")); assert.throws(() => Tools.validateArchive(kyra, "extract_kyra"), /unsafe/);
  const invalid = stk(); invalid.writeUInt32LE(1000, 19); fs.writeFileSync(gob, invalid);
  assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /invalid/);
  const compressed = Buffer.concat([stk(), Buffer.alloc(4)]); compressed[23] = 1; compressed.writeUInt32LE(8, 15); compressed.writeUInt32LE(0xffffffff, 24);
  fs.writeFileSync(gob, compressed); assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /size is invalid/);
});
test("ScummVM detects a Gob intro script packed inside the intro archive", t => {
  const root = temporary(t); fs.writeFileSync(path.join(root, "INTRO.STK"), stk());
  const detected = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.sourceKind, "Gob"); assert.equal(detected.moduleData.archiveToolCount, 1);
  fs.writeFileSync(path.join(root, "INTRO.STK"), stk("OTHER.TOT"));
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
});
test("ScummVM tools remain offline until refresh and use an independent selected version", async t => {
  const root = temporary(t); let count = 0;
  const manager = createManager({ discoverCatalog: async () => { count++; return [DEFAULT_ENTRY, { ...DEFAULT_ENTRY, version: "2.7.0" }]; } });
  assert.equal(manager.resolveSelection({}, {}, root).version, "2.9.0"); assert.equal(count, 0);
  await manager.refreshCatalog({ userDataDir: root, force: true });
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.versions, ["2.9.0", "2.7.0"]);
  const entry = { runtimeData: { scummvm: { version: "2026.4.0" }, "scummvm-tools": { version: "2.7.0" } } };
  assert.equal(manager.resolveSelection(entry, {}, root).version, "2.7.0");
});
test("ScummVM extraction writes only private output and preserves earlier output after failure", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "INTRO.STK"), stk());
  const entry = { gameId: "fixture", gamePath: source, contentRootDir: source, moduleData: {} }, context = { userDataDir: path.join(root, "profile"), settings: {} };
  const dependencies = { ensureTools: async () => ({ version: "2.9.0", install: { executablePath: path.join(root, "scummvm-tools-cli"), needsRosetta: false } }),
    runCommand: async (_cmd, args) => fs.writeFileSync(path.join(args[args.indexOf("-o") + 1], "INTRO.TOT"), "extracted script") };
  const result = await Tools.extractArchives(entry, {}, context, dependencies);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "INTRO.STK", "INTRO.TOT"), "utf8"), "extracted script");
  assert.deepEqual(fs.readdirSync(source), ["INTRO.STK"]);
  assert.throws(() => Tools.revealExtraction({ ...entry, moduleData: { extractedRoot: source } }, context), /first/);
  await assert.rejects(Tools.extractArchives(entry, {}, context, { ...dependencies, runCommand: async () => { throw new Error("tool failure"); } }), /tool failure/);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "INTRO.STK", "INTRO.TOT"), "utf8"), "extracted script");
});
test("ScummVM extraction includes every supported archive in a game folder", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  for (let index = 0; index < 65; index++) fs.writeFileSync(path.join(source, `${index}.STK`), stk());
  const result = await Tools.extractArchives({ gameId: "fixture", gamePath: source }, {}, {
    userDataDir: path.join(root, "profile"), settings: {}
  }, {
    ensureTools: async () => ({ version: "2.9.0", install: { executablePath: path.join(root, "scummvm-tools-cli") } }),
    runCommand: async (_command, args) => fs.writeFileSync(path.join(args[args.indexOf("-o") + 1], "INTRO.TOT"), "script")
  });
  assert.equal(result.archiveCount, 65); assert.equal(result.archives.length, 65);
  for (const name of result.archives) assert.equal(fs.readFileSync(path.join(result.outputRoot, name, "INTRO.TOT"), "utf8"), "script");
});
test("ScummVM archive extraction obtains consent before downloading missing tools", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "INTRO.STK"), stk());
  let consent = 0;
  await assert.rejects(Tools.extractArchives({ gameId: "fixture", gamePath: source }, {}, {
    userDataDir: path.join(root, "profile"), settings: {}, confirmRuntimeInstall: async plan => { consent++; assert.equal(plan.managerId, "scummvm-tools"); return false; }
  }), { name: "AbortError" });
  assert.equal(consent, 1); assert.equal(fs.existsSync(path.join(root, "profile", "runtimes")), false);
});
