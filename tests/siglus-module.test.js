const Backcompat = require("../src/modules/siglus/backcompat");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { image: nativeImage } = require("./fixtures/macho-image");
const Detect = require("../src/modules/siglus/detect");
const Launch = require("../src/modules/siglus/launch");
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
test("explicit Siglus key adaptation keeps original saves and leaves old private state untouched", t => {
  const root = fixture(t), game = path.join(root, "game"), userDataDir = path.join(root, "launcher"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "Scene.pck"), siglusPack()); fs.mkdirSync(path.join(game, "g00")); fs.writeFileSync(path.join(game, "g00", "picture.g00"), "original");
  fs.writeFileSync(path.join(game, "key.toml"), "key = [1,2,3]\n"); fs.mkdirSync(path.join(game, "savedata")); fs.writeFileSync(path.join(game, "savedata", "0000.sav"), "original save");
  const before = Native.hashFile(path.join(game, "Scene.pck")), keyBefore = Native.hashFile(path.join(game, "key.toml"));
  const entry = { gameId: "test-story", gamePath: game }, context = { userDataDir, runtimeSettings: { stringEncryption: "mdl" } };
  const legacy = path.join(Launch.moduleRoot(entry, context), "project");
  fs.mkdirSync(path.join(legacy, "savedata"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "savedata", "old.sav"), "private progress");
  const prepared = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(prepared.directory, game);
  assert.equal(prepared.saves, path.join(game, "savedata"));
  assert(fs.lstatSync(path.join(prepared.root, "Scene.pck")).isSymbolicLink());
  assert(fs.lstatSync(path.join(prepared.root, "g00")).isSymbolicLink());
  assert(!fs.lstatSync(path.join(prepared.root, "key.toml")).isSymbolicLink());
  assert(!fs.lstatSync(prepared.saves).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(prepared.root, "savedata")), fs.realpathSync(path.join(game, "savedata")));
  fs.writeFileSync(path.join(prepared.root, "savedata", "new.sav"), "upstream progress");
  assert.equal(fs.readFileSync(path.join(game, "savedata", "new.sav"), "utf8"), "upstream progress");
  assert.equal(fs.readFileSync(path.join(legacy, "savedata", "old.sav"), "utf8"), "private progress");
  assert.equal(Native.hashFile(path.join(game, "Scene.pck")), before); assert.equal(Native.hashFile(path.join(game, "key.toml")), keyBefore);
  assert.match(fs.readFileSync(path.join(prepared.root, "key.toml"), "utf8"), /override_string_encryption = "mdl"/);
  assert.equal(Launch.resolveSaveLocations(entry, context).primaryDirectory, prepared.saves);
  const key = path.join(prepared.root, "key.toml"), stamp = new Date(1000000000000);
  fs.utimesSync(key, stamp, stamp);
  Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(fs.statSync(key).mtimeMs, stamp.getTime(), "warm preparation does not rewrite unchanged configuration");
  entry.saveDirOverride = path.join(root, "chosen-saves");
  context.runtimeSettings.stringEncryption = "automatic";
  const automatic = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(fs.realpathSync(path.join(automatic.root, "savedata")), fs.realpathSync(entry.saveDirOverride));
  assert.equal(fs.readFileSync(path.join(automatic.root, "key.toml"), "utf8"), "key = [1,2,3]\n", "an earlier explicit decoding choice cannot leak into Automatic");
  assert.equal(fs.statSync(key).mtimeMs, stamp.getTime(), "changing decoding mode preserves the prior adapter's runtime-created state");
});
test("automatic Siglus launches the original root without visiting or replacing a legacy project", t => {
  const root = fixture(t), game = path.join(root, "game"), context = { userDataDir: path.join(root, "profile"), runtimeSettings: {} };
  fs.mkdirSync(game); fs.writeFileSync(path.join(game, "Scene.pck"), siglusPack());
  const entry = { gameId: "automatic", gamePath: game };
  const legacy = path.join(Launch.moduleRoot(entry, context), "project");
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "key.toml"), "old key");
  const prepared = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(prepared.root, game); assert.equal(prepared.directory, game);
  assert.equal(prepared.saves, path.join(game, "savedata"));
  assert.deepEqual(prepared.args, ["--run", "/native/libsiglus.dylib", game]);
  assert.equal(fs.existsSync(path.join(game, "savedata")), false, "the engine owns creation of its default saves");
  assert.equal(fs.existsSync(path.join(Launch.moduleRoot(entry, context), "configured-project")), false);
  assert.equal(fs.readFileSync(path.join(legacy, "key.toml"), "utf8"), "old key");
});
test("RealLive uses original cwd and upstream save defaults while explicit overrides still work", t => {
  const root = fixture(t), game = path.join(root, "game"); fs.mkdirSync(game); realLive(game);
  const entry = { gameId: "reallive", gamePath: game }, context = { userDataDir: path.join(root, "data"), runtimeSettings: {} };
  const prepared = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(prepared.root, game); assert.equal(prepared.directory, game);
  assert.equal(prepared.env.REALLIVE_SAVE_DIR, process.env.REALLIVE_SAVE_DIR);
  assert.equal(prepared.env.HOME, process.env.HOME);
  assert.equal(prepared.saves, process.env.REALLIVE_SAVE_DIR || path.join(game, "savedata_rs"));
  assert.deepEqual(prepared.args, ["--run", "/native/libsiglus.dylib", game, "auto"]);
  assert.equal(fs.existsSync(path.join(game, "savedata_rs")), false);
  entry.saveDirOverride = path.join(root, "chosen-saves");
  const override = Launch.prepareLaunch(entry, context, { libraryPath: "/native/libsiglus.dylib" });
  assert.equal(override.env.REALLIVE_SAVE_DIR, entry.saveDirOverride);
  assert.equal(override.root, game); assert.equal(override.directory, game);
  assert.equal(Launch.saveDirectory({ gamePath: game, moduleData: { engineKind: "avg32" } }), process.env.AVG32_SAVE_DIR || game);
});
test("Siglus declares obsolete views only for one-time migration and protects explicit private overrides", t => {
  const root = fixture(t), game = path.join(root, "game"), context = { userDataDir: path.join(root, "profile") };
  fs.mkdirSync(game);
  const mod = Backcompat, entry = { gameId: "migration", gamePath: game, moduleData: { engineKind: "reallive" } };
  const directory = Launch.moduleRoot(entry, context);
  assert.deepEqual(mod.legacyGameMirrors(entry, context), [
    { mirrorRoot: path.join(directory, "project"), sourceRoot: game },
    { mirrorRoot: path.join(directory, "saves"), sourceRoot: path.join(game, "savedata_rs"), createSourceWithin: game,
      entryPatch: { defaultSaveDir: path.join(game, "savedata_rs"), saveLocations: [{ directory: path.join(game, "savedata_rs"), source: "Native interpreter saves", confidence: "exact", label: "Saves" }] } }
  ]);
  assert.equal(fs.existsSync(context.userDataDir), false, "descriptor discovery has no filesystem writes");
  const protectedRows = mod.legacyGameMirrors({ ...entry, saveDirOverride: path.join(directory, "project", "savedata") }, context);
  assert.deepEqual(protectedRows.map(row => row.mirrorRoot), [path.join(directory, "saves")]);
  assert.deepEqual(mod.legacyGameMirrors({ ...entry, saveDirOverride: directory }, context), []);
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
  project.source = {repository: "procrastinine/maclauncher-builds", revision: "d".repeat(40)};
  const producerInstall = {...install, upstreamRevision: project.source.revision};
  const fromProducer = Profile.resolveProfile(producerInstall);
  assert.equal(fromProducer.sourceIdentity.revision, project.source.revision);
  assert.equal(fromProducer.sourceIdentity.receiptRevision, project.source.revision);
  assert.equal(fromProducer.sourceIdentity.upstreamRevision, pin.upstreamRevision);
  assert.equal(fromProducer.profile.upstreamRevision, pin.upstreamRevision);
  assert.equal(Profile.resolveProfile(producerInstall, {verification: "status"}).libraryPath, installed.libraryPath);
  manifest.provenance.sourceRevision = project.source.revision;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  project.manifestSha256 = Native.hashFile(manifestPath);
  const sourceLabels = Profile.resolveProfile(producerInstall);
  assert.equal(sourceLabels.sourceIdentity.upstreamRevision, pin.upstreamRevision);
  assert.equal(sourceLabels.sourceIdentity.provenanceRevision, project.source.revision);
  const manifestBytes = fs.readFileSync(manifestPath);
  fs.appendFileSync(manifestPath, " ");
  assert.equal(Profile.resolveProfile(producerInstall).libraryPath, installed.libraryPath);
  fs.writeFileSync(manifestPath, manifestBytes);
  const profilePath = path.join(unpacked, "siglus-profile.json"), profileBytes = fs.readFileSync(profilePath);
  fs.appendFileSync(profilePath, " ");
  assert.equal(Profile.resolveProfile(producerInstall).libraryPath, installed.libraryPath);
  fs.writeFileSync(profilePath, profileBytes);
  const stat = fs.statSync(installed.libraryPath), fd = fs.openSync(installed.libraryPath, "r+");
  fs.writeSync(fd, Buffer.from([99]), 0, 1, 900); fs.closeSync(fd); fs.utimesSync(installed.libraryPath, stat.atime, stat.mtime);
  assert.equal(Profile.resolveProfile(install, { verification: "status" }).libraryPath, installed.libraryPath);
  assert.equal(Profile.resolveProfile(install).libraryPath, installed.libraryPath);
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
  const result = await mod.launchRuntime("siglus", { name: "Story title", iconPath: "/existing/story-icon.png", gameId: "managed-host", gamePath: root }, {
    userDataDir: path.join(root, "launcher"), runtimeSettings: {}, settings: {},
    spawnDetachedChecked: (...args) => { calls.push(args); return { pid: 123 }; }
  });
  assert.equal(result.pid, 123); assert.equal(calls[0][0], install.executablePath);
  assert.equal(calls[0][2].env.MACLAUNCHER_GAME_NAME, "Story title");
  assert.equal(calls[0][2].env.MACLAUNCHER_GAME_ICON, "/existing/story-icon.png");
  assert.deepEqual(calls[0][1], ["--run", install.libraryPath, root, "auto"]);
});
