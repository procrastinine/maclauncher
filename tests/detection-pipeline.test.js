const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const D = require("../src/modules/detection");
const Registry = require("../src/modules/registry");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "detection-pipeline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(filePath, bytes = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}
function mod(id, config, detectGame) {
  return { id, manifest: { id, label: id, detection: config }, detectGame };
}
function match(context, engine, overrides = {}) {
  return { engine, gameType: "engine", gamePath: context.rootDir, contentRootDir: context.rootDir, name: engine, ...overrides };
}
function storedZip(entries, prefix = Buffer.alloc(0)) {
  const local = [], central = [];
  let offset = 0;
  for (const [entryName, contents] of Object.entries(entries)) {
    const name = Buffer.from(entryName), data = Buffer.from(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(Object.keys(entries).length, 8); footer.writeUInt16LE(Object.keys(entries).length, 10);
  footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(body.length, 16);
  return Buffer.concat([prefix, body, directory, footer]);
}

test("specific engines precede fallback modules regardless of registration order", t => {
  const root = fixture(t);
  write(path.join(root, "engine.marker"));
  let fallbackCalls = 0;
  const generic = mod("alphabetically-first", { fallback: true }, context => { fallbackCalls++; return match(context, "generic"); });
  const specific = mod("z-specific", { rootMarkers: ["engine.marker"] }, context => match(context, "specific"));
  for (const modules of [[generic, specific], [specific, generic]]) {
    const report = D.explainDetection(root, modules);
    assert.equal(report.selectedModuleId, "z-specific");
    assert.equal(report.detected.engine, "specific");
  }
  assert.equal(fallbackCalls, 0);
});

test("a selected HTML entry wins over adjacent package defaults and landing pages", async t => {
  for (const specific of [false, true]) {
    const root = fixture(t), chosen = path.join(root, "MainCode.html");
    write(path.join(root, "package.json"), JSON.stringify({ main: "index.html" }));
    write(path.join(root, "index.html"), "<script>location.href='https://example.invalid/'</script>");
    write(chosen, "<html>Creator's offline game entry</html>");
    if (specific) write(path.join(root, "c2runtime.js"), "// Construct 2 game");
    const report = await Registry.explainDetectionAsync(chosen);
    assert.equal(report.detected.indexHtml, chosen);
    assert.equal(report.selectedModuleId, specific ? "construct" : "web");
    assert.equal(D.createDetectionSession(chosen).findIndexHtml(root), chosen);
    assert.equal(D.createDetectionSession(root).findIndexHtml(root), path.join(root, "index.html"));
  }
});

test("packaged game artifacts beat neighboring generic HTML and share ZIP metadata", async t => {
  const root = fixture(t);
  write(path.join(root, "index.html"), "<html>generic landing page</html>");
  const game = path.join(root, "Game.exe");
  write(game, storedZip({ "0.txt": "*start\nend\n" }, Buffer.from("MZ")));
  const sync = Registry.explainDetection(root);
  assert.equal(sync.detected.engine, "nscripter");
  assert.equal(sync.detected.moduleData.packagedType, "zip-exe");
  assert.equal(sync.candidates[0].stage, "artifacts");
  assert.equal(sync.metrics.zipDirectories, 1);
  assert.equal(sync.trace.some(item => item.stage === "fallback" && item.outcome === "matched"), false);
  const async = await Registry.explainDetectionAsync(root);
  assert.equal(async.detected.engine, sync.detected.engine);
  assert.equal(async.metrics.zipDirectories, 1);
  assert.ok(async.metrics.workersStarted >= 2);
});

test("selected real packaged web executables outrank incidental specific engine layouts", async t => {
  for (const [engine, markers] of [
    ["tyrano", { "tyrano/plugins/kag/kag.js": "// Tyrano fixture" }],
    ["construct", { "c3runtime.js": "// Construct fixture" }]
  ]) {
    const root = fixture(t);
    const input = path.join(root, "Chosen.exe");
    write(input, storedZip({ "package.json": '{"main":"index.html"}', "index.html": "<html></html>", ...markers }, Buffer.from("MZ")));
    // The selected container is an independent game; these sibling files must
    // remain visible as contextual evidence without overriding that choice.
    write(path.join(root, "index.html"), "<html>incidental MZ export</html>");
    write(path.join(root, "js", "rmmz_core.js"), "// RPG Maker MZ fixture");
    const reports = [Registry.explainDetection(input), await Registry.explainDetectionAsync(input)];
    for (const report of reports) {
      assert.equal(report.error, undefined, report.error?.message);
      assert.equal(report.selectedModuleId, engine);
      assert.equal(report.detected.gamePath, root);
      assert.equal(report.detected.moduleData.packagedPath, input);
      const selected = report.candidates.find(candidate => candidate.moduleId === engine);
      const sibling = report.candidates.find(candidate => candidate.moduleId === "mz");
      assert.equal(selected.score, 100);
      assert.equal(sibling.score, 70);
      assert.ok(selected.evidence.some(item => item.type === "validated-selected-artifact" && item.path === input));
      assert.equal(report.metrics.zipDirectories, 1);
    }
  }
});

test("equal specific conflicts are explicit, stable and retain all engine/version evidence", t => {
  const root = fixture(t);
  const a = mod("a", {}, context => match(context, "a", { moduleData: { detectedVersion: "4.3.2", detectedSource: "PCK header", detectedVersionConfidence: "exact" } }));
  const b = mod("b", {}, context => match(context, "b", { moduleData: { detectedVersion: "3.1.x", detectedSource: "Project config" } }));
  for (const modules of [[a, b], [b, a]]) {
    const report = D.explainDetection(root, modules);
    assert.equal(report.error.code, "DETECTION_CONFLICT");
    assert.equal(report.detected, null);
    assert.equal(report.candidates.length, 2);
    assert.match(report.error.message, /Ambiguous game input/);
    assert.equal(report.versions.find(item => item.moduleId === "a").certainty, "exact");
    assert.equal(report.versions.find(item => item.moduleId === "b").certainty, "inferred");
    assert.throws(() => D.resultOrThrow(report), error => error.name === "DetectionConflictError" && error.detection.candidates.length === 2);
  }
});

test("selected artifact outranks contextual sibling layouts and same-game duplicates are deduplicated", t => {
  const root = fixture(t), input = path.join(root, "chosen.bin");
  write(input);
  const contextual = mod("sibling", { fileExtensions: [".bin"] }, context => match(context, "sibling"));
  const direct = mod("direct", { fileExtensions: [".bin"] }, context => match(context, "direct", { gamePath: context.inputPath }));
  const report = D.explainDetection(input, [contextual, direct]);
  assert.equal(report.detected.engine, "direct");
  assert.equal(report.candidates.length, 2);
  assert.equal(D.chooseCandidate([report.candidates[1], report.candidates[1]]).moduleId, "direct");
  const evidenceOnly = mod("declared-artifact", { fileExtensions: [".bin"] }, context => match(context, "declared-artifact", {
    detectionEvidence: [{ type: "selected-artifact", path: context.inputPath }]
  }));
  assert.equal(D.explainDetection(input, [contextual, evidenceOnly]).selectedModuleId, "declared-artifact");
});

test("multiple independent packaged games produce a conflict instead of picking a filename", t => {
  const root = fixture(t);
  write(path.join(root, "A.bin")); write(path.join(root, "B.bin"));
  const engine = mod("engine", { inputKinds: ["file"], fileExtensions: [".bin"], directoryFileExtensions: [".bin"] }, context => match(context, "engine", { gamePath: context.inputPath }));
  const report = D.explainDetection(root, [engine]);
  assert.equal(report.error.code, "DETECTION_CONFLICT");
  assert.equal(report.candidates.length, 2);
});

test("exclusive extension ownership is declarative and invalid files never reach generic fallback", t => {
  const root = fixture(t), input = path.join(root, "sample.unique");
  write(input, "bad");
  let fallbackCalls = 0;
  const owner = mod("new-module", { inputKinds: ["file"], extensions: [{ extension: ".unique", exclusive: true }] }, () => null);
  const fallback = mod("generic", { fallback: true }, context => { fallbackCalls++; return match(context, "generic"); });
  const report = D.explainDetection(input, [fallback, owner]);
  assert.equal(report.error.code, "DETECTION_UNSUPPORTED_EXTENSION");
  assert.match(report.error.message, /Unsupported .unique input for new-module/);
  assert.equal(fallbackCalls, 0);
  const goodOwner = { ...owner, detectGame: context => match(context, "new-module", { gamePath: context.inputPath }) };
  assert.equal(D.explainDetection(input, [fallback, goodOwner]).selectedModuleId, "new-module");
});

test("misleading movie, Python and shell filenames cannot borrow sibling web markers", t => {
  const root = fixture(t);
  write(path.join(root, "index.html"), "<html>generic</html>");
  for (const ext of ["swf", "py", "sh", "love", "pck"]) {
    const file = path.join(root, `misleading.${ext}`);
    write(file, "ordinary text");
    const report = Registry.explainDetection(file);
    assert.equal(report.error.code, "DETECTION_UNSUPPORTED_EXTENSION", ext);
    assert.equal(report.detected, null);
    assert.equal(report.trace.some(item => item.stage === "fallback"), false);
  }
});

test("plain executables do not start container helpers, and known archive signatures admit only eligible probes", t => {
  const root = fixture(t), input = path.join(root, "ordinary.exe");
  write(input, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128)]));
  let expensiveCalls = 0;
  const expensive = mod("container", { inputKinds: ["file"], fileExtensions: [".exe"], containerFormats: ["zip", "rar", "7z", "enigma"] }, () => { expensiveCalls++; return null; });
  let report = D.explainDetection(input, [expensive]);
  assert.equal(expensiveCalls, 0);
  assert.ok(report.trace.some(item => item.reason === "container-signature"));
  const actual = Registry.explainDetection(input);
  assert.equal(actual.detected, null);
  assert.equal(actual.metrics.archiveListings, 0);
  assert.ok(actual.trace.some(item => item.moduleId === "rgss" && item.reason === "container-signature"));
  assert.ok(actual.trace.some(item => item.moduleId === "nscripter" && item.reason === "container-signature"));
  write(input, storedZip({ "not-a-game.txt": "data" }, Buffer.from("MZ")));
  report = D.explainDetection(input, [expensive]);
  assert.equal(expensiveCalls, 1);
  assert.equal(report.detected, null);
});

