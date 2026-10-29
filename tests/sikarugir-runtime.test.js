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
  const metadata = { relativePaths: { frameworks: "Frameworks" }, minimumBaseMacOS: "14.0.0",
    componentVersions: { d3dmetal: "4.0" }, graphicsCapabilities: { d3dmetal: true, minimumMacOS: { d3dmetal: "26.4.0" } } };
  write(path.join(destinationRoot, "graphics.json"), JSON.stringify(metadata)); return metadata;
}
function fixturePin(engineVersion = "11.0_1", engineBytes = Buffer.from("engine archive"), templateBytes = Buffer.from("support archive")) {
  const template = { version: "1.0.21", minimumMacOS: "14.0", asset: {
    filename: "Template-1.0.21.tar.xz", url: "https://github.com/Sikarugir-App/Template/releases/download/v1.0/Template-1.0.21.tar.xz",
    sha256: sha(templateBytes), bytes: templateBytes.length } };
  return Catalog.entryFor(Catalog.parseEngineName(`WS12WineSikarugir${engineVersion}.tar.xz`),
    { filename: `WS12WineSikarugir${engineVersion}.tar.xz`,
      url: `https://github.com/Sikarugir-App/Engines/releases/download/v1.0/WS12WineSikarugir${engineVersion}.tar.xz`,
      sha256: sha(engineBytes), bytes: engineBytes.length }, template);
}
function fixtureManager({ rows, dependencies = {}, discoverCatalog } = {}) {
  const engineBytes = Buffer.from("engine archive"), templateBytes = Buffer.from("support archive");
  return createManager({ discoverCatalog: discoverCatalog || (async () => rows || [fixturePin()]), dependencies: {
    systemVersionSync: () => "14.0", downloadToFile: async (url, destination, { onProgress } = {}) => {
      const bytes = url.includes("/Template/") ? templateBytes : engineBytes;
      fs.writeFileSync(destination, bytes); onProgress?.({ downloaded: bytes.length, total: bytes.length });
    }, extractArchive: async (archive, root) => { if (path.basename(archive).startsWith("Template-")) fs.mkdirSync(path.join(root, "Template-1.0.21.app", "Contents"), { recursive: true }); else engine(root); },
    stageTemplateClosure: async options => stage(options), ...dependencies
  } });
}

test("Sikarugir discovers all compatible engine assets and identifies both archives", async () => {
  const engineAssets = [asset("WS12WineSikarugir10.0_8.tar.xz"), asset("WS12WineSikarugir11.0_1.tar.xz", "b".repeat(64)),
    asset("WS12WineSikarugir11.0_2.tar.xz", "c".repeat(64)), asset("WS12WineCX24.0.7_7.tar.xz"),
    asset("WS11WineSikarugir11.0_1.tar.xz"), asset("WS12WineSikarugir10.0_7.tar.xz"),
    asset("WS12WineSikarugir11.0_3.tar.xz", "d".repeat(64), "Elsewhere")];
  const support = [asset("Template-1.0.19.tar.xz", "e".repeat(64), "Template"), asset("Template-1.0.21.tar.xz", "f".repeat(64), "Template")];
  const rows = await Catalog.createDiscovery({ fetchGithubReleases: async ({ repo, maxPages }) => {
    assert.equal(maxPages, 5); return [release(repo === "Engines" ? engineAssets : support)];
  } })();
  assert.deepEqual(rows.map(row => row.engineVersion), ["11.0_2", "11.0_1", "10.0_8"]);
  assert.ok(rows.every(row => row.template.version === "1.0.21"));
  assert.match(rows[0].version, /^11\.0_2-template-1\.0\.21-[a-f0-9]{24}$/);
  assert.ok(rows[0].version.length < 60);
  assert.equal(rows[0].asset.sha256, "c".repeat(64));
  assert.equal(rows[0].template.asset.sha256, "f".repeat(64));
  assert.match(rows[0].versionLabel, /support 1\.0\.21 \(ffffffff\)/);
  assert.match(rows[0].upstreamRevision, /^WS12WineSikarugir11\.0_2:sha256:/);
  const updatedSupport = { version: "1.0.21", asset: { sha256: "1".repeat(64) } };
  assert.notEqual(rows[0].version, Catalog.snapshotVersion("11.0_2", "c".repeat(64), updatedSupport));
  assert.notEqual(rows[0].version, Catalog.snapshotVersion("11.0_2", "d".repeat(64), rows[0].template));
  assert.throws(() => Catalog.snapshotVersion("../engine", "c".repeat(64), updatedSupport), /identified/);
});

