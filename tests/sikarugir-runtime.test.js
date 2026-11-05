// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Catalog = require("../src/modules/crossover/sikarugir/runtime/catalog");
const Payload = require("../src/modules/crossover/sikarugir/runtime/payload");
const { createManager } = require("../src/modules/crossover/sikarugir/runtime/manager");
const { extractArchive } = require("../src/modules/crossover/sikarugir/runtime/archive");
const Python = require("../src/modules/shared/runtime/python");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sikarugir-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function asset(name, digest = "a".repeat(64), repo = "Engines", bytes = 42) {
  return { name, digest: `sha256:${digest}`, size: bytes, id: 1,
    browser_download_url: `https://github.com/Sikarugir-App/${repo}/releases/download/v1.0/${name}` };
}
function release(assets) { return { tag_name: "v1.0", assets }; }
// Archive downloads answer from these routes; each fixture pin serves its
// engine and support archive bytes.
const served = {};
Harness.network.routes = served;
function command(kind, value) {
  const size = Math.ceil((24 + Buffer.byteLength(value) + 1) / 8) * 8, bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(kind); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(24, 8); bytes.write(value, 24); return bytes;
}
function macho(type = 2, { dependency = "/usr/lib/libSystem.B.dylib", minimum = 14, marker = "" } = {}) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32); build.writeUInt32LE(24, 4);
  build.writeUInt32LE(1, 8); build.writeUInt32LE(minimum << 16, 12); build.writeUInt32LE(27 << 16, 16);
  const commands = [build, command(0xc, dependency)], body = Buffer.concat(commands), bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x01000007, 4); bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(type, 12); bytes.writeUInt32LE(commands.length, 16); bytes.writeUInt32LE(body.length, 20);
  body.copy(bytes, 32); bytes.write(marker, 400); return bytes;
}
function write(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode }); return file;
}
function engine(root, options = {}) {
  const wineRoot = path.join(root, Payload.WINE_ROOT);
  write(path.join(wineRoot, "bin", "wine"), macho(2, options), 0o755);
  write(path.join(wineRoot, "bin", "wineserver"), macho(2, { dependency: "@rpath/libsupport.dylib", marker: "WINEMSYNC" }), 0o755);
  for (const name of ["ntdll", "winemac"]) write(path.join(wineRoot, "lib", "wine", "x86_64-unix", name + ".so"), macho(6));
  write(path.join(wineRoot, "lib", "wine", "i386-windows", "kernel32.dll"), "Windows resources");
  write(path.join(wineRoot, "version"), "wine sikarugir fixture");
}
function stage({ destinationRoot }, options = {}) {
  write(path.join(destinationRoot, "Frameworks", "libsupport.dylib"), macho(6, options));
  // This renderer is deliberately newer than the base runtime and must not
  // increase the minimum macOS version for ordinary Wine.
  write(path.join(destinationRoot, "Frameworks", "renderer", "d3dmetal", "new.dylib"), macho(6, { minimum: 26 }));
  const metadata = { relativePaths: { frameworks: "Frameworks", templateRenderers: "SharedSupport/renderer" }, minimumBaseMacOS: "14.0.0",
    componentVersions: { d3dmetal: "4.0" }, graphicsCapabilities: { d3dmetal: true, minimumMacOS: { d3dmetal: "26.4.0" } } };
  write(path.join(destinationRoot, "graphics.json"), JSON.stringify(metadata)); return metadata;
}
function fixturePin(engineVersion = "11.0_1", engineBytes = Buffer.from("engine archive"), templateBytes = Buffer.from("support archive"), templateVersion = "1.0.21") {
  const template = { version: templateVersion, minimumMacOS: "14.0", asset: {
    filename: `Template-${templateVersion}.tar.xz`, url: `https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-${templateVersion}.tar.xz`,
    sha256: sha(templateBytes), bytes: templateBytes.length } };
  const pin = Catalog.entryFor(Catalog.parseEngineName(`WS12WineSikarugir${engineVersion}.tar.xz`),
    { filename: `WS12WineSikarugir${engineVersion}.tar.xz`,
      url: `https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir${engineVersion}.tar.xz`,
      sha256: sha(engineBytes), bytes: engineBytes.length }, template);
  served[pin.asset.url] = engineBytes; served[template.asset.url] = templateBytes;
  return pin;
}
function fixtureManager({ rows, dependencies = {}, discoverCatalog } = {}) {
  return createManager({ discoverCatalog: discoverCatalog || (async () => rows || [fixturePin()]), dependencies: {
    systemVersionSync: () => "14.0", extractArchive: async (archive, root) => { if (path.basename(archive).startsWith("Template-")) fs.mkdirSync(path.join(root, "Template-1.0.21.app", "Contents"), { recursive: true }); else engine(root); },
    stageTemplateClosure: async options => stage(options), ...dependencies
  } });
}
// Reproduce a complete registration written before renderer discovery covered
// SharedSupport. Its inventory is valid for the incomplete files it selected.
function omitLegacyRenderers(install) {
  const recordFile = path.join(install.installDir, "runtime.json"), record = JSON.parse(fs.readFileSync(recordFile));
  fs.rmSync(path.join(install.installDir, "support", "Frameworks", "renderer"), { recursive: true });
  delete record.installationMetadata.graphics.relativePaths.templateRenderers;
  record.installationMetadata.graphics.graphicsCapabilities.d3dmetal = false;
  write(path.join(install.installDir, "support", "graphics.json"), JSON.stringify(record.installationMetadata.graphics));
  const files = Payload.walk(install.installDir);
  for (const row of files) if (row.kind === "file") row.sha256 = sha(fs.readFileSync(path.join(install.installDir, row.relative)));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  write(path.join(install.installDir, Payload.INVENTORY), bytes);
  record.installationMetadata.inventory = { relativePath: Payload.INVENTORY, sha256: sha(bytes), bytes: bytes.length, count: files.length };
  write(recordFile, JSON.stringify(record));
}

