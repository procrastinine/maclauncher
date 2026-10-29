const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { image: nativeImage } = require("./fixtures/macho-image");
const Detect = require("../src/modules/siglus/detect");
const Launch = require("../src/modules/siglus/launch");
const Catalog = require("../src/modules/siglus/runtime/catalog");
const Profile = require("../src/modules/siglus/runtime/profile");
const Native = require("../src/modules/shared/runtime/local-native");

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-siglus-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function scene(compiler = 10002, headerSize = 464) {
  const result = Buffer.alloc(headerSize + 16);
  result.writeUInt32LE(headerSize, 0); result.writeUInt32LE(compiler, 4);
  result.writeUInt32LE(headerSize, 8); result.writeUInt32LE(headerSize, 0x20);
  result.writeUInt32LE(16, 0x24); result.writeUInt32LE(16, 0x28);
  return result;
}
function realLive(root, { compiler = 10002, folder = "" } = {}) {
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  const code = scene(compiler), seen = Buffer.alloc(80000 + code.length);
  seen.writeUInt32LE(80000, 9030 * 8); seen.writeUInt32LE(code.length, 9030 * 8 + 4); code.copy(seen, 80000);
  fs.writeFileSync(path.join(root, folder, "SeEn.TxT"), seen);
  fs.writeFileSync(path.join(root, "Gameexe.ini"), `#CAPTION="A test story"\n#VERSION_STR="Ver1.01"\n#FOLDNAME.TXT="${folder}"=0:"SEEN.TXT"\n`);
  fs.writeFileSync(path.join(root, "SiglusEngine_Steam.exe"), "MZ");
  return seen;
}
function siglusPack() {
  const b = Buffer.alloc(124); b.write("pack_scn");
  b.writeUInt32LE(92, 8); b.writeUInt32LE(100, 8 + 13 * 4); b.writeUInt32LE(1, 8 + 14 * 4);
  b.writeUInt32LE(108, 8 + 17 * 4); b.writeUInt32LE(1, 8 + 18 * 4);
  b.writeUInt32LE(116, 8 + 19 * 4); b.writeUInt32LE(1, 8 + 20 * 4);
  b.writeUInt32LE(0, 108); b.writeUInt32LE(8, 112);
  return b;
}
test("script headers identify RealLive independently of a Siglus executable name", t => {
  const root = fixture(t); realLive(root, { folder: "ScN" });
  const info = Detect.inspectGame(root, { inputPath: path.join(root, "SiglusEngine_Steam.exe") });
  assert.equal(info.engineKind, "reallive"); assert.equal(info.compilerVersion, 10002); assert.equal(info.samples[0].headerSize, 464);
  assert.equal(info.gameVersion, "Ver1.01"); assert.equal(info.detectedVersion, null); assert.equal(info.interpreterSupported, true);
  assert.equal(info.scenarioPath, path.join(root, "ScN", "SeEn.TxT"));
});
test("RealLive rejects forged indices, missing scripts and escaped FOLDNAME paths", t => {
  const root = fixture(t), seen = realLive(root);
  seen.writeUInt32LE(12, 9030 * 8); fs.writeFileSync(path.join(root, "SeEn.TxT"), seen);
  assert.equal(Detect.inspectGame(root), null);
  fs.unlinkSync(path.join(root, "SeEn.TxT"));
  fs.writeFileSync(path.join(root, "Gameexe.dat"), "a filename alone proves nothing");
  assert.equal(Detect.inspectGame(root), null);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-key-outside-")); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  realLive(outside); fs.symlinkSync(outside, path.join(root, "external"));
  fs.writeFileSync(path.join(root, "Gameexe.ini"), '#FOLDNAME.TXT="external"=0:"SEEN.TXT"\n');
  assert.equal(Detect.inspectGame(root), null);
});
test("unrecognized RealLive compiler revisions remain detected and cannot launch through an incompatible backend", t => {
  const root = fixture(t); realLive(root, { compiler: 120002 });
  const info = Detect.inspectGame(root);
  assert.equal(info.engineKind, "reallive"); assert.equal(info.compilerVersion, 120002); assert.equal(info.interpreterSupported, false);
  assert.throws(() => Launch.inspectEntry({ gamePath: root }), /120002.*compatible/);
  assert.equal(Detect.parseRealLiveHeader(scene(10002, 460), 476).interpreterSupported, false);
});
test("Siglus requires a bounded scene directory, not the Scene.pck filename", t => {
  const root = fixture(t), file = path.join(root, "Scene.pck"), bytes = siglusPack();
  fs.writeFileSync(file, bytes);
  assert.equal(Detect.inspectGame(root).engineKind, "siglus"); assert.equal(Detect.inspectGame(root).format, "pack_scn");
  bytes.writeUInt32LE(0x7fffffff, 108); fs.writeFileSync(file, bytes);
  assert.equal(Detect.inspectGame(root), null);
  fs.writeFileSync(file, Buffer.alloc(120)); assert.equal(Detect.inspectGame(root), null);
});
test("private Siglus keys and saves use small owned files while assets remain original", t => {
  const root = fixture(t), game = path.join(root, "game"), userDataDir = path.join(root, "launcher"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "Scene.pck"), siglusPack()); fs.mkdirSync(path.join(game, "g00")); fs.writeFileSync(path.join(game, "g00", "picture.g00"), "original");
  fs.writeFileSync(path.join(game, "key.toml"), "key = [1,2,3]\n"); fs.mkdirSync(path.join(game, "savedata")); fs.writeFileSync(path.join(game, "savedata", "0000.sav"), "original save");
  const before = Native.hashFile(path.join(game, "Scene.pck")), keyBefore = Native.hashFile(path.join(game, "key.toml"));
  const entry = { gameId: "test-story", gamePath: game }, context = { userDataDir, runtimeSettings: { stringEncryption: "mdl" } };
  const prepared = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert(fs.lstatSync(path.join(prepared.root, "Scene.pck")).isSymbolicLink());
  assert(fs.lstatSync(path.join(prepared.root, "g00")).isSymbolicLink());
  assert(!fs.lstatSync(path.join(prepared.root, "key.toml")).isSymbolicLink());
  assert(!fs.lstatSync(prepared.saves).isSymbolicLink());
  fs.writeFileSync(path.join(prepared.saves, "0000.sav"), "new private save");
  assert.equal(fs.readFileSync(path.join(game, "savedata", "0000.sav"), "utf8"), "original save");
  assert.equal(Native.hashFile(path.join(game, "Scene.pck")), before); assert.equal(Native.hashFile(path.join(game, "key.toml")), keyBefore);
  assert.match(fs.readFileSync(path.join(prepared.root, "key.toml"), "utf8"), /override_string_encryption = "mdl"/);
  assert.equal(Launch.resolveSaveLocations(entry, context).primaryDirectory, prepared.saves);
});
test("RealLive reads the original in place and directs saves through the upstream environment API", t => {
  const root = fixture(t), game = path.join(root, "game"); fs.mkdirSync(game); realLive(game);
  const entry = { gameId: "reallive", gamePath: game }, context = { userDataDir: path.join(root, "data"), runtimeSettings: {} };
  const prepared = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(prepared.root, game); assert.equal(prepared.env.REALLIVE_SAVE_DIR, prepared.saves);
  assert.deepEqual(prepared.args, ["--run", "/native/libsiglus.dylib", game, "auto"]);
  assert.equal(fs.existsSync(path.join(game, "savedata_rs")), false);
});
test("shared GitHub discovery preserves all releases and immutable preview revisions", async () => {
  const revision = "a".repeat(40), filename = "siglus-macos-arm64.app.tar.gz", digest = "b".repeat(64);
  const revisions = { "1.0.0": revision, "pre-release": revision, "0.2.0": "c".repeat(40) };
  const releases = [{ tag_name: "1.0.0", assets: [] }, { tag_name: "pre-release", prerelease: true,
    body: `Version: v1.0.0\nCommit: ${revision}`, assets: [{ name: filename, id: 621421334,
      browser_download_url: `${Catalog.RELEASES}/download/pre-release/${filename}`, digest: `sha256:${digest}` }] }, { tag_name: "0.2.0", assets: [] }];
  const dependencies = { fetchGithubReleases: async options => { assert.equal(options.includePrerelease, true); assert.equal(options.maxPages, 5); return releases; },
    fetchGithubTags: async () => Object.entries(revisions).map(([name, sha]) => ({ name, commit: { sha } })) };
  const catalog = await Catalog.createDiscovery({ arch: "arm64", dependencies })({});
  assert.deepEqual(catalog.map(item => item.version), ["1.0.0", "1.0.0-preview." + revision.slice(0, 12), "0.2.0"]);
  assert.equal(catalog[1].asset.sha256, digest); assert.equal(catalog[1].upstreamTag, "pre-release");
  releases[1].body = `Version: v1.0.0\nCommit: ${"f".repeat(40)}`;
  await assert.rejects(Catalog.createDiscovery({ arch: "arm64", dependencies })({}), /does not match its tag/);
});
test("the launcher keeps only the exact host identity and installs no resource copy", () => {
  assert.equal(Profile.hostResource, undefined);
  assert.equal(Profile.prepareInstall, undefined);
  assert.equal(typeof Profile.resolveProfile, "function");
});
test("native installation retains the verified library and rejects changed auxiliary code", async t => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const root = fixture(t), installDir = path.join(root, "installed"), unpacked = path.join(installDir, "project-payload/files");
  const libraryPath = path.join(unpacked, "lib/libsiglus.dylib"), hostPath = path.join(unpacked, "bin/siglus-host");
  fs.mkdirSync(path.dirname(libraryPath), { recursive: true });fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(libraryPath, Buffer.concat([nativeImage({ cpu: architecture === "arm64" ? 0x0100000c : 0x01000007,
    installName: "@rpath/libsiglus.dylib", symbols: ["game_run_entry", "game_probe_json", "game_string_free"] }), Buffer.alloc(1024)]));
  fs.writeFileSync(hostPath, nativeImage({ cpu: architecture === "arm64" ? 0x0100000c : 0x01000007, fileType: 2, installName: null }), { mode: 0o755 });
  fs.writeFileSync(path.join(unpacked,"LICENSE-siglus_rs.txt"),"Original license notice");
  const pin = { version: "fixture-siglus", upstreamRevision: "a".repeat(40), asset: { sha256: "b".repeat(64) } }, files=Object.fromEntries(["bin/siglus-host","lib/libsiglus.dylib","LICENSE-siglus_rs.txt"].map(name=>[name,Native.hashFile(path.join(unpacked,name))]));
  const profile={schema:1,profile:Profile.PROFILE,version:pin.version,upstreamRevision:pin.upstreamRevision,archiveSha256:pin.asset.sha256,
    hostSourceSha256:"c".repeat(64),files};
  fs.writeFileSync(path.join(unpacked,"siglus-profile.json"),JSON.stringify(profile));
  const manifest = { schemaVersion: 1, managerId: "siglus", version: pin.version, upstreamRevision: pin.upstreamRevision,
    platform: "darwin", arch: architecture, minimumMacOS: "13.0", executableRelative: "bin/siglus-host",
    runtimeFiles: { siglusProfile: "siglus-profile.json", siglusLibrary: "lib/libsiglus.dylib" }, dependencies: [],
    provenance: { sourceRevision: pin.upstreamRevision },
    notices: [{ name: "Fixture", license: "MIT", path: "LICENSE-siglus_rs.txt", sourceUrl: "https://example.org/fixture" }],
    files: [...Object.keys(files), "siglus-profile.json"].map(name => { const file = path.join(unpacked, name), stat = fs.statSync(file);
      return { path: name, sha256: Native.hashFile(file), size: stat.size, mode: stat.mode & 0o777,
        ...(name === "bin/siglus-host" || name === "lib/libsiglus.dylib" ? { architectures: [architecture === "arm64" ? "arm64" : "x86_64"] } : {}) }; }) };
  const manifestPath = path.join(installDir, "project-payload/manifest.json"); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const project = { id: "siglus", arch: architecture, manifestRelative: "manifest.json", manifestSha256: Native.hashFile(manifestPath), capabilities: { nativeApi: "game_run_entry-v1" } };
  const install = { executablePath: hostPath, installDir, catalogEntry: { projectPackage: project }, version: pin.version, upstreamRevision: pin.upstreamRevision,
    source: "download", archiveSha256: pin.asset.sha256, installationMetadata: {profileSha256:Native.hashFile(path.join(unpacked,"siglus-profile.json"))} };
  const installed = Profile.resolveProfile(install);
  assert.equal(installed.libraryPath, path.join(unpacked, "lib", "libsiglus.dylib"));
  assert.equal(Profile.resolveProfile(install, { verification: "status" }).profileSha256, installed.profileSha256);
  const stat = fs.statSync(installed.libraryPath), fd = fs.openSync(installed.libraryPath, "r+");
  fs.writeSync(fd, Buffer.from([99]), 0, 1, 900); fs.closeSync(fd); fs.utimesSync(installed.libraryPath, stat.atime, stat.mtime);
  assert.throws(() => Profile.resolveProfile(install, { verification: "status" }), /payload has changed/);
  assert.throws(() => Profile.resolveProfile(install), /payload has changed/);
});
test("Siglus module state is offline and imports without Electron", () => {
  const oldFetch = global.fetch;
  global.fetch = () => { throw new Error("No background network"); };
  try {
    const module = require("../src/modules/siglus/main"), state = module.runtimeManagers[0].getState({});
    assert.equal(module.id, "siglus"); assert.equal(state.catalog.supportsLatestOnly, false);
    assert.deepEqual(state.catalog.versions, []);
    assert.deepEqual(state.catalog.installableVersions, []);
    assert.equal(module.runtimeManagers[0].label, "siglus_rs");
    assert.deepEqual(module.runtimeManagers[0].core.listCatalog({}), []);
    assert.equal(module.runtimeManagers[0].resolveSelection({}, {}, undefined).version, null);
    assert.equal(Object.keys(require.cache).some(file => /node_modules[\\/]electron[\\/]/.test(file)), false);
  } finally { global.fetch = oldFetch; }
});

test("Siglus launches the selected managed host executable", async t => {
  const root = fixture(t); realLive(root);
  const mod = require("../src/modules/siglus/main"), calls = [];
  const install = { executablePath: "/managed/bin/siglus-host", libraryPath: "/managed/lib/libsiglus.dylib", needsRosetta: false };
  t.mock.method(mod.runtimeManagers[0], "resolveSelection", () => ({ ready: true, install }));
  const result = await mod.launchRuntime("siglus", { gameId: "managed-host", gamePath: root }, {
    userDataDir: path.join(root, "launcher"), runtimeSettings: {}, settings: {},
    spawnDetachedChecked: (...args) => { calls.push(args); return { pid: 123 }; }
  });
  assert.equal(result.pid, 123); assert.equal(calls[0][0], install.executablePath);
  assert.deepEqual(calls[0][1], ["--run", install.libraryPath, root, "auto"]);
});
