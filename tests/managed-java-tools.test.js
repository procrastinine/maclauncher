// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const { createManagedJavaTool } = require("../src/modules/shared/runtime/managed-java-tool");
const Upstream = require("../src/modules/shared/runtime/upstream");
const UpstreamTransport = require("../src/modules/shared/runtime/upstream-transport");
const JavaHost = require("../src/modules/shared/runtime/java-tool-host");
const FlashTools = require("../src/modules/flash/tools");
const IlspyFixture = require("./helpers/ilspy-catalog-fixture.cjs");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, "example.jar");
  writeZipArchive(jar, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\nClass-Path: lib/dependency.jar LICENSE.txt\n" }]);
  const archive = path.join(root, "example.zip");
  writeZipArchive(archive, [{ name: "example.jar", data: fs.readFileSync(jar) },
    { name: "lib/dependency.jar", data: fs.readFileSync(jar) }, { name: "LICENSE.txt", data: "License" },
    { name: "example.exe", data: "Unused Windows launcher" }]);
  const release = (version, extra, file = archive) => published("example/tool", "v" + version, file, extra);
  const manager = createManagedJavaTool({ id: "test-java-tool", label: "Example", upstream: example(), jarName: "example.jar" });
  return { root, archive, manager, release, userDataDir: path.join(root, "userData") };
}
// A GitHub release of one file whose listed size and digest are the file's own.
function published(repository, tag, file, extra) {
  const release = Harness.githubRelease(repository, tag, [path.basename(file)], extra), bytes = fs.readFileSync(file);
  release.assets[0] = { ...release.assets[0], size: bytes.length, digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex") };
  return release;
}
const example = () => Upstream.github({ repository: "example/tool", recognize: release =>
  ({ version: release.tag_name.slice(1), assets: [release.assets[0]] }) });
// Routes for a repository's releases and their downloads. `events` records
// each discovery and download; `files` maps a release asset to local bytes.
function routes(repository, releases, { events, files = {}, discover } = {}) {
  const result = Harness.githubRoutes(repository, releases), list = `https://api.github.com/repos/${repository}/releases`;
  const listing = result[list];
  result[list] = () => { events?.push("discover"); return discover ? discover() : listing; };
  for (const release of releases) for (const asset of release.assets) {
    const file = files[asset.name];
    if (file) result[asset.browser_download_url] = () => { events?.push("download"); return typeof file === "function" ? file() : fs.readFileSync(file); };
  }
  return result;
}
async function online(network, action) {
  Harness.network.routes = network;
  try { return await action(); } finally { Harness.network.routes = null; }
}

test("independent decompiler prerequisites preserve caller and Downloads cancellation", async t => {
  const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
  const Jadx = require("../src/modules/android/tools/jadx-manager");
  const Ilspy = require("../src/modules/shared/runtime/managed-decompiler");
  const IlspyManager = require("../src/modules/shared/runtime/ilspy-manager");
  const Dotnet = require("../src/modules/shared/runtime/dotnet-tool-host");
  const dotnet = { version: "10.0.42", url: "https://builds.dotnet.microsoft.com/dotnet/Runtime/10.0.42/dotnet-runtime-10.0.42-osx-arm64.tar.gz", sha512: "a".repeat(128) };
  const cases = [
    ["JADX", (context, dependencies) => Jadx.installRuntime({ ...context, version: "1.5.6" }, dependencies)],
    ["ILSpy", (context, dependencies) => Ilspy.ensureTool(context, "11.1.0.9782", dependencies)],
    ...(process.platform === "darwin" && process.arch === "arm64" ? [[".NET", (context, dependencies) => Dotnet.ensure(context,
      { framework: "net10.0", minimumVersion: dotnet.version }, dependencies)]] : [])
  ];
  for (const [label, install] of cases) for (const origin of ["caller", "downloads"]) await t.test(label + " " + origin, async t => {
    const { userDataDir } = setup(t), caller = new AbortController(), downloads = new DownloadManager();
    let start, observedSignal; const ready = new Promise(resolve => { start = resolve; });
    const context = { userDataDir, signal: caller.signal, downloads, confirmRuntimeInstall: async () => true };
    if (label === "ILSpy") await online(IlspyFixture.nuget([IlspyFixture.metadata("11.1.0.9782")]),
      () => IlspyManager.refreshCatalog({ userDataDir, force: true }));
    if (label === "JADX") await online(Harness.githubRoutes("skylot/jadx", [Harness.githubRelease("skylot/jadx", "v1.5.6", ["jadx-1.5.6.zip"])]),
      () => Jadx.refreshCatalog({ userDataDir, force: true }));
    // Only the .NET release metadata is online; the cached tool catalogs need no discovery.
    Harness.network.routes = { "https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json": { releases: [{ runtime: {
      version: dotnet.version, files: [{ name: "dotnet-runtime-osx-arm64.tar.gz", rid: "osx-arm64", url: dotnet.url, hash: dotnet.sha512 }] } }] } };
    const previous = UpstreamTransport.downloadToFile;
    UpstreamTransport.downloadToFile = async (_url, file, { signal, onProgress }) => {
      observedSignal = signal; fs.writeFileSync(file, "partial archive"); onProgress({ downloaded: 15, total: 100 }); start();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    t.after(() => { UpstreamTransport.downloadToFile = previous; Harness.network.routes = null; });
    const pending = install(context);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await Promise.race([ready, pending]);
    const task = downloads.list()[0]; assert.equal(task.downloaded, 15);
    try {
      if (origin === "caller") caller.abort(); else downloads.cancel(task.id);
      assert.equal(observedSignal.aborted, true, "Cancellation reaches the original prerequisite download");
    } finally { if (!observedSignal.aborted) downloads.cancel(task.id); await rejected; }
    assert.deepEqual(downloads.list(), []);
    const manager = label === "JADX" ? Jadx.core.resolve({ userDataDir, version: "1.5.6" })
      : label === "ILSpy" ? Ilspy.resolveTool({ userDataDir, version: "11.1.0.9782" }) : Dotnet.resolve({ userDataDir, framework: "net10.0", minimumVersion: dotnet.version });
    assert.equal(manager, null);
  });
});

test("cold tool install and preparation discover catalogs only after consent", async t => {
  const { manager, userDataDir } = setup(t);
  const Ilspy = require("../src/modules/shared/runtime/managed-decompiler");
  const IlspyManager = require("../src/modules/shared/runtime/ilspy-manager");
  let confirmations = 0;
  const context = { userDataDir, confirmRuntimeInstall: async () => { confirmations++; return false; } };
  const requests = Harness.network.requests.length;
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.deepEqual(IlspyManager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(confirmations, 0);
  for (const version of [undefined, "1.0.0"]) {
    await assert.rejects(manager.installRuntime({ ...context, version }), { code: "ABORT_ERR" });
    await assert.rejects(manager.core.ensure(context, { version }), { code: "ABORT_ERR" });
  }
  for (const version of [undefined, "11.1.0.9782"]) {
    await assert.rejects(Ilspy.ensureTool(context, version), { code: "ABORT_ERR" });
    await assert.rejects(IlspyManager.installRuntime({ ...context, version }), { code: "ABORT_ERR" });
  }
  assert.equal(Harness.network.requests.length, requests, "Declined consent makes no network request");
  assert.equal(confirmations, 8);
  const events = [], version = "12.0.0.9999", Catalog = require("../src/modules/shared/runtime/ilspy-catalog");
  const listing = IlspyFixture.nuget([IlspyFixture.metadata(version)]), registration = IlspyFixture.BASE + "ilspycmd/index.json";
  await assert.rejects(online({ ...listing, [registration]: () => { events.push("discover"); return listing[registration]; },
    [Catalog.packageUrl(version)]: () => { events.push("download"); return { status: 503, body: Buffer.alloc(0) }; } },
    () => Ilspy.ensureTool({ ...context, confirmRuntimeInstall: async () => { events.push("consent"); return true; } }, version)), /HTTP 503/);
  assert.deepEqual(events, ["consent", "discover", "download"]);
  assert.deepEqual(IlspyManager.getState({ userDataDir }).catalog.versions, [version]);
});

test("Java tool catalogs show real stable releases and retain cache after failure", async t => {
  const { manager, release, userDataDir, archive } = setup(t);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const releases = [{ ...release("3.0.0"), prerelease: true }, release("2.0.0"), release("2.0.0"), release("1.0.0")];
  await online(routes("example/tool", releases), () => manager.refreshCatalog({ userDataDir, force: true }));
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2.0.0", "1.0.0"]);
  await online(routes("example/tool", releases, { files: { "example.zip": archive } }),
    () => manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => true }));
  await online(routes("example/tool", [release("2.0.0")]), () => manager.refreshCatalog({ userDataDir, force: true }));
  assert.deepEqual(manager.getState({ userDataDir, settings: { defaultVersion: "1.0.0" } }).catalog.versions, ["2.0.0"]);
  assert.equal(manager.getState({ userDataDir, settings: { defaultVersion: "1.0.0" } }).defaultVersion, "1.0.0");
  await assert.rejects(online({}, () => manager.refreshCatalog({ userDataDir, force: true })));
  const state = manager.getState({ userDataDir });
  assert.equal(state.catalog.status, "error");
  assert.deepEqual(state.catalog.versions, ["2.0.0"]);
});

test("FFDec catalogs exclude legacy releases incompatible with the managed Java host", async t => {
  const { userDataDir } = setup(t), manager = require("../src/modules/flash/runtime/ffdec-manager");
  const repository = "jindrapetrik/jpexs-decompiler", releases = ["26.3.0", "12.0.0", "11.0.0", "10.0.0"]
    .map(version => Harness.githubRelease(repository, "version" + version, [`ffdec_${version}.zip`]));
  await online(Harness.githubRoutes(repository, releases), () => manager.refreshCatalog({ userDataDir, force: true }));
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["26.3.0", "12.0.0"]);
});

