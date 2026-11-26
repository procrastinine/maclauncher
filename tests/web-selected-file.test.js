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

test("a renamed launcher is recognized by its Chromium app distribution", async t => {
  // A renamed Electron or NW.js launcher keeps none of the standard PE identities.
  const renamed = () => peFixture({ version: versionResource({ strings: {
    ProductName: "authored-game", FileDescription: "authored-game", CompanyName: "Author"
  } }) }).bytes;
  // The payload files every Electron and NW.js Windows distribution ships beside
  // its launcher: ICU data and a V8 snapshot, whose file name depends on the
  // Chromium version. A native game executable folder does not contain them.
  const chromiumPayload = (root, snapshot = "snapshot_blob.bin") => {
    write(path.join(root, "icudtl.dat"), "icu data");
    write(path.join(root, snapshot), "snapshot");
  };

  for (const snapshot of ["snapshot_blob.bin", "v8_context_snapshot.bin"]) {
    const detectedRoot = fixture(t), detectedInput = path.join(detectedRoot, "Creator Game.exe");
    write(detectedInput, renamed()); chromiumPayload(detectedRoot, snapshot);
    appExport(path.join(detectedRoot, "resources", "app"));
    for (const report of [Registry.explainDetection(detectedInput), await Registry.explainDetectionAsync(detectedInput)]) {
      assert.equal(report.error, undefined, report.error?.message);
      assert.equal(report.selectedModuleId, "web", snapshot);
      assert.equal(report.detected.contentRootDir, path.join(detectedRoot, "resources", "app"));
      assert.equal(report.detected.indexHtml, path.join(detectedRoot, "resources", "app", "index.html"));
      assert.ok(report.detected.detectionEvidence.some(item => item.path === detectedInput && item.format === "Web app distribution"));
    }
  }

  // Without the Chromium payload files beside it, a renamed executable is not
  // an app distribution launcher, and it stays unrecognized.
  const plainRoot = fixture(t), plainInput = path.join(plainRoot, "Creator Game.exe");
  write(plainInput, renamed());
  appExport(path.join(plainRoot, "resources", "app"));
  for (const report of [Registry.explainDetection(plainInput), await Registry.explainDetectionAsync(plainInput)]) {
    assert.equal(report.detected, null);
    assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
  }

  // A file that is not a PE executable is never a launcher, even beside a
  // complete app distribution.
  const textRoot = fixture(t), textInput = path.join(textRoot, "Creator Game.exe");
  write(textInput, Buffer.from("not an executable"));
  chromiumPayload(textRoot);
  appExport(path.join(textRoot, "resources", "app"));
  for (const report of [Registry.explainDetection(textInput), await Registry.explainDetectionAsync(textInput)]) {
    assert.equal(report.detected, null);
    assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
  }
});