test("Sikarugir rejects missing support identities, invalid assets and oversized catalogs", async () => {
  const discover = releases => Catalog.createDiscovery({ fetchGithubReleases: async ({ repo }) => releases[repo] });
  await assert.rejects(discover({ Engines: [release([asset("WS12WineSikarugir11.0_1.tar.xz")])], Template: [] })(), /No compatible/);
  const invalid = asset("WS12WineSikarugir11.0_1.tar.xz"); invalid.digest = null;
  assert.deepEqual(await discover({ Engines: [release([invalid])], Template: [release([asset("Template-1.0.21.tar.xz", "b".repeat(64), "Template")])] })(), []);
  const many = Array.from({ length: 6 }, () => release(Array.from({ length: 500 }, () => asset("unrelated.zip"))));
  await assert.rejects(discover({ Engines: many, Template: [release([asset("Template-1.0.21.tar.xz", "b".repeat(64), "Template")])] })(), /supported size/);
});

test("Sikarugir selection stays offline and failed Refresh preserves exact choices", async t => {
  const root = temporary(t); let calls = 0;
  const manager = fixtureManager({discoverCatalog:async()=>{calls++;throw new Error("GitHub releases fetch failed (403)");}});
  assert.deepEqual(manager.getState({userDataDir:root}).catalog.versions,[]);
  assert.equal(manager.resolveSelection({}, {}, root).version,require("../src/modules/crossover/sikarugir/runtime/manager").DEFAULT_VERSION);
  assert.equal(calls,0);
  await assert.rejects(manager.resolveForPlay({}, {userDataDir:root,settings:{}}),/403/);
  assert.equal(calls,1,"Play refreshes a missing committed default, while status stays offline");
  const pin=fixturePin("10.0_8");manager.core.rememberResolvedVersion({userDataDir:root,entry:pin});
  const entry={runtimeData:{sikarugir:{version:pin.version}}};
  const exact=await manager.resolveForPlay(entry,{userDataDir:root,settings:{}});
  assert.equal(exact.version,pin.version);assert.equal(exact.artifacts.length,2);
  assert.match(exact.detail,/engine.*support libraries/);assert.equal(calls,2);
  await assert.rejects(manager.refreshCatalog({userDataDir:root,force:true}),/403/);
  assert.equal(manager.getState({userDataDir:root}).catalog.status,"error");
  assert.equal(manager.resolveSelection(entry,{},root).version,pin.version);
  assert.equal(fixtureManager().resolveSelection(entry,{},root).version,pin.version, "A new manager reads the retained exact identity offline");
  assert.equal(calls,3);assert.equal(manager.ui.management,"managed");
  const controller=new AbortController();controller.abort();
  await assert.rejects(manager.resolveForPlay({}, {userDataDir:root,settings:{},signal:controller.signal}),{name:"AbortError"});
});