test("tool actions consent before discovery and preserve catalog defaults and exact choices", async t => {
  const { root, userDataDir, release, archive, manager } = setup(t);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  let prompts = 0;
  const requests = [], releases = [release("2.0.0"), release("1.0.0")];
  const unavailable = routes("example/tool", releases, { events: requests, discover: () => ({ status: 503, body: Buffer.alloc(0) }) });
  const dependencies = { ensureHost: async () => ({ javaPath: path.join(root, "java") }) };
  await assert.rejects(online(unavailable, () => manager.core.ensure({ userDataDir, settings: {},
    confirmRuntimeInstall: async () => { prompts++; return false; } }, {}, dependencies)), { code: "ABORT_ERR" });
  assert.equal(requests.length, 0);
  await assert.rejects(online(unavailable, () => manager.core.ensure({ userDataDir, settings: {},
    confirmRuntimeInstall: async () => { prompts++; return true; } }, {}, dependencies)), /503/);
  assert.equal(prompts, 2); assert.deepEqual(requests, ["discover"]);
  assert.equal(manager.getState({ userDataDir }).defaultVersion, null);
  const events = [], network = routes("example/tool", releases, { events, files: { "example.zip": archive } });
  const context = { userDataDir: path.join(root, "second-profile"), settings: {}, confirmRuntimeInstall: async () => { events.push("consent"); return true; } };
  const result = await online(network, () => manager.core.ensure(context, {}, dependencies));
  assert.equal(result.tool.version, "2.0.0");
  assert.deepEqual(events, ["consent", "discover", "download"]);
  await online(network, () => manager.core.ensure({ ...context, confirmRuntimeInstall: () => assert.fail("Installed fallback remains offline") }, {}, dependencies));
  assert.deepEqual(events, ["consent", "discover", "download"], "Installed reuse neither discovers nor downloads");
  assert.equal((await manager.core.ensure({ ...context, settings: { runtimes: { [manager.id]: { defaultVersion: null } } } }, {}, dependencies)).tool.version, "2.0.0");
  assert.equal(manager.updateSettingsAfterInstall({}, result.tool).defaultVersion, "2.0.0");
});

