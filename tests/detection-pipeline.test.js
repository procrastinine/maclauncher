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

function windowsExecutable(filePath) {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt16LE(2, 220);
  write(filePath, bytes); return filePath;
}

test("containing folders recognize immediate app bundles with their specific engine", async t => {
  const root = fixture(t), app = path.join(root, "Game.app");
  fs.mkdirSync(app);
  const modules = [
    mod("engine", { inputKinds: ["app"] }, context => match(context, "engine")),
    mod("generic", { inputKinds: ["app"], fallback: true, priority: -100 }, context => match(context, "generic"))
  ];
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    const report = await explain(root, modules);
    assert.equal(report.error, undefined);
    assert.equal(report.input.requestedPath, root);
    assert.equal(report.detected.gamePath, app);
    assert.equal(report.selectedModuleId, "engine");
    assert.equal(report.candidates[0].stage, "child-app");
  }
});

test("extensionless publisher bundles retain engine precedence and bounded sync/async detection", async t => {
  const root = fixture(t), app = path.join(root, "Publisher Game"), executable = path.join(app, "Contents/MacOS/runner");
  write(executable, "#!/bin/sh\nexit 0\n"); fs.chmodSync(executable, 0o755);
  const plist = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>runner</string></dict></plist>';
  write(path.join(app, "Contents/Info.plist"), plist);
  const modules = [
    mod("engine", { inputKinds: ["app"] }, context => match(context, "engine")),
    require("../src/modules/generic-app/main")
  ];
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    const direct = await explain(app, modules);
    assert.equal(direct.input.kind, "app"); assert.equal(direct.selectedModuleId, "engine");
    assert.equal((await explain(root, modules)).selectedModuleId, "engine");
    const generic = await explain(app, [modules[1]]);
    assert.equal(generic.selectedModuleId, "generic-app"); assert.equal(generic.detected.nativeAppPath, app);
    assert.equal(generic.detected.moduleData.executablePath, executable);
    assert.ok(generic.metrics.bytesRead <= Buffer.byteLength(plist) + 4);
    assert.equal(generic.metrics.directories, 0, "structural recognition does not scan bundle resources");
    assert.equal((await explain(app, modules, { maxReadBytes: 16 })).error.code, "DETECTION_LIMIT");
  }
  fs.unlinkSync(executable);
  assert.equal(D.createDetectionSession(app).context.isAppBundle, false);
});

test("child app fallback is bounded, nonrecursive and reports multiple apps", async t => {
  const root = fixture(t), nested = path.join(root, "Subfolder", "Hidden.app");
  fs.mkdirSync(nested, { recursive: true });
  const modules = [mod("generic", { inputKinds: ["app"], fallback: true }, context => match(context, "generic"))];
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    assert.equal((await explain(root, modules)).error.code, "DETECTION_UNSUPPORTED");
  }
  const app = path.join(root, "One.app"); fs.mkdirSync(app);
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    assert.equal((await explain(root, modules)).detected.gamePath, app);
  }
  fs.mkdirSync(path.join(root, "Two.app"));
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    const report = await explain(root, modules);
    assert.equal(report.error.code, "DETECTION_CONFLICT");
    assert.equal(report.candidates.length, 2);
    assert.equal((await explain(root, modules, { maxProbeFiles: 1 })).error.code, "DETECTION_LIMIT");
    const direct = mod("directory-engine", { inputKinds: ["directory"] }, context => match(context, "directory-engine"));
    assert.equal((await explain(root, [direct, ...modules])).selectedModuleId, "directory-engine");
  }
});

test("fallback priority groups stop after the strongest recognized group in sync and async detection", async t => {
  const root = fixture(t);
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    for (const reversed of [false, true]) {
      const calls = [];
      const modules = [
        mod("weak", { fallback: true, priority: -200 }, () => { calls.push("weak"); throw Object.assign(new Error("Choose an executable."), { code: "DETECTION_CONFLICT" }); }),
        mod("strong", { fallback: true, priority: 0 }, context => { calls.push("strong"); return match(context, "strong"); }),
        mod("higher-miss", { fallback: true, priority: 50 }, () => { calls.push("higher-miss"); return null; })
      ];
      const report = await explain(root, reversed ? modules.reverse() : modules);
      assert.equal(report.error, undefined); assert.equal(report.selectedModuleId, "strong");
      assert.deepEqual(calls, ["higher-miss", "strong"]);
      assert.equal(report.trace.some(item => item.moduleId === "weak"), false);
    }
  }
});

