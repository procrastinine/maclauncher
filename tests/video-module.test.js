const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Detect = require("../src/modules/video/detect"), Catalog = require("../src/modules/video/runtime/catalog"), Manager = require("../src/modules/video/runtime/manager"), Tools = require("../src/modules/video/tools");
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-module-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root; }
function box(kind, bytes = Buffer.alloc(0)) { const header = Buffer.alloc(8);header.writeUInt32BE(bytes.length + 8);header.write(kind, 4);return Buffer.concat([header, bytes]); }
function iso(handler = "vide", payload = Buffer.alloc(20)) {
  const metadata = Buffer.alloc(12);metadata.write(handler, 8);
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("mdat", payload), box("moov", box("trak", box("mdia", box("hdlr", metadata))))]);
}
test("video import validates direct containers and video tracks while ignoring audio", t => {
  const root = temporary(t), write = (name, bytes) => { const file = path.join(root, name);fs.writeFileSync(file, bytes);return file; };
  const valid = [write("Movie.MP4", iso()), write("Movie.mov", iso()), write("Movie.m4v", iso()),
    write("Movie.webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm"), Buffer.from([0x83, 0x81, 1, 0])])),
    write("Movie.mkv", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("matroska"), Buffer.from([0x83, 0x81, 1])])),
    write("Movie.avi", Buffer.from("RIFFxxxxxxxxAVI vids", "ascii"))];
  // AVI's form identifier is at offset eight.
  fs.writeFileSync(valid[5], Buffer.from("RIFFxxxxAVI vids", "ascii"));
  for (const inputPath of valid) { const detected = Detect.detectGame({ inputPath });assert.equal(detected?.engine, "video", inputPath);assert.equal(detected.gamePath, inputPath); }
  const registry = require("../src/modules/registry");
  assert.equal(registry.detectGame(valid[0]).engine, "video");
  assert.equal(registry.getModuleInfo("video").runtime.entries.mpv.graphicsHost, "window");
  assert.ok(registry.listSupportedInputExtensions().includes("mp4"));
  for (const inputPath of [write("Audio.mp4", iso("soun")), write("False.mp4", Buffer.alloc(100)), write("Audio.mp3", iso()),
    write("Audio.webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm"), Buffer.from([0x83, 0x81, 2, 0])]))]) assert.equal(Detect.detectGame({ inputPath }), null);
  assert.equal(Detect.detectGame({ inputPath: root }).moduleData.playlist, true);
});
test("MP4 metadata inspection skips media payloads and rejects malformed boxes", t => {
  const root = temporary(t), file = path.join(root, "movie.mp4"), bytes = iso("vide", Buffer.alloc(8 * 1024 * 1024));fs.writeFileSync(file, bytes);
  let read = 0;
  const result = Detect.detectGame({ inputPath: file, detection: { readBytes: (_file, at, count) => { read += count;return bytes.subarray(at, at + count); } } });
  assert.equal(result.engine, "video");assert.ok(read < 300 * 1024);
  bytes.writeUInt32BE(0xffffffff, 0);fs.writeFileSync(file, bytes);assert.equal(Detect.detectGame({ inputPath: file }), null);
});
test("mpv discovery selects the lowest compatible Apple Silicon build with publisher checksum and source pin", async () => {
  const release = (tag, floor, digest = "a".repeat(64)) => ({ tag_name: tag, assets: [{ name: `mpv-${tag}-macos-${floor}-arm.zip`,
    browser_download_url: `https://github.com/mpv-player/mpv/releases/download/${tag}/mpv-${tag}-macos-${floor}-arm.zip`, digest: digest && `sha256:${digest}`, size: 100, id: 1 }] });
  const current = release("v0.42.0", 26);current.assets.push(...release("v0.42.0", 15).assets);
  const rows = await Catalog.createDiscovery({ fetchGithubReleases: async () => [current, release("v0.41.0", 14), release("v0.40.0", 14, null), { ...release("v0.43.0", 27), prerelease: true }],
    resolveGithubTagCommit: async () => "f".repeat(40) })();
  assert.deepEqual(rows.map(row => row.version), ["0.42.0-macos-15-arm64", "0.41.0-macos-14-arm64"]);
  assert.equal(rows[0].asset.sha256, "a".repeat(64));assert.equal(rows[0].upstreamRevision, "f".repeat(40));
});
test("mpv status and initial Play selection perform no network requests", t => {
  const root = temporary(t);let calls = 0;
  const manager = Manager.createManager({ fetchGithubReleases: async () => { calls++;return []; }, systemVersionSync: () => "27.0" });
  assert.equal(manager.getState({ userDataDir: root }).installed.length, 0);
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.installableVersions, []);
  const selection = manager.resolveForPlay({}, { userDataDir: root, settings: {} });
  assert.equal(selection.ready, false);assert.equal(selection.version, null);
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.installableVersions, [], "No package default is introduced before catalog discovery");
  assert.equal(manager.resolveForPlay({}, { userDataDir: root, settings: {} }).version, selection.version);
  assert.equal(calls, 0);
});
test("fresh video Play obtains ordinary download consent before installing mpv", async t => {
  const mod = require("../src/modules/video/main"), { prepareForLaunch } = require("../src/core/runtime-preparation"), events = [];
  const context = { runtimeId: "mpv", userDataDir: temporary(t), settings: { runtimes: {} },
    confirmRuntimeInstall: async request => { events.push(["consent", request.version, request.requiresDownload]);return true; } };
  const ready = await prepareForLaunch({ entry: {}, mod, context, info: mod.manifest,
    registry: { listModuleIds: () => ["video"], getModule: () => mod },
    install: async (_manager, request) => { events.push(["install", request.version]); } });
  assert.equal(ready, true);assert.deepEqual(events, [["consent", null, true], ["install", null]]);
  context.confirmRuntimeInstall = async () => false;
  assert.equal(await prepareForLaunch({ entry: {}, mod, context, info: mod.manifest,
    registry: { listModuleIds: () => ["video"], getModule: () => mod }, install: async () => assert.fail("Declined download must not install") }), false);
});
test("video defaults scale native decoded frames while game defaults and graphics bypass remain unchanged", () => {
  const Graphics = require("../src/modules/shared/reshade/graphics-settings"), { playbackArguments } = require("../src/modules/video/main").__test;
  assert.equal(Graphics.DEFAULTS.spatialMethod, "off");
  const fresh = { gamePath: "/Video/clip.mp4" }, original = structuredClone(fresh), args = playbackArguments(fresh, ["bilinear", "ewa_lanczossharp"]);
  assert.ok(args.includes("--scale=ewa_lanczossharp"));assert.ok(args.includes("--cscale=ewa_lanczossharp"));assert.ok(args.includes("--autofit=80%x80%"));assert.deepEqual(fresh, original);
  const disabled = { ...fresh, effects: { schema: 2, mode: "advanced", enabled: false, video: [] } }, before = structuredClone(disabled);
  assert.ok(playbackArguments(disabled).includes("--scale=bilinear"));assert.deepEqual(disabled, before);assert.equal(Graphics.DEFAULTS.spatialMethod, "off");
});
test("offline video tools pick model/output, preserve source, forward cancellation and refuse overwrites", async t => {
  const root = temporary(t), input = path.join(root, "movie.mp4"), output = path.join(root, "processed.mp4"), modelPath = path.join(root, "Model.dlssmodel");fs.writeFileSync(input, iso());
  const signal = new AbortController().signal, calls = [], context = { signal, logger: {warn() {}}, ui: { dialog: {
    showOpenDialog: async () => ({ filePaths: [modelPath] }), showSaveDialog: async () => ({ filePath: output }) } } };
  const result = await Tools.processVideo({ gamePath: input }, {}, context, { processVideo: async options => { calls.push(options);return { output }; } });
  assert.equal(result.output, output);assert.equal(calls[0].input, input);assert.equal(calls[0].modelPath, modelPath);assert.equal(calls[0].signal, signal);assert.equal(calls[0].logger, context.logger);
  await Tools.processVideo({ gamePath: input, effects: { mode: "advanced", video: [{ kind: "neural", settings: { modelPath, intensity: 0.6, temporal: false } }] } },
    { output }, { signal }, { processVideo: async options => { assert.equal(options.intensity, 0.6);assert.equal(options.temporal, false);return { output }; } });
  await Tools.processVideo({ gamePath: input, graphics: { neuralMethod: "mlx-dlss", neuralModelPath: modelPath, neuralIntensity: .8, neuralTemporal: true } },
    { output }, { signal, ui: { dialog: { showOpenDialog: async () => assert.fail("The selected Simple model needs no additional picker") } } },
    { processVideo: async options => { assert.equal(options.modelPath, modelPath);assert.equal(options.intensity, .8);assert.equal(options.temporal, true);return { output }; } });
  fs.writeFileSync(output, "existing");await assert.rejects(Tools.processVideo({ gamePath: input }, { modelPath, output }, context), /already exists/);
  assert.equal(fs.readFileSync(output, "utf8"), "existing");assert.deepEqual(fs.readFileSync(input), iso());
  const canceled = await Tools.processVideo({ gamePath: input }, {}, { ui: { dialog: { showOpenDialog: async () => ({ canceled: true }) } } });assert.deepEqual(canceled, { canceled: true });
});