test("missing tools require consent and installations verify publisher checksums", async t => {
  const { manager, release, userDataDir, archive } = setup(t), events = [];
  Harness.network.routes = routes("example/tool", [release("1.0.0")], { events, files: { "example.zip": archive } });
  t.after(() => { Harness.network.routes = null; });
  await manager.refreshCatalog({ userDataDir, force: true });
  const downloadCount = () => events.filter(event => event === "download").length;
  await assert.rejects(manager.installRuntime({ userDataDir, version: "1.0.0" }), { code: "ABORT_ERR" });
  await assert.rejects(manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => false }), { code: "ABORT_ERR" });
  assert.equal(downloadCount(), 0);
  const prompts = [];
  const install = await manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async plan => { prompts.push(plan); return true; } });
  assert.equal(prompts[0].kind, "tool");
  assert.equal(prompts[0].version, "1.0.0");
  assert.ok(fs.existsSync(path.join(install.root, "files", "lib", "dependency.jar")));
  assert.equal(fs.existsSync(path.join(install.root, "files", "example.exe")), false);
  await manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => { throw new Error("No repeat prompt"); } });
  assert.equal(downloadCount(), 1);
  assert.equal((await manager.installRuntime({ userDataDir, confirmRuntimeInstall: () => assert.fail("Installed fallback remains offline") })).version, install.version);
  assert.deepEqual(manager.updateSettingsAfterUninstall({ defaultVersion: install.version }, { version: install.version }), { defaultVersion: null });
  const original = fs.readFileSync(install.jarPath), corrupt = Buffer.from(original); corrupt[0] ^= 1;
  fs.writeFileSync(install.jarPath, corrupt);
  assert.equal(manager.core.resolve({ userDataDir, version: "1.0.0" }), null);
});

