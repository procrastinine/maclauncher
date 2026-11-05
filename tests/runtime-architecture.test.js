const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Architecture = require("../src/modules/shared/runtime/architecture");
const {createPinnedNativeManager} = require("../src/modules/shared/runtime/pinned-native-manager");
const {listedManager} = require("./helpers/listed-rows.cjs");
function executable(architecture) {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(2, 12); return data;
}
test("same-version CPU builds coexist, survive both launcher defaults, and remove independently", {skip: process.platform !== "darwin"}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architectures-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const catalog = ["arm64", "x64"].map(arch => ({version: "1.0", upstreamRevision: arch, architecture: arch === "x64" ? "x86_64" : arch, hostArchitectures: [arch]}));
  const create = architecture => Architecture.withArchitecture(architecture, () => createPinnedNativeManager({id: "cpu-fixture", label: "CPU fixture", discoverCatalog: async () => catalog, importLocal: true}));
  const apple = create("arm64");
  await apple.refreshCatalog({userDataDir: directory, force: true});
  const intel = create("x64");
  for (const arch of ["arm64", "x64"]) {
    const file = path.join(directory, arch); fs.writeFileSync(file, executable(arch), {mode: 0o755});
    await apple.importRuntime({userDataDir: directory, architecture: arch, version: "1.0", runtimePath: file});
  }
  for (const manager of [apple, intel]) {
    const rows = manager.getState({userDataDir: directory}).installed;
    assert.deepEqual(rows.map(row => row.architecture).sort(), ["arm64", "x64"]);
    assert.equal(new Set(rows.map(row => row.installDir)).size, 2);
    assert.equal(manager.resolveSelection({}, {}, directory, {version: "1.0", architecture: "arm64"}).install.upstreamRevision, "arm64");
    assert.equal(manager.resolveSelection({}, {}, directory, {version: "1.0", architecture: "x64"}).install.upstreamRevision, "x64");
  }
  const saved = apple.applySettingsUpdate("setDefault", {version: "1.0", architecture: "x64"}, {});
  assert.equal(saved.defaultArchitecture, "x64");
  assert.equal(intel.normalizeSettings(saved).defaultArchitecture, "x64");
  await intel.uninstallRuntime({userDataDir: directory, version: "1.0", architecture: "x64"});
  assert.deepEqual(apple.getState({userDataDir: directory}).installed.map(row => row.architecture), ["arm64"]);
});
test("architecture context is asynchronous and defaults to the launcher process", async () => {
  assert.equal(Architecture.defaultArchitecture(), process.arch);
  const other = process.arch === "arm64" ? "x64" : "arm64";
  assert.equal(await Architecture.withArchitecture(other, async () => {await Promise.resolve(); return Architecture.selectedArchitecture();}), other);
  assert.equal(Architecture.selectedArchitecture(), process.arch);
  const manager = await listedManager({id: "target-fixture", label: "Target fixture"}, [
    {version: "1.0", architecture: "universal", upstreamRevision: "universal-source"},
    {version: "1.0", architecture: process.arch, upstreamRevision: "native-source"}]);
  assert.equal(manager.core.catalog[0].upstreamRevision, "native-source");
  assert.equal(manager.normalizeSettings({defaultArchitecture: "universal"}).defaultArchitecture, undefined);
  assert.equal(manager.resolveSelection({}, {runtimes: {"target-fixture": {defaultArchitecture: "universal"}}}).architecture, process.arch);
});
test("CPU-specific discovery keeps both architecture catalogs without reusing mapped rows", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architecture-catalog-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const calls = [];
  const manager = createPinnedNativeManager({id: "cpu-catalog", label: "CPU catalog", discoverCatalog: async ({arch}) => {
    calls.push(arch);
    return [{version: "1.0", architecture: arch, upstreamRevision: arch, localBuild: false,
      asset: {url: `https://example.test/${arch}.zip`, filename: `${arch}.zip`, sha256: "a".repeat(64)}}];
  }});
  await manager.refreshCatalog({userDataDir: directory});
  assert.deepEqual(calls.sort(), ["arm64", "x64"]);
  const catalogs = manager.getState({userDataDir: directory}).catalog.architectureCatalogs;
  for (const arch of ["arm64", "x64"]) assert.equal(catalogs[arch].versionRequirements["1.0"].architecture, arch);
});
test("Automatic and default lists prefer the launcher CPU across distinct publisher version IDs", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architecture-default-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const rows = ["x64", "arm64"].map(architecture => ({version: `0.9.2-${architecture === "x64" ? "x86_64" : "arm64"}`, architecture,
    upstreamRevision: architecture, asset: {url: `https://example.test/${architecture}.zip`, filename: `${architecture}.zip`, sha256: "a".repeat(64)}}));
  for (const architecture of ["arm64", "x64"]) {
    const manager = Architecture.withArchitecture(architecture, () => createPinnedNativeManager({id: "publisher-cpus", label: "Publisher CPUs", discoverCatalog: async () => rows}));
    await manager.refreshCatalog({userDataDir: directory, force: true});
    const expected = rows.find(row => row.architecture === architecture).version;
    assert.equal(manager.resolveSelection({}, {}, directory).version, expected);
    const state = manager.getState({userDataDir: directory});
    assert.deepEqual(state.catalog.versions, [expected]);
    const other = architecture === "arm64" ? "x64" : "arm64";
    assert.deepEqual(state.catalog.architectureCatalogs[other].versions, [rows.find(row => row.architecture === other).version]);
  }
});
test("an Intel default does not label an Apple Silicon-only package as Intel", async t => {
  // The Intel app on Apple Silicon uses the Apple Silicon build automatically;
  // an Intel Mac lists nothing it could run.
  for (const hardwareArch of ["arm64", "x64"]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architecture-arm-only-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const manager = Architecture.withArchitecture("x64", () => createPinnedNativeManager({id: "arm-only", label: "Arm only", discoverCatalog: async () => [{
      version: "1.0", upstreamRevision: "arm64", hostArchitectures: ["arm64"],
      asset: {url: "https://example.test/arm64.zip", filename: "arm64.zip", sha256: "a".repeat(64)} }],
      dependencies: {hostCapabilities: {platform: "darwin", hardwareArch, rosettaAvailable: hardwareArch === "arm64"}}}));
    await manager.refreshCatalog({userDataDir: directory});
    const state = manager.getState({userDataDir: directory});
    assert.deepEqual(state.catalog.architectureCatalogs.arm64.versions, ["1.0"]);
    assert.deepEqual(state.catalog.architectureCatalogs.x64.versions, []);
    assert.equal(state.automaticArchitecture, hardwareArch === "arm64" ? "arm64" : "x64");
    assert.deepEqual(state.catalog.versions, hardwareArch === "arm64" ? ["1.0"] : []);
    const selected = manager.resolveSelection({}, {}, directory);
    assert.equal(selected.version, hardwareArch === "arm64" ? "1.0" : null);
    assert.equal(selected.architecture, hardwareArch === "arm64" ? "arm64" : "x64");
  }
});
test("Universal installs and legacy sibling directories are reused by both app CPUs without acquisition", {skip: process.platform !== "darwin"}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architecture-universal-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bytes = Buffer.alloc(112); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, architecture] of ["arm64", "x64"].entries()) {
    const start = 8 + index * 20, offset = 48 + index * 32;
    bytes.writeUInt32BE(architecture === "arm64" ? 0x0100000c : 0x01000007, start);
    bytes.writeUInt32BE(offset, start + 8); bytes.writeUInt32BE(32, start + 12);
    executable(architecture).copy(bytes, offset);
  }
  const file = path.join(directory, "universal-tool"); fs.writeFileSync(file, bytes, {mode: 0o755});
  for (const declared of [true, false]) {
    const id = declared ? "declared-universal" : "inspected-universal";
    const config = {id, label: "Universal", importLocal: true};
    const rows = [{version: "1.0", upstreamRevision: "universal-source", ...(declared ? {architecture: "universal"} : {})}];
    const apple = Architecture.withArchitecture("arm64", () => createPinnedNativeManager({...config, discoverCatalog: async () => rows}));
    await apple.refreshCatalog({userDataDir: directory, force: true});
    const intel = Architecture.withArchitecture("x64", () => createPinnedNativeManager({...config,
      discoverCatalog: () => assert.fail("An installed Universal build must stay offline")}));
    const imported = await apple.importRuntime({userDataDir: directory, architecture: "arm64", version: "1.0", runtimePath: file});
    assert.equal(imported.architecture, "universal");
    const reused = await intel.installRuntime({userDataDir: directory, architecture: "x64", version: "1.0"});
    assert.equal(reused.installDir, imported.installDir);
    assert.equal(intel.getState({userDataDir: directory}).installed.length, 1);
    const legacy = path.join(directory, "runtimes", id, "1.0");
    fs.renameSync(imported.installDir, legacy);
    assert.equal(intel.resolveSelection({}, {}, directory, {version: "1.0", architecture: "x64"}).install.installDir, legacy);
    assert.equal(apple.resolveSelection({}, {}, directory, {version: "1.0", architecture: "arm64"}).install.installDir, legacy);
  }
});
test("one Intel package is reused across CPU and flat layouts without duplicate rows or downloads", {skip: process.platform !== "darwin"}, async t => {
  const {createHash} = require("node:crypto");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const bytes = executable("x64"), archiveSha256 = hash("same publisher archive");
  for (const layouts of [["arm64"], [""], ["x64"], ["universal"], ["arm64", ""]]) await t.test(layouts.join(" + ") || "flat", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-shared-intel-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const pin = {version: "1.0", upstreamRevision: "same-source", hostArchitectures: ["arm64", "x64"],
      asset: {url: "https://example.test/engine.zip", filename: "engine.zip", sha256: archiveSha256}};
    for (const layout of layouts) {
      const installed = path.join(directory, "runtimes/shared-intel", layout, pin.version);
      fs.mkdirSync(installed, {recursive: true});
      fs.writeFileSync(path.join(installed, "engine"), bytes, {mode: 0o755});
      fs.writeFileSync(path.join(installed, "runtime.json"), JSON.stringify({version: pin.version,
        upstreamRevision: pin.upstreamRevision, architecture: "x64", source: "download", catalogEntry: pin,
        executableRelative: "engine", binarySha256: hash(bytes), archiveSha256}));
    }
    let downloads = 0;
    const manager = Architecture.withArchitecture("arm64", () => createPinnedNativeManager({id: "shared-intel", label: "Shared Intel",
      discoverCatalog: async () => [pin], resolveExecutable: root => path.join(root, "engine"),
      dependencies: {hostArch: "arm64", hostCapabilities: {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true},
        downloadToFile: () => { downloads++; assert.fail("A verified package must be reused without downloading"); },
        extractArchive: () => assert.fail("An existing package needs no extraction")}}));
    await manager.refreshCatalog({userDataDir: directory, force: true});
    const expected = path.join(directory, "runtimes/shared-intel", layouts.includes("") ? "" : layouts[0], pin.version);
    for (const architecture of ["arm64", "x64"]) {
      const installed = await manager.installRuntime({userDataDir: directory, version: pin.version, architecture});
      assert.equal(installed.installDir, expected);
      assert.equal(installed.binarySha256, hash(bytes));
      assert.equal(installed.needsRosetta, true);
    }
    const rows = manager.getState({userDataDir: directory}).installed;
    assert.equal(rows.length, 1, "Both build choices resolve the same existing package");
    assert.equal(rows[0].installDir, expected);
    assert.equal(rows[0].ready, true);
    assert.equal(downloads, 0);
  });
});
test("a Builds record published later for the other CPU appears in the catalog with no code change", async t => {
  const {createProjectBuildManager} = require("../src/modules/shared/runtime/project-build-manager");
  const projectId = "later-cpu", repository = "ExampleOwner/runtime-builds", version = "1.0.0-MCLv1";
  const record = arch => {
    const tag = `${projectId}/v${version}/${arch}`, filename = `${projectId}-${version}-${arch}.tar.gz`;
    return {schemaVersion: 2, id: projectId, version, arch, launcherArchitectures: [arch], minimumMacOS: "13.0",
      manifestRelative: "runtime.json", manifestSha256: "a".repeat(64), sourceSha256: "b".repeat(64), updatePolicy: "manual", tag,
      asset: {filename, bytes: 1, sha256: (arch === "x64" ? "c" : "d").repeat(64),
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}`}};
  };
  let packages;
  const fetchUrlBuffer = async () => ({status: 200, body: Buffer.from(JSON.stringify({schemaVersion: 2, projectId, updatePolicy: "manual", packages}))});
  const recordCPU = catalog => Architecture.normalizeArchitecture(catalog?.versionRequirements?.[version]?.architecture);
  for (const launcher of ["arm64", "x64"]) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-architecture-later-${launcher}-`));
    t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
    const other = launcher === "arm64" ? "x64" : "arm64";
    const manager = Architecture.withArchitecture(launcher, () => createProjectBuildManager({projectId, label: "Later CPU", repository,
      manifestRelative: "runtime.json", sourceRelative: null, executableRelative: "native", validateManifest: () => {}, verifyPayload: () => {},
      dependencies: {systemVersionSync: () => "26.0", fetchUrlBuffer, hostCapabilities: {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true}}}));
    // The project first publishes only the other CPU's build.
    packages = [record(other)];
    await manager.refreshCatalog({userDataDir, force: true});
    let state = manager.getState({userDataDir});
    // Apple Silicon offers an Intel-only build through Rosetta; the Intel app on
    // Apple Silicon uses an Apple Silicon-only build automatically.
    assert.deepEqual(state.catalog.versions, [version], `${launcher}: only the other CPU's build is published`);
    assert.equal(recordCPU(state.catalog), other);
    assert.deepEqual(state.catalog.architectureCatalogs[other].versions, [version]);
    // A later publication adds this launcher's CPU. The same release reads it.
    packages = [record(other), record(launcher)];
    await manager.refreshCatalog({userDataDir, force: true});
    state = manager.getState({userDataDir});
    assert.deepEqual(state.catalog.versions, [version], `${launcher}: the new record is listed by default`);
    assert.equal(recordCPU(state.catalog), launcher, `${launcher}: the launcher's own CPU replaces the Rosetta build`);
    assert.equal(state.defaultVersion, version);
    assert.equal(manager.resolveSelection(null, {}, userDataDir).version, version);
    assert.equal(recordCPU(state.catalog.architectureCatalogs[other]), other, `${launcher}: the earlier CPU stays in the other-CPU list`);
    // Unknown CPU labels do not create a launcher-version ceiling; installation inspects the actual image.
    packages = [record(other), record(launcher), {...record(launcher), version: "2.0.0-MCLv1", arch: "riscv64", launcherArchitectures: ["riscv64"]}];
    await manager.refreshCatalog({userDataDir, force: true});
    state = manager.getState({userDataDir});
    assert.deepEqual(state.catalog.versions.filter(item => !state.catalog.versionRequirements[item]?.installReason), ['2.0.0-MCLv1',version]);
  }
});
test("one build resolver serves Play, Install, Set default and the automatic list", async () => {
  const {createArchitectureManager} = require("../src/modules/shared/runtime/architecture-manager");
  const appleSilicon = {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true};
  const intelMac = {platform: "darwin", hardwareArch: "x64", rosettaAvailable: false};
  // The resolver itself: an explicit request stays; a saved or automatic
  // choice without a build gives way to a CPU this Mac runs that has one.
  const only = cpus => architecture => cpus.includes(architecture);
  assert.equal(Architecture.chooseArchitecture({launcher: "x64", offers: only(["arm64"]), host: appleSilicon}), "arm64");
  assert.equal(Architecture.chooseArchitecture({launcher: "x64", offers: only(["arm64", "x64"]), host: appleSilicon}), "x64");
  assert.equal(Architecture.chooseArchitecture({launcher: "x64", offers: only(["arm64"]), host: intelMac}), "x64");
  assert.equal(Architecture.chooseArchitecture({launcher: "arm64", saved: "x64", offers: only(["arm64"]), host: appleSilicon}), "arm64");
  assert.equal(Architecture.chooseArchitecture({launcher: "arm64", saved: "x64", offers: only(["arm64", "x64"]), host: appleSilicon}), "x64");
  assert.equal(Architecture.chooseArchitecture({launcher: "arm64", saved: "x64", installed: only(["arm64"]), offers: only(["arm64"]), host: appleSilicon}), "arm64");
  assert.equal(Architecture.chooseArchitecture({launcher: "x64", saved: "arm64", installed: only(["x64"]), offers: only(["arm64", "x64"]), host: intelMac}), "x64");
  assert.equal(Architecture.chooseArchitecture({request: {architecture: "x64"}, launcher: "arm64", offers: only(["arm64"]), host: appleSilicon}), "x64");
  assert.equal(Architecture.chooseArchitecture({launcher: "x64", offers: only([]), host: appleSilicon}), "x64");
  // A manager whose Intel list is empty, in the Intel app on Apple Silicon.
  const calls = [];
  const manager = Architecture.withArchitecture("x64", () => createArchitectureManager({id: "fallback", dependencies: {hostCapabilities: appleSilicon}},
    ({installationArchitecture: cpu}) => ({
      core: {},
      offersBuild: () => cpu === "arm64",
      getState: () => ({catalog: {versions: cpu === "arm64" ? ["1.0"] : []}, installed: [], defaultVersion: cpu === "arm64" ? "1.0" : null}),
      resolveSelection: () => ({version: cpu === "arm64" ? "1.0" : null, install: null, ready: false}),
      installRuntime: payload => { calls.push([cpu, payload.architecture]); return {version: payload.version}; },
      applySettingsUpdate: (action, payload, settings) => ({...settings, defaultVersion: payload.version}),
      normalizeSettings: settings => settings || {}
    })));
  const state = manager.getState({userDataDir: "/fixture"});
  assert.equal(state.automaticArchitecture, "arm64");
  assert.equal(state.launcherArchitecture, "x64");
  assert.deepEqual(state.catalog.versions, ["1.0"]);
  assert.equal(state.defaultVersion, "1.0");
  assert.equal(manager.resolveSelection({}, {}, "/fixture").architecture, "arm64");
  await manager.installRuntime({userDataDir: "/fixture", version: "1.0"});
  await manager.installRuntime({userDataDir: "/fixture", version: "1.0", architecture: "x64"});
  assert.deepEqual(calls, [["arm64", "arm64"], ["x64", "x64"]]);
  assert.equal(manager.applySettingsUpdate("setDefault", {version: "1.0"}, {}, {userDataDir: "/fixture"}).defaultArchitecture, undefined);
  assert.equal(manager.applySettingsUpdate("setDefault", {version: "1.0", architecture: "x64"}, {}, {userDataDir: "/fixture"}).defaultArchitecture, "x64");
});
test("an Apple Silicon installation in the shared legacy folder is automatic in the Intel app on Apple Silicon", {skip: process.platform !== "darwin"}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-architecture-legacy-cpu-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const config = {id: "legacy-cpu", label: "Legacy CPU", importLocal: true, discoverCatalog: async () => [{version: "1.0", upstreamRevision: "arm64"}],
    dependencies: {hostCapabilities: {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true}}};
  const apple = Architecture.withArchitecture("arm64", () => createPinnedNativeManager(config));
  await apple.refreshCatalog({userDataDir: directory, force: true});
  const file = path.join(directory, "arm64-tool"); fs.writeFileSync(file, executable("arm64"), {mode: 0o755});
  const imported = await apple.importRuntime({userDataDir: directory, architecture: "arm64", version: "1.0", runtimePath: file});
  fs.renameSync(imported.installDir, path.join(directory, "runtimes", "legacy-cpu", "1.0"));
  // Both CPUs read the legacy folder; only Apple Silicon can use this executable.
  const intelApp = Architecture.withArchitecture("x64", () => createPinnedNativeManager({...config, discoverCatalog: async () => []}));
  assert.equal(intelApp.offersBuild({userDataDir: directory, architecture: "x64"}), false);
  assert.equal(intelApp.offersBuild({userDataDir: directory, architecture: "arm64"}), true);
  assert.equal(intelApp.getState({userDataDir: directory}).automaticArchitecture, "arm64");
  assert.equal(intelApp.resolveSelection({}, {}, directory).architecture, "arm64");
});