test("session caches filesystem facts, bounded headers, HTML resolution and ZIP directories", t => {
  const root = fixture(t), archive = path.join(root, "bundle.zip");
  write(path.join(root, "app", "index.html"), "<html></html>");
  write(path.join(root, "package.json"), JSON.stringify({ main: "app/index.html" }));
  write(archive, storedZip({ "main.lua": "love.draw=function()end" }));
  const session = D.createDetectionSession(root);
  assert.equal(session.stat(archive), session.stat(archive));
  assert.equal(session.readdir(root), session.readdir(root));
  assert.equal(session.readBytes(archive, 0, 16), session.readBytes(archive, 0, 16));
  assert.equal(session.findIndexHtml(root), path.join(root, "app", "index.html"));
  const afterIndex = { ...session.metrics };
  session.findIndexHtml(root);
  assert.equal(session.metrics.reads, afterIndex.reads);
  assert.equal(session.readZipEntries(archive), session.readZipEntries(archive));
  assert.equal(session.metrics.zipDirectories, 1);
  assert.ok(session.metrics.cacheHits >= 5);
  const alias = path.join(root, "alias.zip");
  fs.symlinkSync(archive, alias);
  const aliased = D.createDetectionSession(alias);
  assert.equal(aliased.input.canonicalPath, fs.realpathSync(archive));
  assert.equal(aliased.context.inputPath, alias);
});

