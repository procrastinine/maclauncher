const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Construct = require("../src/modules/construct/main");

test("Construct Electron accepts a prepared extracted index outside the original game folder", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "construct-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, "original"), extracted = path.join(root, "userData", "extracted");
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });
  const index = path.join(extracted, "index.html");
  fs.writeFileSync(index, "<html>Released game assets</html>");
  const entry = { gamePath: game, contentRootDir: extracted, indexHtml: index,
    moduleData: { packagedType: "nwjs", extractedReady: true, extractedRoot: extracted } };
  assert.equal(Construct.canLaunchRuntime("electron", entry), true);
  assert.deepEqual(Construct.filterRuntimeSupport(entry, ["electron", "nwjs"]), ["electron", "nwjs"]);
  for (const invalid of [
    { ...entry, moduleData: { ...entry.moduleData, extractedReady: false } },
    { ...entry, contentRootDir: game },
    { ...entry, indexHtml: path.join(extracted, "missing.html") },
    { ...entry, moduleData: { ...entry.moduleData, extractedRoot: game } }
  ]) assert.equal(Construct.canLaunchRuntime("electron", invalid), false);
  fs.symlinkSync(index, path.join(game, "outside.html"));
  assert.equal(Construct.canLaunchRuntime("electron", { gamePath: game, indexHtml: path.join(game, "outside.html") }), false);
});