test("a selected installed Intel version wins over a missing native build unless its CPU is explicit", {skip: process.platform !== "darwin"}, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-installed-version-"));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const id = "installed-choice", host = {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true};
  let downloads = 0;
  const manager = Architecture.withArchitecture("arm64", () => createPinnedNativeManager({id, label: "Installed choice", importLocal: true,
    discoverCatalog: async () => ["arm64", "x64"].map(architecture => ({version: "1.0", architecture, upstreamRevision: architecture,
      asset: {url: `https://example.test/${architecture}.zip`, filename: architecture + ".zip", sha256: (architecture === "arm64" ? "a" : "b").repeat(64)}})),
    dependencies: {hostCapabilities: host, hostArch: "arm64", downloadToFile: () => { downloads++; assert.fail("A verified installed version must not download"); }}}));
  await manager.refreshCatalog({userDataDir, force: true});
  const file = path.join(userDataDir, "intel-runtime");fs.writeFileSync(file, executable("x64"), {mode: 0o755});
  const imported = await manager.importRuntime({userDataDir, architecture: "x64", version: "1.0", runtimePath: file});
  const entry = {runtimeId: id, runtimeData: {[id]: {version: "1.0"}}};
  for (const [game, settings, options] of [[entry, {}, {}], [{}, {runtimes: {[id]: {defaultVersion: "1.0"}}}, {}], [{}, {}, {version: "1.0"}], [{}, {}, {}]]) {
    const selection = manager.resolveSelection(game, settings, userDataDir, options);
    assert.equal(selection.architecture, "x64");
    assert.equal(selection.ready, true);
    assert.equal(selection.requiresDownload, false);
    assert.equal(selection.install.installDir, imported.installDir);
  }
  const Preparation = require("../src/core/runtime-preparation"), mod = {id, runtimeManagers: [manager]};
  assert.equal(await Preparation.prepareForLaunch({entry, mod, info: {runtime: {manager: {[id]: id}}},
    context: {userDataDir, settings: {}, runtimeId: id, confirmRuntimeInstall: () => assert.fail("Installed selection needs no consent")},
    registry: {listModuleIds: () => [id], getModule: () => mod}, install: () => assert.fail("Installed selection needs no installer")}), true);
  const explicit = manager.resolveSelection(entry, {}, userDataDir, {architecture: "arm64"});
  assert.equal(explicit.architecture, "arm64");
  assert.equal(explicit.ready, false);
  assert.equal(explicit.requiresDownload, true);
  assert.equal(manager.resolveSelection({...entry, runtimeData: {[id]: {version: "1.0", architecture: "arm64"}}}, {}, userDataDir).architecture, "arm64");
  assert.equal(downloads, 0);
});

