const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { managedAssembly, writeAssembly } = require("./helpers/fna-assembly");
const { inspectManagedAssembly } = require("../src/modules/shared/runtime/managed-assembly");
const { inspectGameAssembly, detectGame } = require("../src/modules/fna/detect");
const Fna = require("../src/modules/fna/main");
const Manager = require("../src/modules/fna/runtime/manager");
const { createDetectionSession } = require("../src/modules/detection");
const { createGameMetadataService } = require("../src/core/game-metadata");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-managed-resources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const ref = name => ({ name, version: [1, 0, 0, 0] });
function embeddedGame(t, options = {}) {
  const root = fixture(t), file = path.join(root, "Game.exe");
  const child = managedAssembly({ name: "Shared", entryPoint: false,
    references: [{ name: "FNA", version: [23, 8, 0, 0] }], ...options.child });
  writeAssembly(file, { references: [ref("Shared")], resources: [{ name: "Game.Libraries.Shared.dll", bytes: child }], ...options.game });
  return { root, file, child };
}

test("shared PE resource ranges inspect nested DLL metadata through the real parent path", t => {
  const { file } = embeddedGame(t), names = [];
  const detection = {
    stat(name) { names.push(name); return fs.statSync(name); },
    readBytes(name, offset, length) {
      names.push(name); const fd = fs.openSync(name, "r");
      try { const bytes = Buffer.alloc(length); assert.equal(fs.readSync(fd, bytes, 0, length, offset), length); return bytes; }
      finally { fs.closeSync(fd); }
    }
  };
  assert.equal(inspectManagedAssembly(file).embeddedResources, undefined, "Existing reader callers retain their cheap default.");
  const parent = inspectManagedAssembly(file, { detection, includeEmbeddedResources: true });
  const resource = parent.embeddedResources[0];
  assert.equal(resource.format, "pe");
  const child = inspectManagedAssembly(file, { detection, range: { offset: resource.offset, size: resource.size } });
  assert.equal(child.assemblyName, "Shared");
  assert.equal(child.references[0].name, "FNA");
  assert.ok(names.length > 2 && names.every(name => name === file), "No embedded resource becomes a stat/read filename.");
  assert.throws(() => inspectManagedAssembly(file, { range: { offset: resource.offset, size: fs.statSync(file).size } }), /byte range/);
});

test("resource descriptors retain invalid, external and compressed formats without inflating them", t => {
  const root = fixture(t), file = path.join(root, "Game.exe");
  writeAssembly(file, { resources: [
    { name: "Bad.dll", bytes: Buffer.from("MZinvalid"), declaredOffset: 0xffffffff },
    { name: "TooLarge.dll", bytes: Buffer.from("MZinvalid"), declaredSize: 0xffffffff },
    { name: "costura.Zip.dll.compressed", bytes: Buffer.from([0x78, 0x9c, 0, 0]) },
    { name: "External.dll", bytes: Buffer.from("MZinvalid"), implementation: 5 },
    { name: "Text.dll", bytes: Buffer.from("ordinary data") },
    { name: "Artwork.png", bytes: Buffer.from("ordinary data") }
  ] });
  const info = inspectManagedAssembly(file, { includeEmbeddedResources: true });
  assert.deepEqual(info.embeddedResources.map(resource => resource.format), ["invalid", "invalid", "compressed", "external", "unknown"]);
  assert.match(info.embeddedResources[0].reason, /offset/);
  assert.match(info.embeddedResources[1].reason, /size/);
});

test("FNA discovers embedded-only and nested engine references and exact embedded framework versions", t => {
  const inner = managedAssembly({ name: "Inner", entryPoint: false, references: [{ name: "FNA", version: [23, 8, 0, 0] }] });
  const outer = managedAssembly({ name: "Outer", entryPoint: false, references: [ref("Inner")],
    resources: [{ name: "Outer.Inner.dll", bytes: inner }] });
  const framework = managedAssembly({ name: "FNA", version: [23, 8, 1, 2], entryPoint: false, references: [] });
  const { file, root } = embeddedGame(t, { game: { references: [ref("Outer")], resources: [
    { name: "Game.Outer.dll", bytes: outer }, { name: "Game.FNA.dll", bytes: framework }
  ] } });
  const before = fs.readFileSync(file), info = inspectGameAssembly(file);
  assert.equal(info.engineKind, "fna");
  assert.equal(info.detectedVersion, "23.8.1.2");
  assert.equal(info.detectedVersionSource, "Embedded FNA assembly metadata");
  assert.equal(info.engineEvidence.assemblyPath, file);
  assert.equal(info.engineEvidence.resourceName, "Outer.Inner.dll");
  assert.equal(info.dependencyInspection.complete, true);
  assert.deepEqual(info.managedDependencies.map(dependency => dependency.assemblyName), ["Outer", "Inner"]);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(root), ["Game.exe"], "Inspection never extracts dependencies.");
});