test("Sikarugir lists published choices and preserves committed defaults and selection layers", async t => {
  const root=temporary(t),latest=fixturePin("11.0_2"),previous=fixturePin("10.0_8"),manager=fixtureManager({rows:[latest,previous]});
  await manager.refreshCatalog({userDataDir:root,force:true});
  const state=manager.getState({userDataDir:root});
  assert.deepEqual(new Set(state.catalog.versions),new Set([latest.version,previous.version]));
  const unselected = manager.resolveSelection({}, {}, root);
  assert.equal(unselected.version,require("../src/modules/crossover/sikarugir/runtime/manager").DEFAULT_VERSION);
  assert.equal(unselected.discoveryRequired,true,"the initial default does not seed an archive into the catalog");
  const settings={runtimes:{sikarugir:{defaultVersion:latest.version}}};
  assert.equal(manager.resolveSelection({},settings,root).version,latest.version);
  assert.equal(manager.resolveSelection({runtimeData:{sikarugir:{version:previous.version}}},settings,root).version,previous.version);
  assert.equal(manager.resolveSelection({},settings,root,{version:previous.version}).version,previous.version);
  assert.equal(manager.resolveSelection({},settings,root,{recommendedVersion:previous.version}).version,previous.version,
    "an actual game/API recommendation precedes the saved global");
  assert.equal(manager.resolveSelection({runtimeData:{sikarugir:{version:latest.version}}},settings,root,
    {recommendedVersion:previous.version}).version,latest.version,"the game's manual choice precedes its recommendation");
  assert.equal(manager.resolveSelection({}, {runtimes:{sikarugir:{defaultVersion:null}}}, root).version,null);
});

test("Sikarugir installs paired archives atomically with one progress total and preserves old selections", async t => {
  const root = temporary(t), old = fixturePin(), newer = fixturePin("11.0_2"); let rows = [old], downloads = 0, discoveries = 0;
  const manager = fixtureManager({ discoverCatalog: async () => { discoveries++; return rows; }, dependencies: {
    downloadToFile: async (url, file, { onProgress } = {}) => {
      downloads++; const bytes = Buffer.from(url.includes("/Template/") ? "support archive" : "engine archive");
      fs.writeFileSync(file, bytes); onProgress?.({ downloaded: bytes.length, total: bytes.length });
    } } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const progress = [], installed = await manager.core.installVersion({ userDataDir: root, version: old.version, onProgress: row => progress.push(row) });
  assert.equal(downloads, 2); assert.ok(progress.every(row => row.total === old.downloadBytes));
  assert.equal(progress.at(-1).downloaded, old.downloadBytes);
  assert.ok(progress.every((row, index) => index === 0 || row.downloaded >= progress[index - 1].downloaded));
  assert.ok(progress.some(row => row.detail?.endsWith("Extracting Wine engine…")));
  for (const step of ["Verifying support archive…", "Extracting support libraries…", "Preparing graphics libraries…", "Checking installed files…"]) {
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

test("Sikarugir download tasks display readable version labels while retaining the exact identifier", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row] });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  let metadata;
  await manager.installRuntime({ userDataDir: root, version: row.version, downloads: {
    runTask: async (meta, runner) => { metadata = meta; return runner({ signal: null, onProgress: () => {} }); }
  } });
  assert.equal(metadata.version, row.version); assert.equal(metadata.detail, row.versionLabel);
  assert.match(metadata.detail, /revision 1.*support 1\.0\.21/);
});

test("Sikarugir rejects support checksum mismatch and cancellation without publishing partial installs", async t => {
  const root = temporary(t), row = fixturePin(), manager = fixtureManager({ rows: [row], dependencies: {
    downloadToFile: async (url, file) => fs.writeFileSync(file, Buffer.from(url.includes("/Template/") ? "broken support!" : "engine archive")) } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  await assert.rejects(manager.core.installVersion({ userDataDir: root, version: row.version }), /support archive.*checksum/);
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "sikarugir")).filter(name => name !== "catalog.json"), []);
  const controller = new AbortController();
  const cancelling = fixtureManager({ rows: [row], dependencies: { stageTemplateClosure: async options => { stage(options); controller.abort(); return {}; } } });
  await cancelling.refreshCatalog({ userDataDir: root, force: true });
  await assert.rejects(cancelling.core.installVersion({ userDataDir: root, version: row.version, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(path.join(root, "runtimes", "sikarugir")).filter(name => name !== "catalog.json"), []);
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
