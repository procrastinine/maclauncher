const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Rtp = require("../src/modules/rgss/rtp");
const Assets = require("../src/modules/rgss/assets");
const Declarations = require("../src/modules/rgss/rtp-declarations");
const { detectGame } = require("../src/modules/rgss/detect");
const Header = require("../src/modules/shared/installers/inno-header");
const { prepareForLaunch } = require("../src/core/runtime-preparation");
const Launcher = require("../src/modules/rgss/runtime/mkxpz-launcher");
const MkxpzManager = require("../src/modules/rgss/runtime/mkxpz-manager");
const Rgss = require("../src/modules/rgss/main");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");
const { createRuntimeUseScope } = require("../src/core/coordinated-runtime-managers");

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function installer() {
  const bytes = Buffer.alloc(256); bytes.write("MZ");
  bytes.writeUInt32LE(0x6f6e6e49, 0x30); bytes.writeUInt32LE(64, 0x34); bytes.writeUInt32LE(~64 >>> 0, 0x38);
  Buffer.from("72446c507453cde6d77b0b2a", "hex").copy(bytes, 64);
  bytes.writeUInt32LE(1, 76); bytes.writeUInt32LE(128, 96); bytes.writeUInt32LE(224, 100);
  bytes.writeUInt32LE(Header.crc32(bytes.subarray(64, 104)), 104);
  bytes.write("Inno Setup Setup Data (5.5.7) (u)", 128); return bytes;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rtp-")), userDataDir = path.join(root, "data");
  t.after(() => { Assets.removeStagedAssets({ userDataDir }); fs.rmSync(root, { recursive: true, force: true }); });
  const source = installer(), calls = [], payloads = new Map(), metadata = new Map(); let mode = "normal";
  const packs = [["Standard", "1.04"], ["RPGVX", "1.02"]].map(([id, version]) => {
    const files = [{ relative: "Audio/BGM/Example.mid", value: Buffer.from("midi " + id) }, { relative: "Graphics/Titles/Example.png", value: Buffer.from("picture " + id) }];
    payloads.set(id, files);
    const info = { schemaVersion: 1, helperVersion: "fixture-v1", sourceRevision: "a".repeat(40), format: "inno", formatVersion: "5.5.7 (unicode)",
      headerOffset: 128, dataOffset: 224, externalData: false, encrypted: false, requiredSlices: [], productVersion: version,
      files: files.map((file, location) => ({ path: "app/" + file.relative, authoredPath: "{app}\\" + file.relative.replaceAll("/", "\\"), size: file.value.length, location })) };
    metadata.set(id, info);
    return { id, label: id + " RTP", version, installVersion: `rtp-${id.toLowerCase()}-${version}`, sourceUrl: `https://assets.example.invalid/${id}.exe`,
      termsUrl: "https://example.invalid/terms", archive: { kind: "inno", file: id + ".exe", size: source.length, sha256: digest(source) }, outerFiles: [], setup: id + ".exe",
      installerVersion: info.formatVersion, metadataSha256: digest(JSON.stringify(info.files)), dataProfile: "official-app-files-v1",
      datasetSha256: Rtp.dataset(files.map(({ relative, value }) => ({ relative, size: value.length, sha256: digest(value) }))), files: files.length,
      bytes: files.reduce((sum, file) => sum + file.value.length, 0) };
  });
  const helper = { version: "fixture-v1", sourceRevision: "a".repeat(40), executable: "fixture-reader", inspector: "fixture-inspector" };
  const download = async (url, dest, { signal, onProgress }) => {
    signal?.throwIfAborted(); calls.push(["download", url]);
    fs.writeFileSync(dest, mode === "bad-download" ? Buffer.alloc(source.length) : source);
    onProgress?.({ downloaded: source.length, total: source.length });
  };
  const execute = async (exe, args, { signal }) => {
    signal?.throwIfAborted(); const input = args.at(-1), id = path.basename(input, ".exe"); calls.push([args[0], id]);
    if (mode === "wait" && args[0] === "--extract") return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true }));
    if (args[0] === "--inspect-json") {
      const info = structuredClone(metadata.get(id));
      if (mode === "metadata") info.files[0].size++;
      return { stdout: JSON.stringify(info) };
    }
    const out = args[args.indexOf("--output-dir") + 1];
    for (const file of payloads.get(id)) {
      const output = path.join(out, "app", file.relative); fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, mode === "bad-data" ? Buffer.alloc(file.value.length) : file.value);
    }
    if (mode === "link") fs.symlinkSync(root, path.join(out, "app", "unexpected"));
    return { stdout: "" };
  };
  const store = Rtp.createRtpStore({ catalog: { schemaVersion: 1, packs }, download, execute, resolveHelper: () => helper });
  return { root, userDataDir, packs, store, calls, setMode(value) { mode = value; } };
}
const entry = declarations => ({ gameId: "example", gamePath: "/example/game", moduleData: { rgssVersion: "RGSS1", rtpDeclarations: declarations } });