test("equal-priority fallback matches retain ambiguity and async probes remain bounded", async t => {
  const root = fixture(t);
  for (const asyncMode of [false, true]) {
    let active = 0, maximum = 0, weakCalls = 0;
    const peers = Array.from({ length: 5 }, (_, index) => {
      const detect = context => index < 2 ? match(context, `peer-${index}`) : null;
      return { ...mod(`peer-${index}`, { fallback: true, priority: -10 }, detect),
        ...(asyncMode ? { detectGameAsync: async context => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return detect(context); } } : {}) };
    });
    const lower = mod("lower", { fallback: true, priority: -20 }, () => { weakCalls++; return null; });
    const report = asyncMode ? await D.explainDetectionAsync(root, [lower, ...peers], { maxWorkers: 2 }) : D.explainDetection(root, [lower, ...peers]);
    assert.equal(report.error.code, "DETECTION_CONFLICT"); assert.equal(report.candidates.length, 2);
    assert.equal(report.metrics.probes, 5); assert.equal(weakCalls, 0); assert.equal(active, 0);
    if (asyncMode) assert.equal(maximum, 2);
  }
});

test("module-reported conflicts propagate with diagnostics instead of becoming unsupported or lower fallback matches", async t => {
  const root = fixture(t), message = "Multiple executable choices. Select one game file.";
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    let weakerCalls = 0;
    const ambiguous = mod("ambiguous", { fallback: true, priority: 0 }, () => { throw Object.assign(new Error(message), { code: "DETECTION_CONFLICT" }); });
    const weaker = mod("weaker", { fallback: true, priority: -1 }, context => { weakerCalls++; return match(context, "weaker"); });
    const report = await explain(root, [weaker, ambiguous]);
    assert.equal(report.error.code, "DETECTION_CONFLICT"); assert.equal(report.error.message, message); assert.equal(weakerCalls, 0);
    assert.ok(report.trace.some(item => item.moduleId === "ambiguous" && item.outcome === "error" && item.code === "DETECTION_CONFLICT"));
    assert.throws(() => D.resultOrThrow(report), error => error.code === "DETECTION_CONFLICT" && error.detection === report);
  }
});

test("worker-reported conflicts retain their code and async detection finishes active peers before returning", async t => {
  const root = fixture(t), file = path.join(root, "game.bin"), moduleDir = path.join(root, "detector"); write(file);
  write(path.join(moduleDir, "main.js"), 'module.exports={detectGame(){throw Object.assign(new Error("Select one executable file."),{code:"DETECTION_CONFLICT"});}};');
  let active = 0, weakerCalls = 0;
  const ambiguous = { ...mod("worker-ambiguous", { inputKinds: ["file"], worker: true }, () => null), __moduleDir: moduleDir };
  const peer = { ...mod("peer", {}, () => null), detectGameAsync: async () => { active++; await new Promise(resolve => setTimeout(resolve, 80)); active--; return null; } };
  const weaker = mod("fallback", { fallback: true }, context => { weakerCalls++; return match(context, "fallback"); });
  const report = await D.explainDetectionAsync(file, [ambiguous, peer, weaker], { maxWorkers: 2 });
  assert.equal(report.error.code, "DETECTION_CONFLICT"); assert.match(report.error.message, /Select one executable/);
  assert.equal(report.metrics.workersStarted, 1); assert.equal(active, 0); assert.equal(weakerCalls, 0);
  assert.ok(report.trace.some(item => item.moduleId === "worker-ambiguous" && item.code === "DETECTION_CONFLICT"));
});

test("generic Windows fallback accepts one top-level PE, rejects ambiguous folders and honors deliberate executable selection", async t => {
  const root = fixture(t), nested = windowsExecutable(path.join(root, "bin", "Nested.exe"));
  for (const explain of [Registry.explainDetection, Registry.explainDetectionAsync]) {
    const nestedOnly = await explain(root); assert.equal(nestedOnly.detected, null);
    const chosen = windowsExecutable(path.join(root, "Chosen.exe"));
    const single = await explain(root); assert.equal(single.error, undefined, single.error?.message); assert.equal(single.selectedModuleId, "crossover");
    assert.equal(single.detected.moduleData.executablePath, chosen);
    windowsExecutable(path.join(root, "Config.exe"));
    const multiple = await explain(root); assert.equal(multiple.error.code, "DETECTION_CONFLICT"); assert.match(multiple.error.message, /Select one \.exe/);
    const selected = await explain(chosen); assert.equal(selected.error, undefined); assert.equal(selected.detected.moduleData.executablePath, chosen);
    const selectedNested = await explain(nested); assert.equal(selectedNested.error, undefined); assert.equal(selectedNested.detected.moduleData.executablePath, nested);
    fs.rmSync(chosen); fs.rmSync(path.join(root, "Config.exe"));
  }
});