test("a saved CPU without a build gives way to the installed runnable CPU without downloading", {skip: process.platform !== "darwin"}, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-saved-cpu-fallback-"));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const id = "saved-cpu-fallback", host = {platform: "darwin", hardwareArch: "arm64", rosettaAvailable: true};
  const manager = Architecture.withArchitecture("arm64", () => createPinnedNativeManager({id, label: "Saved CPU fallback", importLocal: true,
    discoverCatalog: async () => [{version: "1.0", architecture: "arm64", upstreamRevision: "arm64",
      asset: {url: "https://example.test/arm64.zip", filename: "arm64.zip", sha256: "a".repeat(64)}}],
    dependencies: {hostCapabilities: host, hostArch: "arm64", downloadToFile: () => assert.fail("The installed ARM copy must not download")}}));
  await manager.refreshCatalog({userDataDir, force: true});
  const file = path.join(userDataDir, "arm-runtime"); fs.writeFileSync(file, executable("arm64"), {mode: 0o755});
  const imported = await manager.importRuntime({userDataDir, architecture: "arm64", version: "1.0", runtimePath: file});
  const selected = manager.resolveSelection({runtimeId: id, runtimeData: {[id]: {version: "1.0", architecture: "x64"}}}, {}, userDataDir);
  assert.equal(selected.architecture, "arm64");
  assert.equal(selected.ready, true);
  assert.equal(selected.requiresDownload, false);
  assert.equal(selected.install.installDir, imported.installDir);
});