test("official RTP versions have distinct bounded publisher and complete content identities", () => {
  assert.deepEqual(Rtp.catalog.packs.map(pack => [pack.id, pack.version]), [["Standard", "1.04"], ["RPGVX", "1.02"], ["RPGVXAce", "1.00"]]);
  for (const pack of Rtp.catalog.packs) {
    assert.equal(new URL(pack.sourceUrl).hostname, "assets.rpgmakerweb.com");
    assert.match(pack.archive.sha256, /^[a-f0-9]{64}$/); assert.match(pack.datasetSha256, /^[a-f0-9]{64}$/);
    assert.equal(pack.termsUrl, "https://www.rpgmakerweb.com/downloads");
  }
});

test("XP RTP1/RTP2/RTP3 preserve order, exclude empty declarations and retain custom names", t => {
  const f = fixture(t), game = path.join(f.root, "game"); fs.mkdirSync(game);
  fs.writeFileSync(path.join(game, "Game.ini"), "[Game]\nLibrary=RGSS104E.dll\nRTP1=RPGVX\nRTP2=Standard\nRTP3=CustomPack\n");
  const detected = detectGame({ rootDir: game });
  assert.deepEqual(detected.moduleData.rtpDeclarations, ["RPGVX", "Standard", "CustomPack"]);
  assert.deepEqual(Declarations.requiredPacks(detected), ["RPGVX", "Standard"]);
  assert.equal(detected.moduleData.rtpId, "RPGVX");
  fs.writeFileSync(path.join(game, "Game.ini"), "[Game]\nLibrary=RGSS104E.dll\nRTP1=\nRTP2=\nRTP3=\n");
  assert.deepEqual(detectGame({ rootDir: game }).moduleData.rtpDeclarations, []);
  assert.deepEqual(Declarations.requiredPacks({ gamePath: game, moduleData: { rtpId: "Standard" } }), []);
});

test("empty, unknown and manual RTP declarations acquire nothing or create directories", async t => {
  const f = fixture(t);
  for (const [declarations, runtimeSettings] of [[[], {}], [["CustomPack"], {}], [["Standard"], { rtpMode: "manual", rtpPath: "/manual/rtp" }]]) {
    assert.deepEqual(await f.store.getRuntimeRequirements(entry(declarations), { userDataDir: f.userDataDir, runtimeSettings }), []);
  }
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.userDataDir), false);
});