test("specific game data and existing web fallback recognize folders before generic Windows ambiguity", async t => {
  const root = fixture(t); windowsExecutable(path.join(root, "Game.exe")); windowsExecutable(path.join(root, "Config.exe"));
  write(path.join(root, "Game.ini"), "WindowModeFlag=1"); write(path.join(root, "Data", "BasicData", "Game.dat"), "game data");
  for (const explain of [Registry.explainDetection, Registry.explainDetectionAsync]) {
    const report = await explain(root); assert.equal(report.error, undefined, report.error?.message); assert.equal(report.selectedModuleId, "wolfrpg");
    assert.equal(report.trace.some(item => item.moduleId === "crossover"), false);
  }
  fs.rmSync(path.join(root, "Data"), { recursive: true }); fs.rmSync(path.join(root, "Game.ini")); write(path.join(root, "index.html"), "<html>Web game</html>");
  for (const explain of [Registry.explainDetection, Registry.explainDetectionAsync]) {
    const report = await explain(root); assert.equal(report.error, undefined, report.error?.message); assert.equal(report.selectedModuleId, "web");
    assert.equal(report.trace.some(item => item.moduleId === "crossover"), false);
  }
});

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

test("misleading reserved game filenames cannot borrow sibling web markers", t => {
  const root = fixture(t);
  write(path.join(root, "index.html"), "<html>generic</html>");
  for (const ext of ["swf", "py", "love", "pck"]) {
    const file = path.join(root, `misleading.${ext}`);
    write(file, "ordinary text");
    const report = Registry.explainDetection(file);
    assert.equal(report.error.code, "DETECTION_UNSUPPORTED_EXTENSION", ext);
    assert.equal(report.detected, null);
    assert.equal(report.trace.some(item => item.stage === "fallback"), false);
  }
});

test("selected shell and executable Python launchers preserve Ren'Py precedence", async t => {
  const root = fixture(t), input = path.join(root, "Game.sh"), python = path.join(root, "Game.py");
  write(input, "#!/bin/sh\nexec ./game-player\n");
  write(python, "#!/usr/bin/env python3\nprint('launch')\n");
  write(path.join(root, "index.html"), "<html>generic</html>");
  const modules = [require("../src/modules/generic-app/main"), require("../src/modules/web/main"), require("../src/modules/renpy/main")];
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    assert.equal((await explain(python, modules)).error.code, "DETECTION_UNSUPPORTED_EXTENSION");
    const native = await explain(input, modules);
    assert.equal(native.error, undefined);
    assert.equal(native.selectedModuleId, "generic-app");
    assert.equal(native.detected.gamePath, input);
    assert.equal(native.detected.moduleData.launchKind, "script");
  }
  fs.chmodSync(python, 0o755);
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    const native = await explain(python, modules);
    assert.equal(native.error, undefined);
    assert.equal(native.selectedModuleId, "generic-app");
    assert.equal(native.detected.gamePath, python);
    assert.equal(native.detected.moduleData.launchKind, "script");
  }
  write(path.join(root, "renpy/vc_version.py"), "version = '8.3.0'\n");
  write(path.join(root, "game/script.rpy"), "label start:\n    return\n");
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    for (const launcher of [input, python]) {
      const renpy = await explain(launcher, modules);
      assert.equal(renpy.error, undefined);
      assert.equal(renpy.selectedModuleId, "renpy");
      assert.equal(renpy.detected.moduleData.baseName, "Game");
      assert.equal(renpy.detected.moduleData.launchKind, undefined);
    }
  }
});

test("native file fallbacks preserve engine priority and never choose arbitrary folder scripts", async t => {
  const root = fixture(t), input = path.join(root, "launch.command");
  write(input, "#!/bin/sh\nexit 0\n");
  const native = require("../src/modules/generic-app/main");
  const engine = mod("specific", { inputKinds: ["file"] }, context => match(context, "specific"));
  for (const explain of [D.explainDetection, D.explainDetectionAsync]) {
    assert.equal((await explain(input, [native, engine])).selectedModuleId, "specific");
    assert.equal((await explain(input, [native])).selectedModuleId, "generic-app");
    assert.equal((await explain(root, [native])).detected, null);
  }
  const extensions = Registry.listSupportedInputExtensions();
  for (const extension of ["sh", "command", "bash", "zsh"]) assert.ok(extensions.includes(extension), extension);
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
