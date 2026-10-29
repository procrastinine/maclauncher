const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Tools = require("../src/modules/shared/decompilation/native");
const Manager = require("../src/modules/shared/decompilation/runtime/native-manager");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-tools-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "game.exe"); fs.writeFileSync(binary, "MZ-original-native-input");
  const entry = { gameId: "native-input", engine: "generic-app", gamePath: binary, moduleData: {} };
  const context = { userDataDir: path.join(root, "profile"), settings: {} };
  const install = { version: "2.5.0", installDir: path.join(root, "tool"), executablePath: path.join(root, "tool/bin/rizin") };
  const manager = { id: "native-inspector", label: "Rizin / Ghidra", resolveSelection: () => ({ ready: true, version: install.version, install }) };
  return { root, entry, context, manager };
}
test("native inspection is added without changing playback hooks or existing actions", () => {
  const launchRuntime = () => {}, inspectGame = () => {};
  const original = { id: "native", manifest: { ui: { actions: [{ id: "inspectGame" }] } }, actions: { inspectGame }, launchRuntime };
  const extended = Tools.withTools(original);
  assert.equal(extended.launchRuntime, launchRuntime);
  assert.equal(extended.actions.inspectGame, inspectGame);
  assert.equal(extended.manifest.ui.actions.at(-1).id, "inspectNativeBinary");
  assert.equal(original.manifest.ui.actions.length, 1);
  assert.equal(Manager.ui.groupId, "tools");
});
test("declined acquisition and plain scripts never download or start a tool", async t => {
  const { root, entry, context, manager } = setup(t);
  manager.resolveSelection = () => ({ ready: false });
  manager.refreshCatalog = () => assert.fail("No discovery after cancellation");
  context.confirmRuntimeInstall = async () => false;
  await assert.rejects(Tools.inspect(entry, {}, context, { manager }), { code: "ABORT_ERR" });
  entry.gamePath = path.join(root, "script.sh"); fs.writeFileSync(entry.gamePath, "#!/bin/sh\necho source");
  context.confirmRuntimeInstall = () => assert.fail("Scripts have readable source");
  await assert.rejects(Tools.inspect(entry, {}, context, { manager }), /Plain scripts/);
});
test("native exports use read-only parsing, only trusted plugins, and retain previous output on failure", async t => {
  const { entry, context, manager } = setup(t);
  const dependencies = { manager, withRuntimeUse: async (_ids, work) => work({ bind: async () => {} }),
    runCommand: async (_file, args, options) => {
      assert.ok(args.includes("-NN")); assert.ok(args.includes("-x")); assert.ok(!args.includes("-w")); assert.ok(!args.includes("-d"));
      assert.match(args[args.indexOf("-c") + 1], /pdg @@F/);
      assert.equal(args.at(-1), entry.gamePath);
      fs.writeFileSync(path.join(options.cwd, "functions.json"), JSON.stringify([{ name: "entry0" }]));
      fs.writeFileSync(path.join(options.cwd, "decompiled.c"), "int entry0(void) { return 42; }");
    } };
  const result = await Tools.inspect(entry, {}, context, dependencies);
  assert.equal(result.functionCount, 1); assert.ok(result.pseudocodeBytes > 0);
  await assert.rejects(Tools.inspect(entry, {}, context, { ...dependencies,
    runCommand: async () => { throw new Error("parser failed"); } }), /parser failed/);
  assert.match(fs.readFileSync(path.join(result.outputRoot, "decompiled.c"), "utf8"), /return 42/);
  assert.equal(fs.readFileSync(entry.gamePath, "utf8"), "MZ-original-native-input");
});