test("Sikarugir retries reuse completed engine and Template downloads after extraction failures", async t => {
  const root=temporary(t),pin=fixturePin(),start=Harness.network.requests.length;
  let engineExtractions=0,templateExtractions=0;
  const manager=fixtureManager({rows:[pin],dependencies:{extractArchive:async(archive,output)=>{
    if(path.basename(archive).startsWith('Template-')){
      if(++templateExtractions===1)throw Error('Fixture Template extraction unavailable');
      fs.mkdirSync(path.join(output,'Template-1.0.21.app','Contents'),{recursive:true});
    }else{
      if(++engineExtractions===1)throw Error('Fixture engine extraction unavailable');
      engine(output);
    }
  }}});
  const downloads=url=>Harness.network.requests.slice(start).filter(request=>request===url).length;
  await assert.rejects(manager.installRuntime({userDataDir:root,version:pin.version}),/Fixture engine extraction unavailable/);
  assert.equal(downloads(pin.asset.url),1);assert.equal(downloads(pin.template.asset.url),0);
  await assert.rejects(manager.installRuntime({userDataDir:root,version:pin.version}),/Fixture Template extraction unavailable/);
  assert.equal(downloads(pin.asset.url),1,'engine retry uses the already completed shared archive');assert.equal(downloads(pin.template.asset.url),1);
  const installed=await manager.installRuntime({userDataDir:root,version:pin.version});
  assert.equal(downloads(pin.asset.url),1);assert.equal(downloads(pin.template.asset.url),1,'Template retry also reuses its completed archive');
  assert.equal(manager.resolveSelection({}, {}, root, {version:pin.version}).ready,true);
  assert.ok(fs.existsSync(installed.executablePath));assert.equal(engineExtractions,3);assert.equal(templateExtractions,2);
  const artifacts=path.join(root,'runtimes','artifacts'),digests=fs.readdirSync(artifacts).filter(name=>!name.endsWith('.json')).map(name=>{
    const digest=sha(fs.readFileSync(path.join(artifacts,name)));assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts,name+'.json'))).sha256,digest);return digest;
  });
  assert.deepEqual(digests.sort(),[pin.asset.sha256,pin.template.asset.sha256].sort(),'only the exact verified publisher bytes are retained');
});