test("explicit Builds refresh exposes the self-describing decoded-host package while automatic Play and upstream mpv remain offline",{skip:process.arch!=="arm64"},async t=>{
  const capabilities={decodedFrameAPI:1,decodedColorAPI:1,preparationNotificationAPI:1,playerScriptsAPI:1,playerInputAPI:1,osdLayerAPI:1};
  const root=temporary(t),profiles=[{version:"fixture-decoded-host",sourceSha256:"c".repeat(64)}];let fetches=0,upstream=0;
  const records=profiles.map(profile=>{const version=profile.version,filename=`mpv-${version}-arm64.tar.gz`,tag=`mpv/v${version}/arm64`;return{schemaVersion:2,id:"mpv",version,arch:"arm64",launcherArchitectures:["arm64"],minimumMacOS:"27.0",manifestRelative:"manifest.json",manifestSha256:"a".repeat(64),sourceSha256:profile.sourceSha256,updatePolicy:"manual",tag,asset:{filename,url:`https://github.com/procrastinine/maclauncher-builds/releases/download/${encodeURIComponent(tag)}/${filename}`,sha256:"b".repeat(64),bytes:100},
    source:{repository:"mpv-player/mpv",revision:"a".repeat(40)},capabilities};});
  assert.deepEqual(Object.keys(Catalog).filter(key=>/RENDER.*ENTRY$/.test(key)),[],"The launcher pins no Builds binary");
  const manager=Manager.createManager({systemVersionSync:()=>"27.0",fetchGithubReleases:async()=>{upstream++;return[];},projectBuilds:{fetchUrlBuffer:async()=>{fetches++;return{status:200,body:Buffer.from(JSON.stringify({schemaVersion:2,projectId:"mpv",updatePolicy:"manual",packages:records}))};}}});
  assert.deepEqual(manager.getState({userDataDir:root}).catalog.installableVersions,[]);assert.equal(manager.resolveForPlay({}, {userDataDir:root,settings:{}}).version,null);assert.equal(fetches,0);
  assert.equal(manager.getState({userDataDir:root}).supportsDefault,true);
  assert.equal(manager.normalizeSettings({defaultVersion:profiles[0].version}).defaultVersion,profiles[0].version);
  await manager.refreshCatalog({userDataDir:root,sourceId:"builds",force:true});assert.equal(fetches,1);assert.equal(upstream,0);
  for(const profile of profiles){const pin=manager.core.listCatalog({userDataDir:root}).find(pin=>pin.version===profile.version);assert.equal(pin.projectPackage.id,"mpv");assert.equal(pin.upstreamRevision,"a".repeat(40));assert.equal(pin.minimumMacOS,"27.0");for(const key of Object.keys(capabilities))assert.equal(pin[key],1);assert.ok(manager.getState({userDataDir:root}).catalog.installableVersions.includes(profile.version));}
  assert.equal(manager.resolveForPlay({}, {userDataDir:root,settings:{}}).version,profiles[0].version,"The existing generic catalog order supplies the available candidate without a launcher pin");assert.equal(fetches,1);
});

