const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Registry = require("../src/modules/registry");
const { peFixture, versionResource } = require("./helpers/pe-fixture");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-selected-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
function carrier(kind, overrides = {}) {
  return peFixture({ version: versionResource({ strings: {
    OriginalFilename: kind === "nw" ? "nw.exe" : "electron.exe",
    ProductName: kind === "nw" ? "nwjs" : "Electron",
    FileDescription: kind === "nw" ? "nwjs" : "Electron", ...overrides
  } }) }).bytes;
}
function appExport(content) {
  write(path.join(content, "package.json"), JSON.stringify({ main: "index.html", name: "authored-game" }));
  write(path.join(content, "index.html"), "<html><canvas></canvas></html>");
}

test("selected unrelated files cannot inherit loose neighboring HTML", async t => {
  for (const [filename, bytes] of [
    ["Unrelated.exe", carrier("nw", { OriginalFilename: "editor.exe" })],
    ["False.exe", Buffer.from("MZ nw.exe nwjs Electron electron.exe")],
    ["Notes.txt", "some text"], ["Library.js", "// helper"]
  ]) {
    const root = fixture(t), input = path.join(root, filename);
    write(input, bytes); appExport(root);
    for (const report of [Registry.explainDetection(input), await Registry.explainDetectionAsync(input)]) {
      assert.equal(report.detected, null);
      assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
    }
    assert.deepEqual(fs.readFileSync(input), Buffer.from(bytes));
  }
});

test("real NW and Electron carriers identify their contained unpacked web export", async t => {
  for (const [kind, contentName] of [["nw", ""], ["nw", "package.nw"], ["nw", "app.nw"], ["electron", "resources/app"]]) {
    const root = fixture(t), input = path.join(root, "Creator Game.exe"), content = path.join(root, contentName);
    const original = carrier(kind); write(input, original); appExport(content);
    for (const report of [Registry.explainDetection(input), await Registry.explainDetectionAsync(input)]) {
      assert.equal(report.error, undefined, report.error?.message);
      assert.equal(report.selectedModuleId, "web");
      assert.equal(report.detected.contentRootDir, content);
      assert.equal(report.detected.indexHtml, path.join(content, "index.html"));
      assert.ok(report.detected.detectionEvidence.some(item => item.path === input && item.format.includes("PE carrier")));
    }
    assert.deepEqual(fs.readFileSync(input), original);
  }
});

test("carrier metadata does not allow missing or escaping package entries", async t => {
  const outside = fixture(t); appExport(outside);
  for (const entry of [null, "missing.html", "https://example.invalid/game.html", "../outside.html", "escape.html"]) {
    const root = fixture(t), input = path.join(root, "Game.exe");
    write(input, carrier("nw")); write(path.join(root, "index.html"), "<html>incidental page</html>");
    if (entry !== null) write(path.join(root, "package.json"), JSON.stringify({ main: entry }));
    if (entry === "escape.html") fs.symlinkSync(path.join(outside, "index.html"), path.join(root, entry));
    const report = await Registry.explainDetectionAsync(input);
    assert.equal(report.detected, null);
    assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
  }
  const root = fixture(t), input = path.join(root, "Game.exe");
  write(input, carrier("electron")); fs.mkdirSync(path.join(root, "resources"));
  fs.symlinkSync(outside, path.join(root, "resources/app"));
  assert.equal((await Registry.explainDetectionAsync(input)).detected, null);

  const distRoot = fixture(t), distInput = path.join(distRoot, "Game.exe");
  write(distInput, carrier("nw"));
  write(path.join(distRoot, "package.json"), JSON.stringify({ main: "main.js" }));
  write(path.join(distRoot, "main.js"), "// contained app entry");
  fs.mkdirSync(path.join(distRoot, "dist"));
  fs.symlinkSync(path.join(outside, "index.html"), path.join(distRoot, "dist/index.html"));
  assert.equal((await Registry.explainDetectionAsync(distInput)).detected, null);
  assert.equal((await Registry.explainDetectionAsync(distRoot)).detected, null);
});

test("direct HTML and folder imports retain the selected HTML entry", async t => {
  const root = fixture(t); appExport(root);
  const chosen = path.join(root, "Chosen.htm"); write(chosen, "<html>chosen game</html>");
  assert.equal((await Registry.detectGameAsync(chosen)).indexHtml, chosen);
  assert.equal((await Registry.detectGameAsync(root)).indexHtml, path.join(root, "index.html"));
});