test("tool ZIP extraction rejects traversal, duplicate names and incomplete applications", t => {
  const { root, manager } = setup(t), target = path.join(root, "output"); fs.mkdirSync(target);
  const archive = path.join(root, "unsafe.zip");
  writeZipArchive(archive, [{ name: "../example.jar", data: "bad" }]);
  assert.throws(() => manager.core.extract(archive, target), /unsafe/);
  writeZipArchive(archive, [{ name: "example.jar", data: "one" }, { name: "example.jar", data: "two" }]);
  assert.throws(() => manager.core.extract(archive, target), /unsafe/);
  fs.rmSync(path.join(target, "example.jar"));
  writeZipArchive(archive, [{ name: "README.md", data: "No application" }]);
  assert.throws(() => manager.core.extract(archive, target), /missing/);
});

test("tool installation rejects a missing dependency named by the Java manifest", async t => {
  const { root, manager, userDataDir } = setup(t), jar = path.join(root, "incomplete.jar"), archive = path.join(root, "incomplete.zip");
  writeZipArchive(jar, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\nClass-Path: lib/missing.jar\n" }]);
  writeZipArchive(archive, [{ name: "example.jar", data: fs.readFileSync(jar) }]);
  const release = published("example/tool", "v1.0.0", archive);
  await online(routes("example/tool", [release], { files: { "incomplete.zip": archive } }), async () => {
    await manager.refreshCatalog({ userDataDir, force: true });
    await assert.rejects(manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => true }), /Java dependencies are incomplete/);
  });
  assert.equal(manager.core.resolve({ userDataDir, version: "1.0.0" }), null);
});