test("FNA aggregates embedded API, original CLR flags and native import evidence", t => {
  const { file } = embeddedGame(t, { child: { flags: 3,
    types: [{ namespace: "System.Windows.Threading", name: "Dispatcher" }],
    nativeImports: [{ library: "user32.dll", name: "SetWindowLong" }] } });
  const info = inspectGameAssembly(file);
  assert.deepEqual(info.windowsApis, ["WPF"]);
  assert.deepEqual(info.nativeLibraries, ["user32.dll"]);
  assert.equal(info.requires32Bit, false, "The original entrypoint flag stays separate.");
  assert.equal(info.managedDependencies[0].requires32Bit, true);
  assert.equal(info.managedDependencies[0].assemblyPath, file);
  assert.throws(() => Fna.__test.preflight({ gamePath: file }), /WPF/);
});

test("compressed or invalid referenced DLL resources block runtime requests before installation", async t => {
  const { file } = embeddedGame(t, { game: {
    references: [ref("FNA"), ref("Shared")],
    resources: [{ name: "costura.shared.dll.compressed", bytes: Buffer.from([0x78, 0x9c, 0, 0]) }]
  } });
  const before = fs.readFileSync(file), info = inspectGameAssembly(file);
  assert.equal(info.engineKind, "fna");
  assert.equal(info.dependencyInspection.complete, false);
  assert.match(info.dependencyInspection.issues[0].reason, /Compressed/);
  t.mock.method(Manager, "resolveSelection", () => { throw Error("No runtime should be selected"); });
  await assert.rejects(Fna.ensureRuntime({ gamePath: file }, { runtimeId: "fna" }), /Cannot inspect managed dependency Shared/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("embedded raw PE labels alone cannot establish a managed dependency identity", t => {
  const { file } = embeddedGame(t, { game: { references: [ref("FNA"), ref("Shared")],
    resources: [{ name: "Shared.dll", bytes: managedAssembly({ name: "Different", entryPoint: false }) }] } });
  const info = inspectGameAssembly(file);
  assert.equal(info.dependencyInspection.complete, false);
  assert.match(info.dependencyInspection.issues[0].reason, /identity/);
});

test("dependency source, depth, byte and resource-size limits remain explicit", t => {
  const { file, child } = embeddedGame(t, { game: { references: [ref("FNA"), ref("Shared")] } });
  for (const limits of [{ maxAssemblies: 1 }, { maxDepth: 0 }, { maxEmbeddedResourceBytes: child.length - 1 }]) {
    const info = inspectGameAssembly(file, { limits });
    assert.equal(info.dependencyInspection.complete, false);
    assert.match(info.dependencyInspection.issues[0].reason, /limit/);
    assert.ok(info.dependencyInspection.inspectedSources <= (limits.maxAssemblies || 32));
  }
  const bytes = inspectGameAssembly(file).dependencyInspection.bytesRead;
  const bounded = inspectGameAssembly(file, { limits: { maxReadBytes: bytes - 1 } });
  assert.equal(bounded.dependencyInspection.complete, false);
  assert.ok(bounded.dependencyInspection.bytesRead < bytes);
  assert.throws(() => inspectGameAssembly(file, { limits: { maxAssemblies: 33 } }), /limit/);
});

test("many referenced embedded libraries cannot exceed the 32-source inspection cap", t => {
  const root = fixture(t), file = path.join(root, "Game.exe"), names = Array.from({ length: 40 }, (_, index) => "Library" + index);
  writeAssembly(file, { references: [ref("FNA"), ...names.map(ref)], resources: names.map(name => ({ name: "Game." + name + ".dll",
    bytes: managedAssembly({ name, entryPoint: false, references: [] }) })) });
  const info = inspectGameAssembly(file);
  assert.equal(info.dependencyInspection.complete, false);
  assert.equal(info.dependencyInspection.inspectedSources, 32);
  assert.ok(info.managedDependencies.length < names.length);
  assert.ok(info.dependencyInspection.issues.every(issue => /assembly limit/.test(issue.reason)));
});

test("embedded dependency cycles reuse the same parent byte range", t => {
  const root = fixture(t), file = path.join(root, "Game.exe");
  writeAssembly(file, { references: [ref("A")], resources: [
    { name: "Game.A.dll", bytes: managedAssembly({ name: "A", entryPoint: false, references: [ref("B")] }) },
    { name: "Game.B.dll", bytes: managedAssembly({ name: "B", entryPoint: false, references: [ref("A"), ref("FNA")] }) }
  ] });
  const info = inspectGameAssembly(file);
  assert.equal(info.engineKind, "fna");
  assert.equal(info.dependencyInspection.complete, true);
  assert.equal(info.dependencyInspection.inspectedSources, 3);
  assert.deepEqual(info.managedDependencies.map(dependency => dependency.assemblyName), ["A", "B"]);
});

test("32-bit and mixed-mode managed dependencies retain their original requirements", t => {
  const { file } = embeddedGame(t, { child: { flags: 3 } });
  assert.throws(() => Fna.__test.preflight({ gamePath: file }), /Shared declares a 32-bit CLR/);
  const source = inspectManagedAssembly(file, { includeEmbeddedResources: true }).embeddedResources[0];
  assert.equal(inspectManagedAssembly(file, { range: { offset: source.offset, size: source.size } }).requires32Bit, true);
  writeAssembly(file, { references: [ref("Shared")], resources: [{ name: "Shared.dll", bytes: managedAssembly({
    name: "Shared", entryPoint: false, flags: 0 }) }] });
  assert.throws(() => Fna.__test.preflight({ gamePath: file }), /Shared requires a native compatibility port/);
});

test("FNA uses the parent detection session cache and propagates global read limits", t => {
  const { file, root } = embeddedGame(t);
  const session = createDetectionSession(file);
  const first = detectGame(session.context), metrics = { ...session.metrics };
  const second = detectGame(session.context);
  assert.equal(second.moduleData, first.moduleData);
  assert.equal(session.metrics.reads, metrics.reads);
  assert.equal(session.metrics.stats, metrics.stats);
  assert.ok(session.metrics.cacheHits > metrics.cacheHits);
  assert.ok([...session.caches.reads.keys()].every(key => key.split("\0")[0] === file));
  assert.deepEqual(fs.readdirSync(root), ["Game.exe"]);
  const tiny = createDetectionSession(file, { maxReadBytes: 128 });
  assert.throws(() => detectGame(tiny.context), error => error.code === "DETECTION_LIMIT");
});

test("persistent metadata observes embedded data in its real PE and refreshes once per source or algorithm change", async t => {
  const { file, root } = embeddedGame(t), moduleDir = path.join(root, "module"), userDataDir = path.join(root, "data");
  fs.mkdirSync(moduleDir); fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(moduleDir, "detect.js"), "// embedded algorithm v1\n");
  const info = { id: "fna", label: "FNA", runtime: { manager: { fna: "fna" } } };
  const mod = { id: "fna", manifest: info, resolveGameIcon: () => null };
  let calls = 0;
  const registry = { listModuleIds: () => ["fna"], listModules: () => [info], getModuleDir: () => moduleDir,
    getModuleInfo: () => info, getModule: () => mod,
    detectGameAsync: async input => { calls++; return detectGame(createDetectionSession(input).context); } };
  let service = createGameMetadataService({ userDataDir, registry });
  const settings = {}, entry = { gameId: "embedded-cache", gamePath: file, importPath: file,
    contentRootDir: root, moduleId: "fna", runtimeId: "fna", runtimeData: {}, moduleData: {} };
  let current = await service.refreshEntry(entry, settings);
  await service.refreshEntry(current, settings);
  service = createGameMetadataService({ userDataDir, registry });
  await service.refreshEntry(current, settings);
  assert.equal(calls, 1);
  const before = fs.statSync(file);
  writeAssembly(file, { references: [ref("Shared")], resources: [{ name: "Game.Libraries.Shared.dll",
    bytes: managedAssembly({ name: "Shared", entryPoint: false, types: [{ namespace: "System.Windows.Forms", name: "Form" }] }) }] });
  fs.utimesSync(file, before.atime, before.mtime);
  current = await service.refreshEntry(current, settings);
  assert.deepEqual(current.moduleData.windowsApis, ["Windows Forms"]);
  assert.equal(calls, 2);
  await service.refreshEntry(current, settings); assert.equal(calls, 2);
  fs.appendFileSync(path.join(moduleDir, "detect.js"), "// embedded algorithm v2\n");
  service = createGameMetadataService({ userDataDir, registry });
  current = await service.refreshEntry(current, settings);
  await service.refreshEntry(current, settings);
  assert.equal(calls, 3, "The explicit FNA callsite change invalidates old facts once.");
  const cache = JSON.parse(fs.readFileSync(path.join(userDataDir, "games", entry.gameId, "metadata.json")));
  assert.ok(cache.files.some(([observed]) => observed === file));
  assert.ok(cache.files.every(([observed]) => !observed.includes("#resource") && !observed.includes("Game.Libraries.Shared.dll")));
});
