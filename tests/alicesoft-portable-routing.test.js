const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildManagedRuntime } = require("../src/modules/alicesoft/build");
const PortableSystem3 = require("../src/modules/alicesoft/system3-portable");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");

test("portable System3 versions cannot register a legacy dependency build", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-system3-routing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "userData");
  const manager = createPinnedNativeManager({ id: "system3", label: "System3", catalog: [{
    version: PortableSystem3.VERSION, upstreamRevision: PortableSystem3.REVISION
  }] });
  let toolCalls = 0;
  let compilerCalls = 0;
  const dependencies = {
    findBuildTool: () => { toolCalls++; throw new Error("A legacy tool must not run."); },
    runBuildCommand: () => { compilerCalls++; throw new Error("A legacy compiler must not run."); }
  };
  for (const version of [PortableSystem3.VERSION, "v" + PortableSystem3.VERSION, " " + PortableSystem3.VERSION + " "]) {
    await assert.rejects(buildManagedRuntime({ manager, version, userDataDir,
      sourceDir: path.join(root, "missing-source"), dependencies }), /portable dependency recipe and its pinned source archives/);
  }
  assert.equal(toolCalls, 0);
  assert.equal(compilerCalls, 0);
  assert.equal(fs.existsSync(userDataDir), false);
});