test("standalone Java tools retain the published JAR and apply normal checksum and manifest validation", async t => {
  const { root, userDataDir } = setup(t), jar = path.join(root, "standalone.jar");
  writeZipArchive(jar, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\n" },
    { name: "LICENSE", data: "Original upstream notice" }]);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(jar)).digest("hex"), release = published("example/tool", "v1.0.0", jar);
  const manager = createManagedJavaTool({ id: "standalone-java-tool", label: "Standalone", upstream: example(),
    jarName: "standalone.jar", standaloneJar: true });
  const installed = await online(routes("example/tool", [release], { files: { "standalone.jar": jar } }), async () => {
    await manager.refreshCatalog({ userDataDir, force: true });
    return manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => true });
  });
  assert.deepEqual(fs.readFileSync(installed.jarPath), fs.readFileSync(jar));
  assert.equal(installed.archiveSha256, sha256);
  assert.equal(installed.requiredJava, 17);
  const other = path.join(root, "other-profile");
  await online(routes("example/tool", [release], { files: { "standalone.jar": () => Buffer.from("corrupt") } }), async () => {
    await manager.refreshCatalog({ userDataDir: other, force: true });
    await assert.rejects(manager.installRuntime({ userDataDir: other, version: "1.0.0", confirmRuntimeInstall: async () => true }), /does not match/);
  });
});

test("Infinity Engine inspector passes the original resource index with automatic network checks disabled", async t => {
  const { root, userDataDir } = setup(t), gameRoot = path.join(root, "Original game $literal"); fs.mkdirSync(gameRoot);
  const key = path.join(gameRoot, "CHITIN.KEY"); fs.writeFileSync(key, "KEY V1");
  const module = require("../src/modules/gemrb/main"), manager = require("../src/modules/gemrb/runtime/near-infinity-manager");
  const previous = manager.core.run, calls = [], context = { userDataDir }, payload = { version: "2.4-20260616" };
  t.after(() => { manager.core.run = previous; });
  manager.core.run = async (...args) => { calls.push(args); return { toolVersion: payload.version }; };
  await module.actions.openInspector({ contentRootDir: gameRoot }, payload, context);
  assert.equal(calls[0][0], context); assert.equal(calls[0][1], payload);
  assert.deepEqual(calls[0][2].args, ["-no-update", "-no-launch-game", key]);
  assert.equal(calls[0][2].gui, true); assert.equal(calls[0][2].cwd, gameRoot);
  assert.equal(fs.readFileSync(key, "utf8"), "KEY V1");
});

test("Flash exports publish atomically, preserve original data and retain an earlier export on failure", async t => {
  const { root, userDataDir } = setup(t), source = path.join(root, "game $literal.swf"); fs.writeFileSync(source, "FWS-data");
  const entry = { gameId: "flash-game", gamePath: source, moduleData: {} }, context = { userDataDir };
  const options = [];
  const first = await FlashTools.exportGame(entry, {}, context, { run: async (_context, _payload, command) => {
    options.push(command); fs.writeFileSync(path.join(command.cwd, "game.as"), "trace('example');"); return { toolVersion: "26.3.0" };
  } });
  assert.ok(fs.existsSync(path.join(first.outputDir, "game.as")));
  assert.ok(options[0].args.includes(source));
  assert.ok(options[0].args.includes("check.updates.enabled=false"));
  assert.equal(fs.readFileSync(source, "utf8"), "FWS-data");
  await assert.rejects(FlashTools.exportGame(entry, {}, context, { run: async () => { throw new Error("Export failed"); } }), /Export failed/);
  assert.equal(fs.readFileSync(path.join(first.outputDir, "game.as"), "utf8"), "trace('example');");
  await assert.rejects(FlashTools.exportGame(entry, {}, context, { run: async () => { fs.writeFileSync(source, "Changed"); return {}; } }), /changed during export/);
  assert.deepEqual(fs.readdirSync(path.dirname(first.outputDir)), ["scripts"]);
});

