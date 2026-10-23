const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/fvp/runtime/catalog");
const Payload = require("../src/modules/fvp/runtime/payload");
const Native = require("../src/modules/shared/runtime/local-native");
const { createManager } = require("../src/modules/fvp/runtime/manager");
const { extractDmg } = require("../src/modules/fvp/runtime/dmg");
const { prepareForLaunch } = require("../src/core/runtime-preparation");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fvp-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function dylibCommand(kind, value) {
  const size = Math.ceil((24 + Buffer.byteLength(value) + 1) / 8) * 8, command = Buffer.alloc(size);
  command.writeUInt32LE(kind, 0); command.writeUInt32LE(size, 4); command.writeUInt32LE(24, 8);
  command.write(value, 24); return command;
}
function thin(cpu, fileType, { minimum = 11, dependency = "/usr/lib/libSystem.B.dylib" } = {}) {
  const build = Buffer.alloc(24); build.writeUInt32LE(0x32, 0); build.writeUInt32LE(24, 4);
  build.writeUInt32LE(1, 8); build.writeUInt32LE(minimum << 16, 12); build.writeUInt32LE(26 << 16, 16);
  const commands = fileType === 6 ? [build, dylibCommand(0xd, "@rpath/librfvp.dylib"), dylibCommand(0xc, dependency)] : [build];
  const body = Buffer.concat(commands), bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(cpu, 4); bytes.writeUInt32LE(fileType, 12);
  bytes.writeUInt32LE(commands.length, 16); bytes.writeUInt32LE(body.length, 20); body.copy(bytes, 32);
  return bytes;
}
function universal(fileType, options = {}) {
  const bytes = Buffer.alloc(1280), cpus = [0x01000007, 0x0100000c];
  bytes.writeUInt32BE(0xcafebabe, 0); bytes.writeUInt32BE(2, 4);
  cpus.forEach((cpu, i) => {
    const table = 8 + 20 * i, offset = 256 + 512 * i;
    bytes.writeUInt32BE(cpu, table); bytes.writeUInt32BE(offset, table + 8); bytes.writeUInt32BE(512, table + 12);
    thin(cpu, fileType, options).copy(bytes, offset);
  });
  return bytes;
}
function createApp(root, options = {}) {
  const app = path.join(root, "RFVP.app"), binary = path.join(app, "Contents", "MacOS", "RFVP");
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, universal(2), { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>RFVP</string></dict></plist>');
  const library = path.join(root, Payload.LIBRARY_RELATIVE);
  fs.mkdirSync(path.dirname(library), { recursive: true }); fs.writeFileSync(library, universal(6, options));
  return { app, binary, library };
}
function release(tag, revision, digest = "a".repeat(64), extra = {}) {
  return { tag_name: tag, target_commitish: "main", prerelease: tag === "pre-release", published_at: "2026-10-10T00:00:00Z", revision,
    assets: [{ name: "RFVP.dmg", size: 42, digest: `sha256:${digest}`, id: 1,
      browser_download_url: `https://github.com/xmoezzz/rfvp/releases/download/${tag}/RFVP.dmg` }], ...extra };
}
function pin(revision, digest, bytes = 42) {
  return { ...Catalog.DEFAULT_ENTRY, version: Catalog.snapshotVersion("pre-release", revision, digest), upstreamRevision: revision,
    asset: { ...Catalog.DEFAULT_ENTRY.asset, sha256: digest, bytes } };
}
function fixtureManager({ rows, discoverCatalog, dependencies = {} } = {}) {
  return createManager({ discoverCatalog: discoverCatalog || (async () => rows), dependencies: {
    systemVersionSync: () => "13.0", inspectExports: async () => [...Payload.REQUIRED_EXPORTS], ...dependencies
  } });
}

test("RFVP catalogs identify commit and complete digest, including replaced rolling assets", async () => {
  const old = release("pre-release", "1".repeat(40)), next = release("0.7.0", "2".repeat(40), "b".repeat(64));
  const releases = [old, next, release("0.6.0", "3".repeat(40), "c".repeat(64), { assets: [] }),
    release("0.5.0", "4".repeat(40), "d".repeat(64), { draft: true }),
    release("0.4.0", "5".repeat(40), "e".repeat(64), { assets: [{ name: "RFVP.dmg", digest: null }] })];
  const discovery = Catalog.createDiscovery({ fetchGithubReleases: async options => {
    assert.equal(options.includePrerelease, true); return releases;
  }, resolveGithubTagCommit: async ({ tag }) => releases.find(row => row.tag_name === tag).revision });
  const result = await discovery();
  assert.equal(result.length, 2); assert.equal(result[0].upstreamRevision, old.revision);
  assert.equal(result[0].version, Catalog.snapshotVersion("pre-release", old.revision, "a".repeat(64)));
  assert.notEqual(result[0].version, Catalog.snapshotVersion("pre-release", old.revision, "b".repeat(64)));
  assert.equal(result[1].asset.sha256, "b".repeat(64)); assert.match(result[0].versionLabel, /11111111.*aaaaaaaa/);
  assert.throws(() => Catalog.snapshotVersion("../tag", old.revision, "a".repeat(64)), /identified/);
  assert.throws(() => Catalog.snapshotVersion("pre-release", "main", "a".repeat(64)), /identified/);
  assert.equal(Catalog.assetUrlAllowed("https://github.com/other/rfvp/releases/download/pre-release/RFVP.dmg", "pre-release"), false);
});

test("RFVP rolling downloads use the release's exact commit without fetching unrelated tags", async () => {
  const revision = "1".repeat(40), rolling = release("pre-release", revision, "a".repeat(64), { target_commitish: revision });
  const historical = release("0.6.0", "2".repeat(40), "b".repeat(64), { assets: [] });
  const discover = Catalog.createDiscovery({ fetchGithubReleases: async () => [rolling, historical],
    fetchGithubTags: async () => { throw new Error("GitHub tags fetch failed (403)."); },
    resolveGithubTagCommit: async () => assert.fail("The release already identifies its exact source commit") });
  const rows = await discover();
  assert.equal(rows.length, 1); assert.equal(rows[0].upstreamRevision, revision);
  assert.equal(rows[0].asset.sha256, "a".repeat(64));
});

test("RFVP state reads are offline and cached publisher snapshots survive failed refresh", async t => {
  const root = temporary(t), newer = pin("1".repeat(40), "a".repeat(64)); let calls = 0, fail = false;
  const manager = fixtureManager({ discoverCatalog: async () => { calls++; if (fail) throw new Error("network failure"); return [newer]; } });
  assert.deepEqual(manager.getState({ userDataDir: root }).catalog.versions, []);
  assert.equal(manager.resolveSelection({}, {}, root, { verification: "status" }).version, Catalog.DEFAULT_VERSION);
  assert.equal(calls, 0);
  await manager.refreshCatalog({ userDataDir: root, force: true });
  assert.equal(manager.resolveSelection({}, {}, root).version, newer.version);
  assert.equal(manager.core.catalog.some(row => row.version === newer.version), true);
  assert.equal(manager.resolveSelection({ runtimeData: { rfvp: { version: Catalog.DEFAULT_VERSION } } }, { runtimes: { rfvp: { defaultVersion: newer.version } } }, root).version, Catalog.DEFAULT_VERSION);
  fail = true; await assert.rejects(manager.refreshCatalog({ userDataDir: root, force: true }), /network failure/);
  const restarted = fixtureManager({ discoverCatalog: async () => assert.fail("State must not fetch") });
  assert.deepEqual(restarted.getState({ userDataDir: root }).catalog.versions, [newer.version]);
  assert.equal(calls, 2);
});

test("RFVP missing-runtime Play refreshes metadata and preserves explicit unavailable selections", async t => {
  const root = temporary(t), newer = pin("1".repeat(40), "a".repeat(64)); let calls = 0;
  const manager = fixtureManager({ discoverCatalog: async () => { calls++; return [newer]; } });
  const context = { userDataDir: root, settings: {}, onRuntimeStateChange: () => {} };
  assert.equal((await manager.resolveForPlay({}, context)).version, newer.version);
  assert.equal(calls, 1);
  await assert.rejects(manager.resolveForPlay({ runtimeData: { rfvp: { version: Catalog.DEFAULT_VERSION } } }, context), /no longer available/);
  assert.equal(calls, 2);
});

test("RFVP fresh-profile Play reaches ordinary download consent when release metadata is rate limited", async t => {
  const root = temporary(t), events = [];
  const manager = fixtureManager({ discoverCatalog: async () => { throw new Error("GitHub releases fetch failed (403)"); } });
  const mod = { id: "fvp", runtimeManagers: [manager], ensureRuntime: async (entry, context) => {
    const selection = await manager.resolveForPlay(entry, context);
    return { managerId: manager.id, version: selection.version, installOptions: {} };
  } };
  const context = { runtimeId: "rfvp", userDataDir: root, settings: { runtimes: {} },
    confirmRuntimeInstall: async request => { events.push(["consent", request.version, request.requiresDownload]); return true; } };
  assert.equal(await prepareForLaunch({ entry: {}, mod, context, info: { runtime: { manager: { rfvp: "rfvp" } } },
    registry: { listModuleIds: () => ["fvp"], getModule: () => mod },
    install: async (_manager, request) => { events.push(["install", request.version]); } }), true);
  assert.deepEqual(events, [["consent", Catalog.DEFAULT_VERSION, true], ["install", Catalog.DEFAULT_VERSION]]);
  const state = manager.getState({ userDataDir: root });
  assert.equal(state.catalog.status, "error"); assert.match(state.catalog.error, /403/);
  assert.deepEqual(state.catalog.versions, [], "An execution-only consent fallback is not a discovered download");
  assert.equal(manager.core.catalog.find(row => row.version === Catalog.DEFAULT_VERSION).asset.sha256, Catalog.DEFAULT_ENTRY.asset.sha256);
});

test("RFVP failed refresh keeps cached exact downloads without overriding unknown selections or cancellation", async t => {
  const root = temporary(t), row = pin("1".repeat(40), "a".repeat(64)); let failed = false;
  const manager = fixtureManager({ discoverCatalog: async () => { if (failed) throw new Error("GitHub releases fetch failed (403)"); return [row]; } });
  await manager.refreshCatalog({ userDataDir: root, force: true }); failed = true;
  assert.equal((await manager.resolveForPlay({}, { userDataDir: root, settings: {} })).version, row.version);
  await assert.rejects(manager.resolveForPlay({ runtimeData: { rfvp: { version: "unknown-build" } } }, { userDataDir: root, settings: {} }), /403/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.resolveForPlay({}, { userDataDir: root, settings: {}, signal: controller.signal }), { name: "AbortError" });
});

test("RFVP installation verifies the consumed library and keeps installed rolling snapshots", async t => {
  const root = temporary(t), archive = Buffer.from("publisher fixture archive"), digest = sha(archive), old = pin("1".repeat(40), digest, archive.length);
  let rows = [old], downloads = 0;
  const dependencies = { downloadToFile: async (_url, file) => { downloads++; fs.writeFileSync(file, archive); },
    extractArchive: async (_file, unpacked) => { createApp(unpacked); } };
  const manager = fixtureManager({ discoverCatalog: async () => rows, dependencies });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const installed = await manager.core.installVersion({ userDataDir: root, version: old.version });
  assert.ok(installed.dylibPath.endsWith(Payload.LIBRARY_RELATIVE)); assert.equal(installed.minimumMacOS, "11.0.0");
  assert.equal(installed.librarySha256, Native.hashFile(installed.dylibPath));
  assert.equal(fs.existsSync(path.join(installed.installDir, "runtime.json")), true);
  assert.equal(manager.getState({ userDataDir: root }).installed[0].ready, true);
  await manager.resolveForPlay({ runtimeData: { rfvp: { version: old.version } } }, { userDataDir: root, settings: {} });
  assert.equal(downloads, 1);
  rows = [pin("2".repeat(40), "b".repeat(64))];
  await manager.refreshCatalog({ userDataDir: root, force: true });
  const restarted = fixtureManager({ rows, dependencies });
  assert.equal(restarted.core.resolveInstalled({ userDataDir: root, version: old.version }).version, old.version);
  assert.deepEqual(restarted.getState({ userDataDir: root }).catalog.versions, rows.map(row => row.version));
  assert.ok(restarted.getState({ userDataDir: root }).installed.some(row => row.version === old.version && row.ready), "Retired downloads remain usable as installed versions");
  assert.equal(restarted.resolveSelection({}, { runtimes: { rfvp: { defaultVersion: old.version } } }, root).version, old.version);
  // Change a byte outside the bounded Mach-O headers, keeping the file size.
  const bytes = fs.readFileSync(installed.dylibPath); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(installed.dylibPath, bytes);
  assert.equal(restarted.core.resolveInstalled({ userDataDir: root, version: old.version }), null);
  const damaged = restarted.getState({ userDataDir: root }).installed.find(row => row.version === old.version);
  assert.equal(damaged.ready, false); assert.match(damaged.error, /changed/);
  assert.equal(restarted.getState({ userDataDir: root }).catalog.versionRequirements[old.version].available, false);
  assert.equal(fs.existsSync(installed.executablePath), true);
});

test("RFVP uses the observed library floor for installed state on an older Mac", async t => {
  const root = temporary(t), archive = Buffer.from("higher floor archive"), row = pin("1".repeat(40), sha(archive), archive.length);
  const dependencies = { systemVersionSync: () => "14.0", downloadToFile: async (_url, file) => fs.writeFileSync(file, archive),
    extractArchive: async (_file, unpacked) => { createApp(unpacked, { minimum: 14 }); } };
  const manager = fixtureManager({ rows: [row], dependencies });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  await manager.core.installVersion({ userDataDir: root, version: row.version });
  const older = fixtureManager({ rows: [row] });
  const state = older.getState({ userDataDir: root });
  assert.equal(state.installed[0].ready, false); assert.equal(state.installed[0].status, "unsupported-host");
  assert.equal(state.catalog.versionRequirements[row.version].minimumMacOS, "14.0.0");
  assert.match(state.catalog.versionRequirements[row.version].installReason, /requires macOS 14/);
  assert.equal(state.catalog.installableVersions.includes(row.version), false);
  assert.equal(older.resolveSelection({ runtimeData: { rfvp: { version: row.version } } }, {}, root).ready, false);
});

test("RFVP payload status is bounded and full launch verification detects a changed library", async t => {
  const root = temporary(t), files = createApp(root), metadata = await Payload.preparePayload({ unpacked: root }, {
    inspectExports: async () => [...Payload.REQUIRED_EXPORTS], systemVersionSync: () => "13.0"
  });
  const resolver = Payload.createPayloadResolver({ systemVersionSync: () => "13.0" });
  const install = { installDir: root, installationMetadata: metadata };
  const originalHash = Native.hashFile; let hashes = 0;
  Native.hashFile = file => { hashes++; return originalHash(file); };
  try {
    assert.ok(resolver(install, { verification: "status" }).install);
    assert.ok(resolver(install, { verification: "status" }).install); assert.equal(hashes, 0);
    assert.ok(resolver(install).install); assert.equal(hashes, 1);
    const bytes = fs.readFileSync(files.library); bytes[bytes.length - 1] = 1; fs.writeFileSync(files.library, bytes);
    assert.equal(resolver(install).install, null); assert.equal(hashes, 2);
    assert.equal(resolver(install, { verification: "status" }).install, null); assert.equal(hashes, 2);
  } finally { Native.hashFile = originalHash; }
});

test("RFVP checks real CPU, macOS, system closure and required C exports before installation", async t => {
  const root = temporary(t), good = path.join(root, "good"), future = path.join(root, "future"), external = path.join(root, "external");
  createApp(good); createApp(future, { minimum: 14 }); createApp(external, { dependency: "/opt/homebrew/lib/libsomething.dylib" });
  const options = { inspectExports: async () => [...Payload.REQUIRED_EXPORTS], systemVersionSync: () => "13.0" };
  await assert.rejects(Payload.preparePayload({ unpacked: future }, options), /requires macOS 14/);
  await assert.rejects(Payload.preparePayload({ unpacked: external }, options), /unbundled library dependency/);
  await assert.rejects(Payload.preparePayload({ unpacked: good }, { ...options, inspectExports: async (_file, { arch }) => arch === "arm64" ? [] : [...Payload.REQUIRED_EXPORTS] }), /launch interface/);
  fs.writeFileSync(path.join(good, Payload.LIBRARY_RELATIVE), thin(0x01000007, 6));
  await assert.rejects(Payload.preparePayload({ unpacked: good }, options), /universal Apple Silicon/);
});

test("RFVP rejects library aliases and cancels preparation before reading or publishing", async t => {
  const root = temporary(t), target = path.join(root, "target"), source = path.join(root, "source");
  const files = createApp(target); createApp(source); const alias = path.join(source, Payload.LIBRARY_RELATIVE);
  fs.rmSync(alias); fs.symlinkSync(files.library, alias);
  await assert.rejects(Payload.preparePayload({ unpacked: source }, { systemVersionSync: () => "13.0" }), /symbolic links/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Payload.preparePayload({ unpacked: "/missing", signal: controller.signal }), { name: "AbortError" });
});

test("RFVP rejects corrupted archive bytes before extraction and cleans staging", async t => {
  const root = temporary(t), row = pin("1".repeat(40), sha(Buffer.from("expected")), 8); let extracts = 0;
  const manager = fixtureManager({ rows: [row], dependencies: {
    downloadToFile: async (_url, target) => fs.writeFileSync(target, "modified"),
    extractArchive: async () => { extracts++; }
  } });
  await manager.refreshCatalog({ userDataDir: root, force: true });
  await assert.rejects(manager.core.installVersion({ userDataDir: root, version: row.version }), /SHA-256/);
  assert.equal(extracts, 0); assert.equal(fs.readdirSync(path.join(root, "runtimes", "rfvp")).some(name => name.startsWith(".install-")), false);
});

test("RFVP read-only disk image mounts detach after interrupted attach and copy failure", async t => {
  const root = temporary(t), calls = [];
  await assert.rejects(extractDmg(path.join(root, "runtime.dmg"), root, undefined, {
    run: async (_command, args) => { calls.push(args); if (args[0] === "attach") fs.mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "RFVP.app")); },
    copy: () => { throw new Error("copy failure"); }
  }), /copy failure/);
  assert.ok(calls[0].includes("-readonly")); assert.equal(calls[1][0], "detach"); assert.equal(fs.existsSync(calls[1][1]), false);
  const controller = new AbortController(); calls.length = 0;
  await assert.rejects(extractDmg(path.join(root, "runtime.dmg"), root, controller.signal, {
    run: async (_command, args, options) => {
      calls.push(args);
      if (args[0] === "attach") { controller.abort(); throw Object.assign(new Error("cancelled attach"), { name: "AbortError" }); }
      assert.equal(options.signal, undefined);
    }, copy: () => assert.fail("Cancelled attach must not copy")
  }), { name: "AbortError" });
  assert.equal(calls[1][0], "detach"); assert.equal(fs.existsSync(calls[1][1]), false);
});
