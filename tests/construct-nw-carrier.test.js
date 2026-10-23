const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Registry = require("../src/modules/registry");
const Detection = require("../src/modules/detection");
const Construct = require("../src/modules/construct/detect");
const Packaging = require("../src/modules/shared/web/runtime/nwjs-packaging");
const { peFixture, versionResource } = require("./helpers/pe-fixture");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "construct-nw-carrier-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function carrier(strings = {}) {
  return peFixture({ version: versionResource({ strings: {
    OriginalFilename: "nw.exe", ProductName: "nwjs", FileDescription: "nwjs", ...strings
  } }) }).bytes;
}

// Valid stored ZIPs so the package is independent evidence, without invoking
// an archive command or running the authored PE resource fixture.
function storedZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [entryName, contents] of Object.entries(entries)) {
    const name = Buffer.from(entryName), data = Buffer.from(contents);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(Object.keys(entries).length, 8);
  footer.writeUInt16LE(Object.keys(entries).length, 10); footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, footer]);
}

test("a renamed NW carrier selects its verified Construct package over incidental MZ files", async t => {
  const root = fixture(t), input = path.join(root, "Creator Game.exe"), packagePath = path.join(root, "package.nw");
  const original = carrier(), packageBytes = storedZip({ "index.html": "<html></html>", "c2runtime.js": "// Construct 2 fixture" });
  write(input, original); write(packagePath, packageBytes);
  write(path.join(root, "index.html"), "<html>incidental MZ export</html>");
  write(path.join(root, "js/rmmz_core.js"), "// MZ fixture");
  for (const report of [Registry.explainDetection(input), await Registry.explainDetectionAsync(input)]) {
    assert.equal(report.error, undefined, report.error?.message);
    assert.equal(report.selectedModuleId, "construct");
    assert.equal(report.detected.moduleData.packagedType, "package.nw");
    assert.equal(report.detected.moduleData.packagedPath, packagePath);
    assert.equal(report.detected.moduleData.constructRuntime, "Construct 2");
    const chosen = report.candidates.find(candidate => candidate.moduleId === "construct");
    assert.equal(chosen.score, 100);
    assert.ok(chosen.evidence.some(item => item.type === "validated-selected-artifact" && item.path === input));
    assert.equal(report.candidates.find(candidate => candidate.moduleId === "mz").score, 70);
  }
  assert.deepEqual(fs.readFileSync(input), original);
  assert.deepEqual(fs.readFileSync(packagePath), packageBytes);
});

test("a legacy node-webkit carrier can select a verified directory package", async t => {
  const root = fixture(t), input = path.join(root, "Renamed.exe"), content = path.join(root, "package.nw");
  write(input, carrier({ OriginalFilename: "node-webkit.exe", ProductName: "node-webkit", FileDescription: "Node Webkit" }));
  write(path.join(content, "index.html"), "<html></html>");
  write(path.join(content, "scripts/c3runtime.js"), "// Construct 3 fixture");
  const detected = await Registry.detectGameAsync(input);
  assert.equal(detected.engine, "construct");
  assert.equal(detected.contentRootDir, content);
  assert.equal(detected.indexHtml, path.join(content, "index.html"));
  assert.equal(detected.moduleData.constructRuntime, "Construct 3");
});

test("unrelated and malformed executables cannot borrow a neighboring Construct package", async t => {
  for (const bytes of [
    carrier({ OriginalFilename: "editor.exe" }),
    carrier({ ProductName: "Creator editor", FileDescription: "Editor" }),
    Buffer.from("MZ nw.exe nwjs node-webkit.exe Construct 2")
  ]) {
    const root = fixture(t), input = path.join(root, "Unrelated.exe");
    write(input, bytes);
    write(path.join(root, "package.nw"), storedZip({ "index.html": "<html></html>", "c2runtime.js": "// Construct 2 fixture" }));
    assert.equal(Packaging.readNwjsCarrier(input), null);
    for (const report of [Registry.explainDetection(input), await Registry.explainDetectionAsync(input)]) {
      assert.equal(report.detected, null);
      assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
    }
    write(path.join(root, "index.html"), "<html>Made with Construct 2</html>");
    const session = Detection.createDetectionSession(input);
    assert.equal(Construct.detectGame(session.context, session.helpers), null);
    assert.equal((await Registry.explainDetectionAsync(input)).detected, null);
    assert.deepEqual(fs.readFileSync(input), bytes);
  }
});

test("NW metadata alone does not identify a Construct game", async t => {
  const root = fixture(t), input = path.join(root, "NW Game.exe");
  write(input, carrier());
  write(path.join(root, "package.nw"), storedZip({ "index.html": "<html>another engine</html>", "game.js": "// game" }));
  assert.ok(Packaging.readNwjsCarrier(input));
  const report = await Registry.explainDetectionAsync(input);
  assert.equal(report.detected, null);
  assert.equal(report.error.code, "DETECTION_UNSUPPORTED");
});