test("legacy v3 shared packs survive base migration and retain their original identity", async t => {
  const f = fixture(t), hash = "c".repeat(64), generation = hash + "-00000000-0000-0000-0000-000000000000";
  const assets = path.join(f.userDataDir, "modules/rgss/assets"), legacy = path.join(assets, "generations", generation);
  fs.mkdirSync(path.join(legacy, "rtp/Standard"), { recursive: true }); fs.writeFileSync(path.join(legacy, "rtp/Standard/asset.txt"), "legacy original");
  const output = [];
  function inventory(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), part = relative ? relative + "/" + name : name;
      const item = { relative: part, type: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o777 };
      if (stat.isFile()) { item.size = stat.size; item.sha256 = digest(fs.readFileSync(file)); }
      output.push(item); if (stat.isDirectory()) inventory(file, part);
    }
  }
  inventory(legacy);
  fs.writeFileSync(path.join(legacy, ".maclauncher-generation.json"), JSON.stringify({ version: 3, hash, output, outputHash: digest(JSON.stringify(output)) }));
  fs.writeFileSync(path.join(assets, ".maclauncher-assets.json"), JSON.stringify({ version: 3, hash, generation }));
  const resourceRoot = path.join(f.root, "resources"), kawarikiRoot = path.join(f.root, "kawariki");
  fs.mkdirSync(path.join(resourceRoot, "soundfont"), { recursive: true }); fs.writeFileSync(path.join(resourceRoot, "soundfont/GMGSx.SF2"), "font");
  fs.mkdirSync(kawarikiRoot); fs.writeFileSync(path.join(kawarikiRoot, "preload.rb"), "# preload");
  const staged = Assets.ensureAssetsStaged({ userDataDir: f.userDataDir, resourceRoot, kawarikiRoot });
  assert.equal(fs.existsSync(path.join(staged.generationRoot, "rtp")), false);
  assert.deepEqual(Assets.getLegacyRtpRoots(f.userDataDir), [legacy]);
  const resolved = await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" });
  assert.equal(resolved.path, path.join(legacy, "rtp/Standard")); assert.equal(resolved.version, null); assert.equal(resolved.source, "legacy");
  assert.deepEqual(await f.store.getRuntimeRequirements(entry(["Standard"]), { userDataDir: f.userDataDir }), []);
  assert.deepEqual(f.calls, []); assert.equal(fs.readFileSync(path.join(resolved.path, "asset.txt"), "utf8"), "legacy original");
  const identities = [], manager = { id: "mkxpz" }, scope = createRuntimeUseScope({ userDataDir: f.userDataDir, managers: [manager],
    coordinator: { acquireUse: async identity => { identities.push(identity); return "token-" + identities.length; }, release: async () => {} } });
  const host = path.join(f.root, "host"); fs.mkdirSync(host);
  scope.recordSelection({ managerId: "mkxpz", version: "explicit-host", sectionId: "default", sourcePath: host });
  // Game runtimes have no global default; the per-game selection supplies the version for existing RTP assets.
  const context = { userDataDir: f.userDataDir, runtimeId: "mkxpz", settings: {}, recordRuntimeUse: value => scope.recordSelection(value) };
  assert.deepEqual(await Rgss.getRuntimeRequirements({ ...entry(["Standard"]), runtimeData: { mkxpz: { version: "explicit-host" } } }, context), []);
  await scope.flushSelections();
  assert.deepEqual(identities.map(value => [value.sectionId, value.version]), [["default", "explicit-host"], ["rtp-Standard", "explicit-host"]]);
  assert.equal(identities[0].sourcePath, fs.realpathSync(host)); assert.equal(identities[1].sourcePath, fs.realpathSync(resolved.path));
  await scope.release();
});

test("missing declared packs produce exact RTP consent plans rather than host downloads", async t => {
  const f = fixture(t), plans = await f.store.getRuntimeRequirements(entry(["RPGVX", "Standard", "Standard"]), { userDataDir: f.userDataDir });
  assert.deepEqual(plans.map(plan => [plan.managerId, plan.version, plan.installOptions.rtpPack]), [["mkxpz", "rtp-rpgvx-1.02", "RPGVX"], ["mkxpz", "rtp-standard-1.04", "Standard"]]);
  assert.match(plans[0].message, /RPGVX RTP 1\.02/); assert.equal(plans[0].licenseRequired, true);
  assert.equal(fs.existsSync(f.userDataDir), false); assert.deepEqual(f.calls, []);
});

test("cold installation is shared across games and warm Play performs no acquisition", async t => {
  const f = fixture(t), first = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard", version: "rtp-standard-1.04" });
  const second = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" });
  const anotherGame = { ...entry(["Standard"]), gameId: "another-example" };
  assert.equal(first.path, second.path);
  assert.deepEqual(await f.store.getRuntimeRequirements(anotherGame, { userDataDir: f.userDataDir }), []);
  assert.equal((await f.store.resolveForEntry(anotherGame, { userDataDir: f.userDataDir })).paths[0], first.path);
  assert.equal(f.calls.filter(call => call[0] === "download").length, 1);
  assert.equal(fs.statSync(path.join(first.path, "Audio/BGM/Example.mid")).mode & 0o222, 0);
});

