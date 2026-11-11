// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Tools = require("../src/modules/scummvm/tools");
const { createManager } = require("../src/modules/scummvm/runtime/tools-manager");
const Module = require("../src/modules/scummvm/main");
const { stoppedDownloads, assertConsentedDiscovery, assertReceiptOffline } = require("./helpers/catalog-only-runtime.cjs");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scummvm-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function stk(name = "INTRO.TOT") {
  const data = Buffer.alloc(28); data.writeUInt16LE(1); data.write(name, 2, 13, "latin1");
  data.writeUInt32LE(4, 15); data.writeUInt32LE(24, 19); data.write("data", 24); return data;
}
function pak(name = "INTRO.EMC") {
  const first = 4 + Buffer.byteLength(name) + 1 + 4, data = Buffer.alloc(first + 4);
  data.writeUInt32LE(first); data.write(name, 4, "latin1"); data.write("data", first); return data;
}
test("ScummVM tools reject archive traversal and malformed tables before invoking downloaded tools", t => {
  const root = temporary(t), gob = path.join(root, "intro.stk"), kyra = path.join(root, "intro.pak");
  fs.writeFileSync(gob, stk()); assert.equal(Tools.validateArchive(gob, "extract_gob_stk"), 1);
  fs.writeFileSync(kyra, pak()); assert.equal(Tools.validateArchive(kyra, "extract_kyra"), 1);
  fs.writeFileSync(gob, stk("../escape")); assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /unsafe/);
  fs.writeFileSync(kyra, pak("..\\escape")); assert.throws(() => Tools.validateArchive(kyra, "extract_kyra"), /unsafe/);
  const invalid = stk(); invalid.writeUInt32LE(1000, 19); fs.writeFileSync(gob, invalid);
  assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /invalid/);
  const compressed = Buffer.concat([stk(), Buffer.alloc(4)]); compressed[23] = 1; compressed.writeUInt32LE(8, 15); compressed.writeUInt32LE(0xffffffff, 24);
  fs.writeFileSync(gob, compressed); assert.throws(() => Tools.validateArchive(gob, "extract_gob_stk"), /size is invalid/);
});
test("ScummVM detects a Gob intro script packed inside the intro archive", t => {
  const root = temporary(t); fs.writeFileSync(path.join(root, "INTRO.STK"), stk());
  const detected = Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) });
  assert.equal(detected.moduleData.sourceKind, "Gob"); assert.equal(detected.moduleData.archiveToolCount, 1);
  fs.writeFileSync(path.join(root, "INTRO.STK"), stk("OTHER.TOT"));
  assert.equal(Module.detectGame({ inputPath: root, rootDir: root, stat: fs.statSync(root) }), null);
});
function release(version, sha256 = "b".repeat(64), upstreamRevision = "a".repeat(40)) {
  return { version, upstreamRevision, minimumMacOS: "10.9", localBuild: false,
    asset: { filename: `scummvm-tools-${version}-macosx.dmg`, url: `https://downloads.scummvm.org/frs/scummvm-tools/${version}/scummvm-tools-${version}-macosx.dmg`, sha256 } };
}
const TOOLS = "https://downloads.scummvm.org/frs/scummvm-tools/";
function serve(pins) {
  const routes = { [TOOLS]: pins.map(pin => `<a href="${pin.version}/">${pin.version}</a>`).join("") };
  for (const pin of pins) {
    routes[`${TOOLS}${pin.version}/`] = `<a href="${pin.asset.filename}">x</a><a href="${pin.asset.filename}.sha256">x</a>`;
    routes[`${TOOLS}${pin.version}/${pin.asset.filename}.sha256`] = `${pin.asset.sha256}  ${pin.asset.filename}\n`;
  }
  return routes;
}
const listings = () => Harness.network.requests.filter(url => url === TOOLS).length;
test("ScummVM Tools share native Builds defaults, alternate CPU catalogs and saved upstream choices", {skip: process.platform !== "darwin"}, async t => {
  const Architecture = require("../src/modules/shared/runtime/architecture");
  const {nativeTool, packageFor} = require("./helpers/managed-tool-fixture.cjs");
  const root = temporary(t), version = "2.9.0-MCLv1", revision = "a".repeat(40), packages = {};
  for (const architecture of ["arm64", "x64"]) {
    const native = nativeTool(path.join(root, architecture, "native"), "", {architecture});
    const built = packageFor(path.join(root, architecture, "package"), {id: "scummvm-tools", version, architecture, filesPrefix: "files/",
      manifest: {managerId: "scummvm-tools", upstreamRevision: revision, platform: "darwin", executableRelative: "bin/scummvm-tools-cli",
        provenance: {sourceRevision: revision}, dependencies: []},
      entries: [{path: "bin/scummvm-tools-cli", bytes: native.binary, mode: 0o755,
        architectures: [architecture === "x64" ? "x86_64" : architecture]}]});
    built.record.source = {repository: "scummvm/scummvm-tools", revision};
    packages[architecture] = built;
  }
  const catalog = {schemaVersion: 2, projectId: "scummvm-tools", updatePolicy: "manual", packages: [packages.x64.record, packages.arm64.record]};
  let offline = false, downloads = 0, catalogReads = 0;
  const dependencies = {systemVersionSync: () => "27.0", projectBuilds: {fetchUrlBuffer: async () => {
    assert.equal(offline, false, "Status/reopening must not refresh Builds"); catalogReads++;
    return {status: 200, body: Buffer.from(JSON.stringify(catalog))};
  }}, downloadToFile: async (url, destination) => {
    assert.equal(offline, false, "Reopening must not download"); downloads++;
    const item = Object.values(packages).find(item => item.record.asset.url === url); assert.ok(item);
    fs.copyFileSync(item.archive, destination);
  }};
  Harness.network.routes = serve([release("5.0.0")]);
  t.after(() => {Harness.network.routes = null;});
  for (const architecture of ["arm64", "x64"]) await Architecture.withArchitecture(architecture, async () => {
    const userDataDir = path.join(root, "profile-" + architecture), manager = createManager({dependencies});
    await manager.refreshCatalog({userDataDir, force: true});
    const state = manager.getState({userDataDir});
    assert.equal(manager.resolveSelection({}, {}, userDataDir).version, version, "Known native Builds code precedes an unknown-CPU upstream download");
    assert.deepEqual(state.catalog.sources.map(source => source.id), ["builds", "upstream"]);
    assert.ok(state.catalog.sources.find(source => source.id === "upstream").versions.includes("5.0.0"));
    assert.equal(state.catalog.architectureCatalogs[architecture].versionRequirements[version].architecture, architecture);
    assert.equal(state.catalog.architectureCatalogs[architecture === "arm64" ? "x64" : "arm64"].versionRequirements[version].architecture,
      architecture === "arm64" ? "x64" : "arm64");
    const saved = {runtimes: {"scummvm-tools": {defaultVersion: "5.0.0"}}};
    assert.equal(manager.resolveSelection({}, saved, userDataDir).version, "5.0.0");
    const installed = await manager.installRuntime({userDataDir});
    assert.equal(installed.architecture, architecture);
    offline = true; const before = [catalogReads, downloads, Harness.network.requests.length];
    const reopened = createManager({dependencies});
    assert.equal(reopened.resolveSelection({}, {}, userDataDir).ready, true);
    // The saved upstream default is not installed, so Play uses the installed Builds version.
    const preferred = reopened.resolveSelection({}, saved, userDataDir);
    assert.deepEqual([preferred.version, preferred.ready, preferred.preferredVersion], [installed.version, true, "5.0.0"]);
    assert.deepEqual([catalogReads, downloads, Harness.network.requests.length], before);
    offline = false;
  });
  assert.equal(downloads, 2);
});
test("ScummVM tools remain offline until refresh and use an independent selected version", async t => {
  const root = temporary(t), start = listings();
  const manager = createManager();
  assert.equal(manager.resolveSelection({}, {}, root).discoveryRequired, true); assert.equal(listings(), start);
  Harness.network.routes = serve(["3.1.0", "2.7.0"].map(version => release(version)));
  try { await manager.refreshCatalog({ userDataDir: root, force: true }); } finally { Harness.network.routes = null; }
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.versions, ["3.1.0", "2.7.0"]);
  const entry = { runtimeData: { scummvm: { version: "2026.4.0" }, "scummvm-tools": { version: "2.7.0" } } };
  assert.equal(manager.resolveSelection(entry, {}, root).version, "2.7.0");
});
test("ScummVM tools discover inside a consented install and keep earlier installations offline", { skip: process.platform !== "darwin" }, async t => {
  const downloads = stoppedDownloads(), start = listings();
  const manager = createManager({ dependencies: { downloadToFile: downloads.downloadToFile } });
  Harness.network.routes = serve([release("2.9.0"), release("3.1.0")]);
  t.after(() => { Harness.network.routes = null; });
  await assertConsentedDiscovery({ manager, userDataDir: temporary(t), discoveries: () => listings() - start, downloads, newestUrl: release("3.1.0").asset.url });
  Harness.network.routes = null;
  assertReceiptOffline({ manager: createManager(), userDataDir: temporary(t),
    pin: release("2.9.0", "fa7f4962203f6c52702429adf7a7f2bc6b64edcfb045948dab990c5e380220f4", "516246735618120eb9439cb9673a32430c18d604") });
});
test("ScummVM extraction writes only private output and preserves earlier output after failure", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "INTRO.STK"), stk());
  const entry = { gameId: "fixture", gamePath: source, contentRootDir: source, moduleData: {} }, context = { userDataDir: path.join(root, "profile"), settings: {} };
  const dependencies = { ensureTools: async () => ({ version: "2.9.0", install: { executablePath: path.join(root, "scummvm-tools-cli"), needsRosetta: false } }),
    runCommand: async (_cmd, args) => fs.writeFileSync(path.join(args[args.indexOf("-o") + 1], "INTRO.TOT"), "extracted script") };
  const result = await Tools.extractArchives(entry, {}, context, dependencies);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "INTRO.STK", "INTRO.TOT"), "utf8"), "extracted script");
  assert.deepEqual(fs.readdirSync(source), ["INTRO.STK"]);
  assert.throws(() => Tools.revealExtraction({ ...entry, moduleData: { extractedRoot: source } }, context), /first/);
  await assert.rejects(Tools.extractArchives(entry, {}, context, { ...dependencies, runCommand: async () => { throw new Error("tool failure"); } }), /tool failure/);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "INTRO.STK", "INTRO.TOT"), "utf8"), "extracted script");
});
test("ScummVM extraction includes every supported archive in a game folder", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source);
  for (let index = 0; index < 65; index++) fs.writeFileSync(path.join(source, `${index}.STK`), stk());
  const result = await Tools.extractArchives({ gameId: "fixture", gamePath: source }, {}, {
    userDataDir: path.join(root, "profile"), settings: {}
  }, {
    ensureTools: async () => ({ version: "2.9.0", install: { executablePath: path.join(root, "scummvm-tools-cli") } }),
    runCommand: async (_command, args) => fs.writeFileSync(path.join(args[args.indexOf("-o") + 1], "INTRO.TOT"), "script")
  });
  assert.equal(result.archiveCount, 65); assert.equal(result.archives.length, 65);
  for (const name of result.archives) assert.equal(fs.readFileSync(path.join(result.outputRoot, name, "INTRO.TOT"), "utf8"), "script");
});
test("ScummVM archive extraction obtains consent before downloading missing tools", async t => {
  const root = temporary(t), source = path.join(root, "source"); fs.mkdirSync(source); fs.writeFileSync(path.join(source, "INTRO.STK"), stk());
  let consent = 0;
  await assert.rejects(Tools.extractArchives({ gameId: "fixture", gamePath: source }, {}, {
    userDataDir: path.join(root, "profile"), settings: {}, confirmRuntimeInstall: async plan => { consent++; assert.equal(plan.managerId, "scummvm-tools"); return false; }
  }), { name: "AbortError" });
  assert.equal(consent, 1); assert.equal(fs.existsSync(path.join(root, "profile", "runtimes")), false);
});