test("Java tools reuse selected or compatible installed hosts and consent before cold catalog fallback", async t => {
  const { root } = setup(t), userDataDir = path.join(root, "hostUserData"), calls = [];
  let sections = [], chosen = "17.0.1+1", chosenLine = 17;
  let installed = { line: 17, version: "17.0.1+1", variant: "arm64", installDir: root, javaPath: path.join(root, "java") };
  const manager = { id: "java", normalizeSettings: () => ({ defaultLine: chosen ? chosenLine : null, lines: {
    17: { defaultVariant: "arm64", defaultVersion: chosenLine === 17 ? chosen : null }, 21: { defaultVariant: "arm64", defaultVersion: chosenLine === 21 ? chosen : null } } }),
    core: { java: { LTS_LINES: [17, 21], resolveBestInstalled: ({ line, version }) => installed?.line === line && (!version || installed.version === version) ? installed : null } },
    refreshCatalog: async ({sectionId}) => { calls.push("refresh:"+sectionId); sections.push({id:sectionId,catalog:{versions:[sectionId+".0.1+1"]}}); },
    getState: () => ({ sections: [17,21].map(line => ({id:String(line),installed:installed?.line===line?[installed]:[],
      catalog:sections.find(row=>row.id===String(line))?.catalog||{versions:[]}})) }),
    installRuntime: async data => { calls.push("install"); installed = { ...installed, ...data, javaPath: path.join(root, "java") }; } };
  const context = { userDataDir, settings: {}, confirmRuntimeInstall: async plan => { calls.push("consent"); assert.equal(plan.version, chosen); return true; } };
  const reused = await JavaHost.ensure(context, 17, { manager });
  assert.equal(reused.line, 17); assert.deepEqual(calls, []);
  chosen = null;
  assert.equal((await JavaHost.ensure(context, 17, { manager })).line, 17);
  assert.deepEqual(calls, [], "Compatible installed hosts remain offline");
  installed = null;
  assert.equal((await JavaHost.ensure(context, 17, { manager })).version, "17.0.1+1");
  assert.deepEqual(calls, ["consent", "refresh:17", "install"]);
  installed = null; chosenLine = 21; chosen = "21.0.1+1"; calls.length = 0;
  const acquired = await JavaHost.ensure(context, 17, { manager });
  assert.equal(acquired.line, 21); assert.deepEqual(calls, ["consent", "install"]);
  installed = null; sections = []; chosen = null; calls.length = 0;
  await assert.rejects(JavaHost.ensure({ ...context, confirmRuntimeInstall: async () => false }, 17, { manager }), { code: "ABORT_ERR" });
  assert.deepEqual(calls, [], "Declined host consent cannot query release metadata");
});


test("held coarse JAR times recheck installed tool bytes while status remains metadata only", async t => {
  const {holdFileTimes} = require("./helpers/held-file-times.cjs"), {manager, release, userDataDir, archive} = setup(t);
  Harness.network.routes = routes("example/tool", [release("1.0.0")], {files: {"example.zip": archive}});
  t.after(() => {Harness.network.routes = null;});await manager.refreshCatalog({userDataDir, force: true});
  const installed = await manager.installRuntime({userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => true});
  holdFileTimes(t, [installed.jarPath]);assert.ok(manager.core.resolve({userDataDir, version: "1.0.0"}));
  const bytes = fs.readFileSync(installed.jarPath);bytes[0] ^= 1;fs.writeFileSync(installed.jarPath, bytes);
  assert.ok(manager.core.resolve({userDataDir, version: "1.0.0", verification: "status"}));
  assert.equal(manager.core.resolve({userDataDir, version: "1.0.0"}), null);
});