test("HTML entry points cannot escape their game root through package main, symlinks or directories", t => {
  const root = fixture(t), game = path.join(root, "game"), outside = path.join(root, "outside.html");
  fs.mkdirSync(game); write(outside, "outside");
  write(path.join(game, "package.json"), JSON.stringify({ main: "../outside.html" }));
  assert.equal(Registry.findIndexHtml(game), null);
  fs.symlinkSync(outside, path.join(game, "index.html"));
  assert.equal(Registry.findIndexHtml(game), null);
  fs.rmSync(path.join(game, "index.html")); fs.mkdirSync(path.join(game, "index.html"));
  assert.equal(Registry.findIndexHtml(game), null);
});

test("bounds fail with diagnostics before excessive candidate or filesystem work", t => {
  const root = fixture(t);
  const engine = mod("engine", { inputKinds: ["file"], fileExtensions: [".exe"], directoryFileExtensions: [".exe"] }, () => null);
  for (let i = 0; i < 4; i++) write(path.join(root, `${i}.exe`));
  let report = D.explainDetection(root, [engine], { maxProbeFiles: 2 });
  assert.equal(report.error.code, "DETECTION_LIMIT");
  assert.equal(report.metrics.probes, 0);
  report = D.explainDetection(root, [engine], { maxDirectoryEntries: 2 });
  assert.equal(report.error.code, "DETECTION_LIMIT");
  assert.throws(() => D.createDetectionSession(root, { maxWorkers: 100 }), /Invalid detection limit/);
  const markerEngine = mod("marker", { rootMarkers: ["anything"] }, () => null);
  report = D.explainDetection(root, [markerEngine], { maxStats: 1 });
  assert.equal(report.error.code, "DETECTION_LIMIT");
});

