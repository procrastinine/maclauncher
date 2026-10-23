const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const crypto = require("node:crypto");
const { writeZipArchive } = require("./helpers/zip-fixture");
const { createManagedJavaTool } = require("../src/modules/shared/runtime/managed-java-tool");
const JavaHost = require("../src/modules/shared/runtime/java-tool-host");
const FlashTools = require("../src/modules/flash/tools");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, "example.jar");
  writeZipArchive(jar, [{ name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\nMain-Class: example.Main\nClass-Path: lib/dependency.jar LICENSE.txt\n" }]);
  const archive = path.join(root, "example.zip");
  writeZipArchive(archive, [{ name: "example.jar", data: fs.readFileSync(jar) },
    { name: "lib/dependency.jar", data: fs.readFileSync(jar) }, { name: "LICENSE.txt", data: "License" },
    { name: "example.exe", data: "Unused Windows launcher" }]);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const release = version => ({ tag_name: "v" + version, assets: [{ name: "example.zip", size: fs.statSync(archive).size,
    digest: "sha256:" + sha256, browser_download_url: `https://github.com/example/tool/releases/download/v${version}/example.zip` }] });
  const manager = createManagedJavaTool({ id: "test-java-tool", label: "Example", owner: "example", repo: "tool", jarName: "example.jar",
    releaseArtifact: row => ({ version: row.tag_name.slice(1), asset: row.assets[0] }) });
  return { root, archive, manager, release, userDataDir: path.join(root, "userData"),
    downloader: async (_url, target) => fs.copyFileSync(archive, target) };
}

test("independent decompiler prerequisites preserve caller and Downloads cancellation", async t => {
  const { DownloadManager } = require("../src/modules/shared/runtime/download-manager");
  const Jadx = require("../src/modules/android/tools/jadx-manager");
  const Ilspy = require("../src/modules/shared/runtime/managed-decompiler");
  const Dotnet = require("../src/modules/shared/runtime/dotnet-tool-host");
  const cases = [
    ["JADX", (context, dependencies) => Jadx.installRuntime({ ...context, version: "1.5.6" }, dependencies)],
    ["ILSpy", (context, dependencies) => Ilspy.ensureTool(context, Ilspy.DEFAULT_VERSION, dependencies)],
    ...(process.platform === "darwin" && process.arch === "arm64" ? [[".NET", (context, dependencies) => Dotnet.ensure(context,
      { framework: "net10.0", minimumVersion: Dotnet.PIN.version }, dependencies)]] : [])
  ];
  for (const [label, install] of cases) for (const origin of ["caller", "downloads"]) await t.test(label + " " + origin, async t => {
    const { userDataDir } = setup(t), caller = new AbortController(), downloads = new DownloadManager();
    let start, observedSignal; const ready = new Promise(resolve => { start = resolve; });
    const context = { userDataDir, signal: caller.signal, downloads, confirmRuntimeInstall: async () => true };
    const pending = install(context, { downloadToFile: async (_url, file, { signal, onProgress }) => {
      observedSignal = signal; fs.writeFileSync(file, "partial archive"); onProgress({ downloaded: 15, total: 100 }); start();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await ready;
    const task = downloads.list()[0]; assert.equal(task.downloaded, 15);
    try {
      if (origin === "caller") caller.abort(); else downloads.cancel(task.id);
      assert.equal(observedSignal.aborted, true, "Cancellation reaches the original prerequisite download");
    } finally { if (!observedSignal.aborted) downloads.cancel(task.id); await rejected; }
    assert.deepEqual(downloads.list(), []);
    const manager = label === "JADX" ? Jadx.core.resolve({ userDataDir, version: "1.5.6" })
      : label === "ILSpy" ? Ilspy.resolveTool({ userDataDir }) : Dotnet.resolve({ userDataDir, framework: "net10.0", minimumVersion: Dotnet.PIN.version });
    assert.equal(manager, null);
  });
});

test("Java tool catalogs show real stable releases and retain cache after failure", async t => {
  const { manager, release, userDataDir, downloader } = setup(t);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  await manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () =>
    [release("2.0.0"), release("1.0.0"), release("2.0.0"), { ...release("3.0.0"), prerelease: true }] });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["2.0.0", "1.0.0"]);
  await manager.installRuntime({ userDataDir, version: "1.0.0" }, { downloadToFile: downloader });
  await manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () => [release("2.0.0")] });
  assert.deepEqual(manager.getState({ userDataDir, settings: { defaultVersion: "1.0.0" } }).catalog.versions, ["2.0.0", "1.0.0"]);
  assert.equal(manager.getState({ userDataDir, settings: { defaultVersion: "1.0.0" } }).defaultVersion, "1.0.0");
  await assert.rejects(manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () => { throw new Error("Unavailable"); } }), /Unavailable/);
  const state = manager.getState({ userDataDir });
  assert.equal(state.catalog.status, "error");
  assert.deepEqual(state.catalog.versions, ["2.0.0", "1.0.0"]);
});