test("concurrent users share one cold installation and separate packs coexist in declared order", async t => {
  const f = fixture(t), [first, second] = await Promise.all([0, 1].map(() => f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" })));
  assert.equal(first.path, second.path); assert.equal(f.calls.filter(call => call[0] === "download").length, 1);
  const vx = await f.store.installPack({ userDataDir: f.userDataDir, id: "RPGVX" });
  assert.deepEqual((await f.store.resolveForEntry(entry(["RPGVX", "Standard"]), { userDataDir: f.userDataDir })).paths, [vx.path, first.path]);
  const identities = [], scope = createRuntimeUseScope({ userDataDir: f.userDataDir, managers: [{ id: "mkxpz" }],
    coordinator: { acquireUse: async identity => { identities.push(identity); return "token-" + identities.length; }, release: async () => {} } });
  const host = path.join(f.root, "host"); fs.mkdirSync(host);
  scope.recordSelection({ managerId: "mkxpz", version: "explicit-host", sectionId: "default", sourcePath: host });
  assert.deepEqual(await f.store.getRuntimeRequirements(entry(["RPGVX", "Standard"]), { userDataDir: f.userDataDir, recordRuntimeUse: value => scope.recordSelection(value) }), []);
  await scope.flushSelections();
  assert.deepEqual(identities.map(value => [value.sectionId, value.version]), [["default", "explicit-host"], ["rtp-RPGVX", "rtp-rpgvx-1.02"], ["rtp-Standard", "rtp-standard-1.04"]]);
  await scope.release();
});

test("damaged data publishes a repaired generation without deleting earlier paths", async t => {
  const f = fixture(t), first = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" });
  const file = path.join(first.path, "Audio/BGM/Example.mid"), original = fs.readFileSync(file);
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, Buffer.alloc(original.length));
  assert.equal(await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" }), null);
  const repaired = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" });
  assert.notEqual(repaired.path, first.path); assert.deepEqual(fs.readFileSync(path.join(repaired.path, "Audio/BGM/Example.mid")), original);
  assert.equal(fs.existsSync(file), true); assert.deepEqual(fs.readFileSync(file), Buffer.alloc(original.length));
});

test("benign filesystem observation drift revalidates bytes and retains the same generation", async t => {
  const f = fixture(t), first = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" });
  const file = path.join(first.path, "Audio/BGM/Example.mid"); fs.chmodSync(file, 0o644); fs.chmodSync(file, 0o444);
  assert.equal((await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" })).path, first.path);
  assert.equal(f.calls.filter(call => call[0] === "download").length, 1);
});

for (const mode of ["bad-download", "metadata", "bad-data", "link"]) test(`invalid ${mode} cannot publish RTP data or leave temporary extraction`, async t => {
  const f = fixture(t); f.setMode(mode);
  await assert.rejects(f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" }));
  const directory = path.join(f.userDataDir, "modules/rgss/assets/rtp-packs/Standard/1.04");
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" }), null);
});

test("cancellation during extraction leaves no installed pointer or temporary tree", async t => {
  const f = fixture(t), controller = new AbortController(); f.setMode("wait");
  const pending = f.store.installPack({ userDataDir: f.userDataDir, id: "Standard", signal: controller.signal });
  while (!f.calls.some(call => call[0] === "--extract")) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(path.join(f.userDataDir, "modules/rgss/assets/rtp-packs/Standard/1.04")), []);
});

test("invalid versions, pointers and symlinked storage cannot substitute another pack", async t => {
  const f = fixture(t);
  await assert.rejects(f.store.installPack({ userDataDir: f.userDataDir, id: "Standard", version: "1.02" }), /version/);
  const first = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" }), directory = path.dirname(path.dirname(first.path));
  const pointer = path.join(directory, "current.json"), record = JSON.parse(fs.readFileSync(pointer));
  fs.writeFileSync(pointer, JSON.stringify({ ...record, generation: "../../outside" }));
  assert.equal(await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" }), null);
  fs.writeFileSync(pointer, JSON.stringify({ ...record, files: [null, null] }));
  assert.equal(await f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" }), null);
  fs.unlinkSync(pointer); fs.symlinkSync(path.join(f.root, "outside"), pointer);
  await assert.rejects(f.store.resolvePack({ userDataDir: f.userDataDir, id: "Standard" }));
});

test("Play collects all consents before installation; decline preserves runtime defaults and storage", async t => {
  const f = fixture(t), events = [], game = entry(["Standard"]), settings = { runtimes: { mkxpz: { defaultVersion: "explicit-host" } } };
  const manager = { id: "mkxpz", label: "MKXP-Z", getState: () => ({ catalog: {} }), installRuntime: () => assert.fail("Install adapter expected") };
  const mod = { runtimeManagers: [manager], ensureRuntime: () => ({ managerId: "mkxpz", version: "explicit-host" }), getRuntimeRequirements: f.store.getRuntimeRequirements };
  const ctx = { userDataDir: f.userDataDir, runtimeId: "mkxpz", settings, confirmRuntimeInstall: async plan => { events.push("consent:" + plan.version); return !plan.installOptions?.rtpPack; } };
  const prepare = () => prepareForLaunch({ entry: game, mod, info: { runtime: {} }, context: ctx,
    registry: { listModuleIds: () => ["rgss"], getModule: () => mod }, runAction: () => assert.fail("No action required"),
    install: async (_manager, plan) => { events.push("install:" + plan.version); if (plan.rtpPack) await f.store.installPack({ userDataDir: f.userDataDir, id: plan.rtpPack, version: plan.version }); } });
  assert.equal(await prepare(), false); assert.deepEqual(events, ["consent:explicit-host", "consent:rtp-standard-1.04"]);
  assert.equal(fs.existsSync(f.userDataDir), false); assert.equal(settings.runtimes.mkxpz.defaultVersion, "explicit-host");
  ctx.confirmRuntimeInstall = async plan => { events.push("consent:" + plan.version); return true; }; events.length = 0;
  assert.equal(await prepare(), true); assert.deepEqual(events, ["consent:explicit-host", "consent:rtp-standard-1.04", "install:explicit-host", "install:rtp-standard-1.04"]);
  assert.equal(settings.runtimes.mkxpz.defaultVersion, "explicit-host");
});

test("automatic config respects declared RTP order while manual and extra paths retain precedence", async t => {
  const f = fixture(t), one = await f.store.installPack({ userDataDir: f.userDataDir, id: "Standard" }), two = await f.store.installPack({ userDataDir: f.userDataDir, id: "RPGVX" });
  const extra = path.join(f.root, "extra"); fs.mkdirSync(extra);
  const stagedAssets = { rtpPaths: [two.path, one.path], rtpPath: two.path };
  const automatic = Launcher.buildMkxpConfig({ entry: { ...entry(["RPGVX", "Standard"]), gamePath: f.root }, userDataDir: f.userDataDir, runtimeSettings: { extraRtpPaths: extra }, stagedAssets });
  assert.deepEqual(automatic.RTP, [two.path, one.path, extra]);
  const manual = Launcher.buildMkxpConfig({ entry: { ...entry(["Standard"]), gamePath: f.root }, userDataDir: f.userDataDir, runtimeSettings: { rtpMode: "manual", rtpPath: extra, extraRtpPaths: one.path }, stagedAssets });
  assert.deepEqual(manual.RTP, [extra, one.path]);
});

test("existing MKXP-Z adapter installs RTP with a pack label without consulting gh or changing host selection", async t => {
  const f = fixture(t), events = [];
  t.mock.method(Rtp, "installPack", async input => { events.push(input); return { ready: true }; });
  t.mock.method(MkxpzManager.core, "canUseGh", () => assert.fail("RTP acquisition cannot query GitHub"));
  const downloads = { runTask: (meta, runner) => { assert.equal(meta.label, "RPG Maker XP RTP"); assert.equal(meta.kind, "asset"); return runner({}); } };
  await MkxpzManager.installRuntime({ userDataDir: f.userDataDir, version: "rtp-standard-1.04", rtpPack: "Standard", downloads });
  assert.deepEqual([events[0].id, events[0].version], ["Standard", "rtp-standard-1.04"]);
  await assert.rejects(MkxpzManager.installRuntime({ userDataDir: f.userDataDir, version: "wrong", rtpPack: "Standard" }), /version/);
});

test("RGSS module requirement hook stays in the backend and skips unrelated runtimes", async t => {
  const f = fixture(t);
  assert.deepEqual(await Rgss.getRuntimeRequirements(entry(["Standard"]), { userDataDir: f.userDataDir, runtimeId: "other" }), []);
  const plans = await Rgss.getRuntimeRequirements(entry(["Standard"]), { userDataDir: f.userDataDir, runtimeId: "mkxpz" });
  assert.equal(plans[0].installOptions.rtpPack, "Standard");
});

test("shared installation service leaves MKXP-Z settings untouched after a numeric RTP installation", async t => {
  const f = fixture(t), settings = { defaultVersion: "2001-01-01T00-00-00Z_" + "a".repeat(40) };
  t.mock.method(Rtp, "installPack", options => f.store.installPack(options));
  t.mock.method(MkxpzManager.core, "compareVersions", () => assert.fail("RTP versions cannot be compared with MKXP-Z builds"));
  let stored = structuredClone(settings), commits = 0;
  const result = await runRuntimeManagerAction({ manager: MkxpzManager, action: "install",
    payload: { rtpPack: "Standard", version: "rtp-standard-1.04" }, userDataDir: f.userDataDir,
    readSettings: () => stored, saveSettings: next => { commits++; stored = next; } });
  assert.equal(result.version, "1.04"); assert.equal(result.rtpPack, "Standard");
  // MKXP-Z keeps no global default version, so installing an RTP pack writes no settings.
  assert.deepEqual(stored, settings); assert.equal(commits, 0);
  assert.equal(MkxpzManager.updateSettingsAfterInstall(settings, result), undefined);
  assert.equal(MkxpzManager.updateSettingsAfterInstall(settings, { version: "1.04" }, { rtpPack: "Standard" }), undefined);
});