test("Sikarugir Install replaces an incomplete Template registration and keeps valid copies unchanged", async t => {
  const root = temporary(t), pin = fixturePin("11.0_1", undefined, undefined, "1.0.24");
  for (const method of ["installRuntime", "core"]) {
    const userDataDir = path.join(root, method), manager = fixtureManager({ rows: [pin] });
    await manager.refreshCatalog({ userDataDir, force: true });
    const install = await manager.core.installVersion({ userDataDir, version: pin.version });
    omitLegacyRenderers(install);
    assert.equal(manager.getState({ userDataDir }).installed[0].status, "damaged");
    assert.match(manager.resolveSelection({}, {}, userDataDir, { version: pin.version }).reason, /restore its renderers/);
    const repaired = await (method === "core" ? manager.core.installVersion : manager.installRuntime)({ userDataDir, version: pin.version });
    assert.equal(repaired.version, pin.version);
    assert.equal(repaired.graphicsMetadata.relativePaths.templateRenderers, "SharedSupport/renderer");
    assert.equal(repaired.graphicsCapabilities.d3dmetal, true);
    assert.equal(manager.getState({ userDataDir }).installed[0].ready, true);
    const record = fs.readFileSync(path.join(repaired.installDir, "runtime.json"));
    await manager.installRuntime({ userDataDir, version: pin.version });
    assert.deepEqual(fs.readFileSync(path.join(repaired.installDir, "runtime.json")), record, "valid installations are reused");
    assert.deepEqual(fs.readdirSync(path.dirname(repaired.installDir)).filter(name => name.startsWith(".install-")), []);
  }
});