test("FFDec catalogs exclude legacy releases incompatible with the managed Java host", async t => {
  const { userDataDir } = setup(t), manager = require("../src/modules/flash/runtime/ffdec-manager");
  const releases = ["10.0.0", "11.0.0", "12.0.0", "26.3.0"].map(version => ({ tag_name: "version" + version,
    assets: [{ name: `ffdec_${version}.zip`, size: 10,
      browser_download_url: `https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version${version}/ffdec_${version}.zip` }] }));
  await manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () => releases });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["26.3.0", "12.0.0"]);
});

test("an explicit first tool action can install its verified pin when the release API fails", async t => {
  const { root, userDataDir, release, downloader } = setup(t), asset = release("1.0.0").assets[0];
  const manager = createManagedJavaTool({ id: "pinned-tool", label: "Example", owner: "example", repo: "tool", jarName: "example.jar",
    pins: [{ version: "1.0.0", tag: "v1.0.0", bytes: asset.size, sha256: asset.digest.slice(7), url: asset.browser_download_url }],
    releaseArtifact: row => ({ version: row.tag_name.slice(1), asset: row.assets[0] }) });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  let prompts = 0;
  const result = await manager.core.ensure({ userDataDir, settings: {}, confirmRuntimeInstall: async () => { prompts++; return true; } }, {}, {
    fetchReleases: async () => { throw new Error("Release API unavailable"); }, downloadToFile: downloader,
    ensureHost: async () => ({ javaPath: path.join(root, "java") }) });
  assert.equal(result.tool.version, "1.0.0"); assert.equal(prompts, 1);
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["1.0.0"]);
  assert.equal(manager.getState({ userDataDir }).catalog.status, "error");
});

test("missing tools require consent and installations verify publisher checksums", async t => {
  const { manager, release, userDataDir, downloader } = setup(t);
  await manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () => [release("1.0.0")] });
  let downloads = 0;
  const downloadToFile = async (...args) => { downloads++; await downloader(...args); };
  await assert.rejects(manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => false },
    { downloadToFile }), { code: "ABORT_ERR" });
  assert.equal(downloads, 0);
  const prompts = [];
  const install = await manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async plan => { prompts.push(plan); return true; } },
    { downloadToFile });
  assert.equal(prompts[0].kind, "tool");
  assert.equal(prompts[0].version, "1.0.0");
  assert.ok(fs.existsSync(path.join(install.root, "files", "lib", "dependency.jar")));
  assert.equal(fs.existsSync(path.join(install.root, "files", "example.exe")), false);
  await manager.installRuntime({ userDataDir, version: "1.0.0", confirmRuntimeInstall: async () => { throw new Error("No repeat prompt"); } }, { downloadToFile });
  assert.equal(downloads, 1);
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
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const release = { tag_name: "v1.0.0", assets: [{ name: "example.zip", size: fs.statSync(archive).size,
    digest: "sha256:" + sha256, browser_download_url: "https://github.com/example/tool/releases/download/v1.0.0/example.zip" }] };
  await manager.refreshCatalog({ userDataDir, force: true }, { fetchReleases: async () => [release] });
  await assert.rejects(manager.installRuntime({ userDataDir, version: "1.0.0" }, {
    downloadToFile: async (_url, target) => fs.copyFileSync(archive, target) }), /Java dependencies are incomplete/);
  assert.equal(manager.core.resolve({ userDataDir, version: "1.0.0" }), null);
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

test("Java tools reuse compatible hosts and prompt before automatic host installation", async t => {
  const { root } = setup(t), userDataDir = path.join(root, "hostUserData"), calls = [];
  let installed = { line: 17, version: "17.0.1+1", variant: "arm64", installDir: root, javaPath: path.join(root, "java") };
  const manager = { id: "java", normalizeSettings: () => ({ defaultLine: 21, lines: {
    17: { defaultVariant: "arm64" }, 21: { defaultVariant: "arm64" } } }),
    core: { java: { LTS_LINES: [17, 21], resolveBestInstalled: ({ line }) => installed?.line === line ? installed : null } },
    refreshCatalog: async () => calls.push("refresh"), getState: () => ({ sections: [{ id: "21", catalog: { versions: ["21.0.1+1"] } }] }),
    installRuntime: async data => { calls.push("install"); installed = { ...installed, ...data, javaPath: path.join(root, "java") }; } };
  const context = { userDataDir, settings: {}, confirmRuntimeInstall: async plan => { calls.push("consent"); assert.equal(plan.version, "21.0.1+1"); return true; } };
  const reused = await JavaHost.ensure(context, 17, { manager });
  assert.equal(reused.line, 17); assert.deepEqual(calls, []);
  installed = null;
  const acquired = await JavaHost.ensure(context, 17, { manager });
  assert.equal(acquired.line, 21); assert.deepEqual(calls, ["refresh", "consent", "install"]);
  installed = null; calls.length = 0;
  await assert.rejects(JavaHost.ensure({ ...context, confirmRuntimeInstall: async () => false }, 17, { manager }), { code: "ABORT_ERR" });
  assert.deepEqual(calls, ["refresh"]);
});
