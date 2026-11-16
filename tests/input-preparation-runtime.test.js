const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLauncher } = require("../src/core/launcher");

test("an import names its requested runtime to the installer reader", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "input-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "setup.exe"); fs.writeFileSync(input, "fixture");
  const seen = [];
  const launcher = createLauncher({ userDataDir: path.join(root, "profile"), logger: {}, inputPreparation: async (file, options) => {
    seen.push(options.runtimeId); throw Object.assign(new Error("stop after the reader"), { code: "INSTALLER_FIXTURE" }); } });
  await assert.rejects(launcher.resolveEntry(input, { runtimeId: "sikarugir", persist: false }), /stop after the reader/);
  assert.deepEqual(seen, ["sikarugir"]);
});