test("Sikarugir failed and canceled renderer repairs preserve the previous registration", async t => {
  const root = temporary(t), pin = fixturePin("11.0_1", undefined, undefined, "1.0.24");
  let failure = null;
  served[pin.asset.url] = () => { if (failure === "cancel") controller.abort(); return Buffer.from("engine archive"); };
  served[pin.template.asset.url] = () => Buffer.from(failure === "checksum" ? "broken support!" : "support archive");
  const manager = fixtureManager({ rows: [pin] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const install = await manager.core.installVersion({ userDataDir: root, version: pin.version });
  omitLegacyRenderers(install);
  const recordFile = path.join(install.installDir, "runtime.json"), before = fs.readFileSync(recordFile);
  failure = "checksum";
  await assert.rejects(manager.installRuntime({ userDataDir: root, version: pin.version }), /Template-1\.0\.24\.tar\.xz does not match the checksum its publisher lists/);
  assert.deepEqual(fs.readFileSync(recordFile), before);
  failure = "cancel";
  const controller = new AbortController();
  await assert.rejects(manager.installRuntime({ userDataDir: root, version: pin.version, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(fs.readFileSync(recordFile), before);
  assert.deepEqual(fs.readdirSync(path.dirname(install.installDir)).filter(name => name.startsWith(".install-")), []);
});

test("Sikarugir Play repairs incomplete renderers through the existing consent flow", async t => {
  const root = temporary(t), pin = fixturePin("11.0_1", undefined, undefined, "1.0.24"), manager = fixtureManager({ rows: [pin] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const install = await manager.core.installVersion({ userDataDir: root, version: pin.version });
  omitLegacyRenderers(install);
  const recordFile = path.join(install.installDir, "runtime.json"), before = fs.readFileSync(recordFile);
  const gameRoot = path.join(root, "games", "game"), save = write(path.join(gameRoot, "save.dat"), "saved game");
  const entry = { gameId: "game", gamePath: gameRoot, runtimeId: "sikarugir", runtimeData: {
    crossover: { windowsExecutablePath: path.join(gameRoot, "Game.exe"), executableArchitecture: "x86_64", sourceRoot: gameRoot }, sikarugir: { version: pin.version } } };
  const provider = require("../src/modules/crossover/sikarugir/provider").createProvider({ manager });
  const mod = { runtimeManagers: [manager], getRuntimeProvider: () => provider };
  const info = { runtime: { manager: { sikarugir: "sikarugir" } } };
  const registry = { listModuleIds: () => ["crossover"], getModule: () => mod };
  const prompts = [];
  let approved = false, installs = 0;
  const context = { userDataDir: root, runtimeId: "sikarugir", settings: { runtimes: {} },
    confirmRuntimeInstall: plan => { prompts.push(plan); return approved; } };
  const prepare = () => require("../src/core/runtime-preparation").prepareForLaunch({ entry, mod, info, context, registry,
    install: async (_manager, options) => { installs++; await manager.installRuntime({ ...options, userDataDir: root }); } });
  assert.equal(await prepare(), false);
  assert.equal(installs, 0);
  assert.deepEqual(fs.readFileSync(recordFile), before);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].detail, /Reinstalls/);
  approved = true;
  assert.equal(await prepare(), true);
  assert.equal(installs, 1);
  assert.equal(prompts.length, 2, "each Play asks once before downloading");
  assert.ok(manager.core.resolveInstalled({ userDataDir: root, version: pin.version }));
  assert.equal(fs.readFileSync(save, "utf8"), "saved game");
  assert.equal(await prepare(), true);
  assert.equal(prompts.length, 2, "a repaired installation is reused offline without another prompt");
});

// The publisher's Engines and Template release lists.
async function discover(t, { Engines, Template }) {
  const previous = Harness.network.routes;
  Harness.network.routes = { ...Harness.githubRoutes("Sikarugir-App/Engines", Engines), ...Harness.githubRoutes("Sikarugir-App/Template", Template) };
  try { return await Catalog.discover(); } finally { Harness.network.routes = previous; }
}
test("Sikarugir discovers all compatible engine assets and identifies both archives", async t => {
  const engineAssets = [asset("WS12WineSikarugir10.0_8.tar.xz"), asset("WS12WineSikarugir11.0_1.tar.xz", "b".repeat(64)),
    asset("WS12WineSikarugir11.0_2.tar.xz", "c".repeat(64)), asset("WS12WineCX24.0.7_7.tar.xz"),
    asset("WS11WineSikarugir11.0_1.tar.xz"), asset("WS12WineSikarugir10.0_7.tar.xz")];
  const support = [asset("Template-1.0.19.tar.xz", "e".repeat(64), "Template"), asset("Template-1.0.21.tar.xz", "f".repeat(64), "Template")];
  const rows = await discover(t, { Engines: [release(engineAssets)], Template: [release(support)] });
  assert.deepEqual(rows.map(row => row.engineVersion), ["11.0_2", "11.0_1", "10.0_8"]);
  assert.ok(rows.every(row => row.template.version === "1.0.21"));
  assert.match(rows[0].version, /^11\.0_2-template-1\.0\.21-[a-f0-9]{24}$/);
  assert.ok(rows[0].version.length < 60);
  assert.equal(rows[0].asset.sha256, "c".repeat(64));
  assert.equal(rows[0].template.asset.sha256, "f".repeat(64));
  assert.equal(rows[0].versionLabel, "Wine 11.0 (rev 2) · Template 1.0.21");
  assert.match(rows[0].upstreamRevision, /^WS12WineSikarugir11\.0_2:sha256:/);
  const updatedSupport = { version: "1.0.21", asset: { sha256: "1".repeat(64) } };
  assert.notEqual(rows[0].version, Catalog.snapshotVersion("11.0_2", "c".repeat(64), updatedSupport));
  assert.notEqual(rows[0].version, Catalog.snapshotVersion("11.0_2", "d".repeat(64), rows[0].template));
  // Published versions keep the folder names earlier installations use.
  const earlier = (engine, id, support) => `${engine}-template-${support.version}-` + crypto.createHash("sha256")
    .update(JSON.stringify([engine, id, support.version, support.asset.sha256])).digest("hex").slice(0, 24);
  assert.equal(Catalog.snapshotVersion("11.0_2", "c".repeat(64), updatedSupport), earlier("11.0_2", "c".repeat(64), updatedSupport));
  // Any other version text becomes one safe folder name instead of an error.
  const encoded = Catalog.snapshotVersion("../engine/11:0", "c".repeat(64), { version: "1.0 beta/2", asset: {} });
  assert.match(encoded, /^engine-11-0-template-1\.0-beta-2-[a-f0-9]{24}$/);
  assert.equal(path.basename(encoded), encoded);
  assert.notEqual(encoded, Catalog.snapshotVersion("../engine/11-0", "c".repeat(64), { version: "1.0 beta/2", asset: {} }));
});

test("Sikarugir needs a support archive and lists an engine without a publisher digest by its listed identity", async t => {
  await assert.rejects(discover(t, { Engines: [release([asset("WS12WineSikarugir11.0_1.tar.xz")])], Template: [] }), /No compatible/);
  const undigested = asset("WS12WineSikarugir11.0_1.tar.xz"); undigested.digest = null;
  const [row, ...others] = await discover(t, { Engines: [release([undigested, asset("unrelated.zip")])],
    Template: [release([asset("Template-1.0.21.tar.xz", "b".repeat(64), "Template")])] });
  assert.deepEqual(others, []);
  assert.equal(row.engineVersion, "11.0_1"); assert.equal(row.asset.sha256, undefined); assert.equal(row.asset.integrity, "recorded-local");
  assert.equal(row.asset.bytes, 42); assert.ok(Catalog.validateEntry(row));
  assert.match(row.upstreamRevision, /^WS12WineSikarugir11\.0_1:/);
});

test("Sikarugir selection stays offline and failed Refresh preserves exact choices", async t => {
  const root = temporary(t); let calls = 0;
  const manager = fixtureManager({discoverCatalog:async()=>{calls++;throw new Error("GitHub releases fetch failed (403)");}});
  assert.deepEqual(manager.getState({userDataDir:root}).catalog.versions,[]);
  const unselected = manager.resolveSelection({}, {}, root);
  assert.equal(unselected.version,null);assert.equal(unselected.discoveryRequired,true,"no fixed version stands in for the upstream list");
  assert.equal((await manager.resolveForPlay({}, {userDataDir:root,settings:{}})).discoveryRequired,true);
  assert.equal(calls,0,"status and an unselected Play stay offline until the consented preparation discovers versions");
  const pin=fixturePin("10.0_8");manager.core.rememberResolvedVersion({userDataDir:root,entry:pin});
  const entry={runtimeData:{sikarugir:{version:pin.version}}};
  const exact=await manager.resolveForPlay(entry,{userDataDir:root,settings:{}});
  assert.equal(exact.version,pin.version);assert.equal(exact.artifacts.length,2);
  assert.match(exact.detail,/engine.*support libraries/);assert.equal(calls,0,"A known Play choice also stays offline before consent");
  await assert.rejects(manager.refreshCatalog({userDataDir:root,force:true}),/403/);
  assert.equal(manager.getState({userDataDir:root}).catalog.status,"error");
  assert.equal(manager.resolveSelection(entry,{},root).version,pin.version);
  assert.equal(fixtureManager().resolveSelection(entry,{},root).version,pin.version, "A new manager reads the retained exact identity offline");
  assert.equal(calls,1);assert.equal(manager.ui.management,"managed");
  const controller=new AbortController();controller.abort();
  await assert.rejects(manager.resolveForPlay({}, {userDataDir:root,settings:{},signal:controller.signal}),{name:"AbortError"});
});

test("Sikarugir lists published choices and preserves committed defaults and selection layers", async t => {
  const root=temporary(t),latest=fixturePin("11.0_2"),previous=fixturePin("10.0_8"),manager=fixtureManager({rows:[latest,previous]});
  await manager.refreshCatalog({userDataDir:root,force:true});
  const state=manager.getState({userDataDir:root});
  assert.deepEqual(new Set(state.catalog.versions),new Set([latest.version,previous.version]));
  const unselected = manager.resolveSelection({}, {}, root);
  assert.equal(unselected.version,latest.version,"the manager default is the newest listed engine");
  const settings={runtimes:{sikarugir:{defaultVersion:latest.version}}};
  assert.equal(manager.resolveSelection({},settings,root).version,latest.version);
  assert.equal(manager.resolveSelection({runtimeData:{sikarugir:{version:previous.version}}},settings,root).version,previous.version);
  assert.equal(manager.resolveSelection({},settings,root,{version:previous.version}).version,previous.version);
  assert.equal(manager.resolveSelection({},settings,root,{recommendedVersion:previous.version}).version,previous.version,
    "an actual game/API recommendation precedes the saved global");
  assert.equal(manager.resolveSelection({runtimeData:{sikarugir:{version:latest.version}}},settings,root,
    {recommendedVersion:previous.version}).version,latest.version,"the game's manual choice precedes its recommendation");
  assert.equal(manager.resolveSelection({}, {runtimes:{sikarugir:{defaultVersion:null}}}, root).version,latest.version);
  assert.equal(manager.resolveSelection({}, {runtimes:{sikarugir:{defaultVersion:"10.0_8-template-1.0.21-removed"}}}, root).version,latest.version,
    "a saved default that left the list and is not installed gives way to the newest listed engine");
});

test("Sikarugir installs paired archives atomically with one progress total and preserves old selections", async t => {
  const root = temporary(t), old = fixturePin(), newer = fixturePin("11.0_2"); let rows = [old], downloads = 0, discoveries = 0;
  for (const url of [old.asset.url, old.template.asset.url]) { const bytes = served[url]; served[url] = () => { downloads++; return bytes; }; }
  const manager = fixtureManager({ discoverCatalog: async () => { discoveries++; return rows; } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const progress = [], installed = await manager.core.installVersion({ userDataDir: root, version: old.version, onProgress: row => progress.push(row) });
  assert.equal(downloads, 2); assert.ok(progress.every(row => row.total === old.downloadBytes));
  assert.equal(progress.at(-1).downloaded, old.downloadBytes);
  assert.ok(progress.every((row, index) => index === 0 || row.downloaded >= progress[index - 1].downloaded));
  assert.ok(progress.some(row => row.detail?.endsWith("Extracting Wine engine…")));
  for (const step of ["Extracting support libraries…", "Preparing graphics libraries…", "Checking installed files…"]) {
    const row = progress.find(item => item.detail?.endsWith(step));
    assert.equal(row?.downloaded, old.downloadBytes); assert.equal(row?.total, old.downloadBytes);
  }
  assert.equal(installed.wineRoot, path.join(installed.installDir, "wswine.bundle"));
  assert.equal(installed.templateRoot, path.join(installed.installDir, "support"));
  assert.ok(path.join(installed.wineRoot, "lib", "wine", "x86_64-windows").length < 260);
  assert.deepEqual(installed.capabilities, { msync: true, esync: false });
  assert.equal(installed.minimumMacOS, "14.0.0"); // Optional renderer is macOS26.
  assert.equal(manager.getState({ userDataDir: root }).installed[0].ready, true);
  assert.equal(fs.existsSync(path.join(installed.installDir, "Template-1.0.21.app")), false);
  const before = discoveries;
  assert.equal((await manager.resolveForPlay({ runtimeData: { sikarugir: { version: old.version } } }, { userDataDir: root, settings: {} })).ready, true);
  assert.equal(discoveries, before); assert.equal(downloads, 2);
  rows = [newer]; await manager.refreshCatalog({ userDataDir: root, force: true });
  const restarted = fixtureManager({ rows: [newer] });
  assert.deepEqual(restarted.getState({ userDataDir: root }).catalog.versions, [newer.version]);
  assert.ok(restarted.getState({ userDataDir: root }).installed.some(row => row.version === old.version && row.ready), "The retired installed engine remains usable offline");
  assert.equal(restarted.resolveSelection({}, { runtimes: { sikarugir: { defaultVersion: old.version } } }, root).version, old.version);
  assert.equal(restarted.resolveSelection({ runtimeData: { sikarugir: { version: newer.version } } }, { runtimes: { sikarugir: { defaultVersion: old.version } } }, root).version, newer.version);
});

test("Sikarugir names the translator versions of an installed engine and of listed engines with the same Template release", async t => {
  const { peFixture } = require("./helpers/pe-fixture");
  const root = temporary(t), installed = fixturePin(), sameTemplate = fixturePin("10.0_8");
  const other = fixturePin("11.0_2", Buffer.from("engine archive"), Buffer.from("newer support archive"), "1.0.24");
  const library = peFixture({ is64: true }).bytes; library.write("Wine builtin DLL\0", 64);
  const manager = fixtureManager({ rows: [installed, sameTemplate, other], dependencies: { stageTemplateClosure: async options => {
    const metadata = stage(options), renderer = path.join(options.destinationRoot, "Frameworks", "renderer", "dxmt");
    write(path.join(renderer, "version"), "v0.80-244-g7c8dee1\n"); write(path.join(renderer, "wine", "x86_64-windows", "d3d11.dll"), library);
    return metadata;
  } } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  await manager.core.installVersion({ userDataDir: root, version: installed.version });
  assert.equal(manager.getState({ userDataDir: root }).installed[0].componentSummary, undefined, "a state reads retained descriptions only");
  await manager.prepareLocalState({ userDataDir: root, logger: { warn() {} } });
  const state = manager.getState({ userDataDir: root }), requirements = state.catalog.versionRequirements;
  assert.match(state.installed[0].componentSummary, /(?:^| · )DXMT 0\.80-244-g7c8dee1(?: · |$)/);
  assert.equal(requirements[sameTemplate.version].contents, `Includes ${state.installed[0].componentSummary}.`);
  assert.equal(requirements[other.version].contents, "The translator versions in Template 1.0.24 are known after download.");
});

test("Sikarugir download tasks display readable version labels while retaining the exact identifier", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  let metadata;
  await manager.installRuntime({ userDataDir: root, version: row.version, downloads: {
    runTask: async (meta, runner) => { metadata = meta; return runner({ signal: null, onProgress: () => {} }); }
  } });
  assert.equal(metadata.version, row.version); assert.equal(metadata.detail, row.versionLabel);
  assert.equal(metadata.detail, "Wine 11.0 (rev 1) · Template 1.0.21");
});

test("Sikarugir rejects support checksum mismatch and cancellation without publishing partial installs", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row] });
  const runtimeRoot = path.join(root, "runtimes", "sikarugir");
  const readCatalogs = () => {
    const names = ["catalog-arm64.json", "catalog-x64.json"];
    if (fs.existsSync(path.join(runtimeRoot, "catalog.json"))) names.push("catalog.json");
    return new Map(names.map(name => [name, fs.readFileSync(path.join(runtimeRoot, name))]));
  };
  const assertNoPartialInstalls = catalogs => {
    const entries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
    assert.deepEqual(entries.filter(entry => entry.isFile()).map(entry => entry.name).sort(), [...catalogs.keys()].sort());
    for (const entry of entries) {
      const file = path.join(runtimeRoot, entry.name);
      if (catalogs.has(entry.name)) {
        assert.ok(entry.isFile(), `${entry.name} remains a regular catalog file`);
        assert.deepEqual(fs.readFileSync(file), catalogs.get(entry.name), "failed installation preserves release metadata");
      } else {
        assert.ok(["arm64", "x64"].includes(entry.name) && entry.isDirectory(), `unexpected installation output: ${entry.name}`);
        assert.deepEqual(fs.readdirSync(file), [], `${entry.name} contains neither installed versions nor partial staging`);
      }
    }
  };
  await manager.refreshCatalog({ userDataDir: root, force: true });
  for (const architecture of ["arm64", "x64"]) {
    const catalogs = readCatalogs();
    served[row.template.asset.url] = Buffer.from("broken support!");
    await assert.rejects(manager.core.installVersion({ userDataDir: root, version: row.version, architecture }), /Template-1\.0\.21\.tar\.xz does not match the checksum its publisher lists/);
    served[row.template.asset.url] = Buffer.from("support archive");
    assertNoPartialInstalls(catalogs);
    const controller = new AbortController();
    const cancelling = fixtureManager({ rows: [row], dependencies: { stageTemplateClosure: async options => { stage(options); controller.abort(); return {}; } } });
    await cancelling.refreshCatalog({ userDataDir: root, force: true });
    const refreshedCatalogs = readCatalogs();
    await assert.rejects(cancelling.core.installVersion({ userDataDir: root, version: row.version, architecture, signal: controller.signal }), { name: "AbortError" });
    assertNoPartialInstalls(refreshedCatalogs);
  }
});

test("Sikarugir full preparation detects native, resource and added-file changes", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const install = await manager.core.installVersion({ userDataDir: root, version: row.version });
  const resource = path.join(install.wineRoot, "lib", "wine", "i386-windows", "kernel32.dll");
  fs.writeFileSync(resource, "Changed resources");
  assert.equal(manager.core.resolveInstalled({ userDataDir: root, version: row.version }), null);
  fs.writeFileSync(resource, "Windows resources");
  assert.ok(manager.core.resolveInstalled({ userDataDir: root, version: row.version }));
  write(path.join(install.wineRoot, "extra.dll"), "extra");
  assert.equal(manager.core.resolveInstalled({ userDataDir: root, version: row.version }), null);
  fs.rmSync(path.join(install.wineRoot, "extra.dll"));
  const bytes = fs.readFileSync(install.serverPath); bytes[511] ^= 1; fs.writeFileSync(install.serverPath, bytes);
  assert.equal(manager.getState({ userDataDir: root }).installed[0].ready, false);
  assert.equal(manager.core.resolveInstalled({ userDataDir: root, version: row.version }), null);
});

test("Sikarugir observed base closure gates older hosts without treating optional renderers as prerequisites", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  await manager.core.installVersion({ userDataDir: root, version: row.version });
  const older = fixtureManager({ rows: [row], dependencies: { systemVersionSync: () => "13.6" } });
  assert.equal(older.getState({ userDataDir: root }).installed[0].ready, false);
  assert.match(older.resolveSelection({}, {}, root, {version:row.version}).reason, /macOS 14/);
  const bad = fixtureManager({ rows: [row], dependencies: { stageTemplateClosure: async options => stage(options, { dependency: "/opt/homebrew/lib/private.dylib" }) } });
  const other = path.join(root, "external"); await bad.refreshCatalog({ userDataDir: other, force: true });
  await assert.rejects(bad.core.installVersion({ userDataDir: other, version: row.version }), /external native library/);
});

function tarFixture(file, members) {
  const python = Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
  const script = "import sys,tarfile,io,json\nwith tarfile.open(sys.argv[1],'w:xz') as t:\n for item in json.loads(sys.argv[2]):\n  m=tarfile.TarInfo(item['name']); m.mode=0o755\n  if 'link' in item: m.type=tarfile.SYMTYPE; m.linkname=item['link']; t.addfile(m)\n  else:\n   b=item.get('data','ok').encode(); m.size=len(b); t.addfile(m,io.BytesIO(b))\n";
  const result = spawnSync(python, ["-I", "-B", "-c", script, file, JSON.stringify(members)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
test("Sikarugir archive validation prevents traversal and aliases before writing any files", async t => {
  const root = temporary(t);
  for (const [index, malicious] of [
    { name: "../outside", data: "escape" }, { name: "engine/alias", link: "../../outside" },
    { name: "engine/alias/file", data: "escape" }
  ].entries()) {
    const archive = path.join(root, `bad-${index}.tar.xz`), destination = path.join(root, `out-${index}`);
    fs.mkdirSync(destination); tarFixture(archive, [{ name: "engine/good" }, ...(index === 2 ? [{ name: "engine/alias", link: "good" }] : []), malicious]);
    await assert.rejects(extractArchive(archive, destination), /escapes|writes through/);
    assert.deepEqual(fs.readdirSync(destination), []); assert.equal(fs.existsSync(path.join(root, "outside")), false);
  }
});
test("Sikarugir archive extraction preserves safe framework links and handles cancellation", async t => {
  const root = temporary(t), archive = path.join(root, "safe.tar.xz"), destination = path.join(root, "out");
  fs.mkdirSync(destination); tarFixture(archive, [
    { name: "engine/Versions/A/library", data: "library" }, { name: "engine/Versions/Current", link: "A" },
    { name: "engine/library", link: "Versions/Current/library" }
  ]);
  await extractArchive(archive, destination);
  assert.equal(fs.readFileSync(path.join(destination, "engine", "library"), "utf8"), "library");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractArchive(archive, destination, controller.signal), { name: "AbortError" });
});

test("Sikarugir core installation uses the effective catalog default rather than a fixed package", async t => {
  const root = temporary(t), old = fixturePin(), newest = fixturePin("11.0_2");
  const manager = fixtureManager({rows:[newest,old]});
  await manager.refreshCatalog({userDataDir:root,force:true});
  const automatic = await manager.core.installVersion({userDataDir:root,settings:{defaultVersion:null}});
  assert.equal(automatic.version,newest.version);
  const saved = await manager.core.installVersion({userDataDir:root,settings:{defaultVersion:old.version}});
  assert.equal(saved.version,old.version);
});