test("playback positions keep a damaged state file beside it and never replace one that cannot be read", t => {
  const Playlist = require("../src/modules/video/playlist"), root = temporary(t), userDataDir = path.join(root, "profile"), video = path.join(root, "movie.mp4");
  fs.writeFileSync(video, "video");
  const entry = { gameId: "movie", gamePath: video }, context = { userDataDir }, file = Playlist.statePath(entry, context);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const damaged = '{"schema": 1, "videos": {"movie.mp4": {"position": 42}}, "lastVideo": "mov';
  fs.writeFileSync(file, damaged);
  const plan = Playlist.prepare(entry, context);
  assert.deepEqual(plan.state.videos, { "movie.mp4": { position: 42 } }, "readable positions remain");
  assert.equal(plan.statePath, file, "positions are saved again once the damaged file is kept");
  const copies = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith("playback.unreadable-") && name.endsWith(".json"));
  assert.equal(copies.length, 1);assert.equal(fs.readFileSync(path.join(path.dirname(file), copies[0]), "utf8"), damaged);
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === file) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return read(target, ...args);
  });
  const unreadable = Playlist.prepare(entry, context);
  assert.equal(unreadable.state.unreadable, true);assert.equal(unreadable.statePath, null, "a state file that cannot be read is not replaced");
});
