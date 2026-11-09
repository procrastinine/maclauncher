const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Preparation = require("../src/modules/kirikiri/prepare");

test("KAG3 resources come only from the krkrsdl2 package or a verified resource folder", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kag3-resources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(Preparation.needsResources({ moduleData: { archivePath: "data.xp3", kagVersion: "3.0" } }), true);
  assert.equal(Preparation.needsResources({ moduleData: {} }), false);
  assert.equal(Preparation.resources(root), null);
  await assert.rejects(Preparation.ensureResources({ userDataDir: root }), /no KAG3 compatibility resources/);
  assert.equal(fs.existsSync(path.join(root, "runtimes")), false);
});