test("async probes overlap with bounded concurrency and preserve conflict aggregation", async t => {
  const root = fixture(t);
  let active = 0, maxActive = 0;
  const modules = Array.from({ length: 5 }, (_, index) => ({
    ...mod(`async-${index}`, {}, () => null),
    detectGameAsync: async context => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      return index < 2 ? match(context, `async-${index}`) : null;
    }
  }));
  const report = await D.explainDetectionAsync(root, modules, { maxWorkers: 2 });
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
  assert.equal(report.error.code, "DETECTION_CONFLICT");
  assert.equal(report.candidates.length, 2);
  assert.equal(report.metrics.probes, 5);
});

test("specific native engines beat generic-app fallback and game/app versions remain distinct", t => {
  const root = fixture(t), app = path.join(root, "Game.app");
  write(path.join(app, "Contents", "MacOS", "Game"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(app, "Contents", "MacOS", "Game"), 0o755);
  const pck = Buffer.alloc(20);
  pck.write("GDPC"); pck.writeUInt32LE(3, 4); pck.writeUInt32LE(4, 8); pck.writeUInt32LE(2, 12); pck.writeUInt32LE(1, 16);
  write(path.join(app, "Contents", "Resources", "Game.pck"), pck);
  const report = Registry.explainDetection(app);
  assert.equal(report.selectedModuleId, "godot");
  assert.equal(report.detected.moduleData.detectedVersion, "4.2.1");
  assert.equal(report.trace.some(item => item.moduleId === "generic-app"), false);
  fs.rmSync(path.join(app, "Contents", "Resources", "Game.pck"));
  assert.equal(Registry.explainDetection(app).selectedModuleId, "generic-app");
});

test("read-only diagnostics preserve unknown versions instead of inventing runtime versions", () => {
  assert.equal(D.versionEvidence({ moduleData: { version: "8.3.4.24120703", major: 8 } }).certainty, "reported");
  assert.equal(D.versionEvidence({ moduleData: { detectedVersion: "3.1.x" } }).certainty, "inferred");
  assert.equal(D.versionEvidence({ moduleData: { rawVersion: "2.3.0", rawVersionReliable: false } }).certainty, "inferred");
  const unknown = D.versionEvidence({ moduleData: { rgssVersion: "RGSS3" } });
  assert.equal(unknown.value, null);
  assert.equal(unknown.certainty, "unknown");
  assert.equal(unknown.engineVariant, "RGSS3");
});
