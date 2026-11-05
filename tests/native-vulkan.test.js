// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Vulkan = require("../src/modules/shared/vulkan");
const { hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");
const noAdapted = { installed: () => [] };
// LWJGL's release listing and the KosmicKrisp library of one release.
const LWJGL_LIST = "https://www.lwjgl.org/list?path=release/";
const kosmickrispUrl = version => `https://build.lwjgl.org/release/${version}/macosx/arm64/libvulkan_kosmickrisp.dylib`;

test("Vulkan required drivers reuse manager defaults without seeding downloads or activating scene APIs", t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-defaults-"));
  t.after(() => fs.rmSync(userDataDir, {recursive:true,force:true}));
  const Libraries = require("../src/modules/shared/vulkan/libraries");
  const manager = Libraries.createManager("moltenvk", {systemVersionSync:()=>"26.0"}), requests = Harness.network.requests.length;
  t.after(() => assert.equal(Harness.network.requests.length, requests, "selection and requirements stay offline"));
  const context = {userDataDir,settings:{},runtimeSettings:{vulkanRuntime:"auto"}};
  const dependencies = {managers:[manager],adapted:noAdapted,required:true};
  assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
  assert.deepEqual(Vulkan.requirements(context,dependencies),
    [{managerId:"vulkan-moltenvk",version:null,discoveryRequired:true,requiresDownload:true,installOptions:{}}],
    "with nothing listed, consented preparation discovers the newest release instead of a fixed version");
  context.settings = {runtimes:{[manager.id]:{defaultVersion:"1.4.3"}}};
  assert.equal(Vulkan.requirements(context,dependencies)[0].version,"1.4.3");
  context.runtimeSettings.vulkanRuntime = "moltenvk:1.4.4";
  assert.equal(Vulkan.requirements(context,dependencies)[0].version,"1.4.4");
  assert.equal(manager.resolveSelection({},context.settings,userDataDir,{recommendedVersion:"1.4.5"}).version,"1.4.5");
  assert.equal(manager.resolveSelection({runtimeData:{[manager.id]:{version:"1.4.6"}}},context.settings,userDataDir,
    {recommendedVersion:"1.4.5"}).version,"1.4.6");
  context.runtimeSettings.vulkanRuntime = "auto";
  context.settings.runtimes[manager.id].defaultVersion = null;
  assert.equal(Vulkan.requirements(context,dependencies)[0].discoveryRequired,true);
  const support = require("../src/modules/crossover/temporal/support-manager").createManager();
  assert.deepEqual(support.getState({userDataDir}).catalog.versions, []);
  assert.equal(support.resolveSelection({}, {}, userDataDir).version, null);
  assert.equal(support.resolveSelection({}, {}, userDataDir).discoveryRequired, true);
  assert.equal(support.resolveSelection({}, {runtimes:{[support.id]:{defaultVersion:null}}}, userDataDir).version,null);
});

test("native Vulkan choices use matching installed images and preserve file-only isolation", { skip: process.platform !== "darwin" }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-selection-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "empty.c"); fs.writeFileSync(source, "int native_driver_fixture(void){return 1;}\n");
  const build = (file, architecture, minimum = "13.0") => execFileSync("/usr/bin/clang", ["-dynamiclib", "-arch", architecture,
    "-mmacosx-version-min=" + minimum, "-Wl,-install_name,@rpath/" + path.basename(file), source, "-o", file]);
  const driver = path.join(root, "libvulkan_kosmickrisp.dylib"), loader = path.join(root, "libvulkan.1.dylib");
  build(driver, "arm64"); build(loader, "arm64");
  const install = { installDir: root, executablePath: driver, version: "fixture", installationMetadata: {
    libraries: [driver, loader].map(file => ({ file: path.basename(file), sha256: hashFile(file) })) } };
  const managers = [{ id: "vulkan-kosmickrisp", backend: "kosmickrisp", getState: () => ({catalog:{versions:[]}}), core: { listInstalled: () => [install] } }];
  const dependencies = { managers, architecture: "arm64", macOSVersion: "26.0", adapted: noAdapted };
  const context = { userDataDir: root, runtimeSettings: { vulkanRuntime: "kosmickrisp:fixture" } };
  const selected = Vulkan.resolve(context, dependencies);
  assert.equal(selected.library, loader); assert.deepEqual(selected.readable, [driver, loader]);
  let fullChecks = 0;
  const adaptedRecord = { id: "maclauncher-kosmickrisp:fixture", backend: "kosmickrisp", projectId: "maclauncher-kosmickrisp",
    label: "MacLauncher KosmicKrisp", library: loader, driver, readable: [driver, loader] };
  const withAdapted = { ...dependencies, adapted: { installed: () => [adaptedRecord], resolve: item => { fullChecks++; return item; } } };
  assert.deepEqual(Vulkan.choices(context, withAdapted).vulkanRuntimes.map(item => item.value), ["auto", "kosmickrisp:fixture", adaptedRecord.id]);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: {} }, withAdapted).id, "kosmickrisp:fixture");
  assert.equal(fullChecks, 0);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: { vulkanRuntime: adaptedRecord.id } }, withAdapted), adaptedRecord);
  assert.equal(fullChecks, 1);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: { vulkanRuntime: "kosmickrisp:maclauncher" } }, withAdapted), adaptedRecord);
  assert.equal(fullChecks, 2);
  const env = Vulkan.environment(selected, root);
  assert.equal(env.KL_MVK_DYLIB, loader);
  assert.equal(JSON.parse(fs.readFileSync(env.VK_DRIVER_FILES)).ICD.library_path, driver);
  assert.equal(env.VK_ICD_FILENAMES, env.VK_DRIVER_FILES);
  // A loader with a different CPU architecture cannot accompany an arm64 driver.
  build(loader, "x86_64");
  const unavailable = Vulkan.choices(context, dependencies).vulkanRuntimes;
  assert.deepEqual(unavailable.map(item => item.value), ["auto", "kosmickrisp:fixture"]);
  assert.match(unavailable[1].label, /\(not installed\)$/);
  assert.throws(() => Vulkan.resolve(context, dependencies), /unavailable for this Mac/);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: {} }, dependencies), null);
  build(loader, "arm64");
  install.installationMetadata.libraries[1].sha256 = "0".repeat(64);
  assert.equal(Vulkan.installed(context, dependencies).length, 0);
});

test("Vulkan managers and installed-choice queries never fetch during ordinary reads", () => {
  const registry = require("../src/modules/registry");
  const managers = registry.listSharedRuntimeManagers();
  for (const id of ["vulkan-moltenvk", "vulkan-kosmickrisp"]) assert.ok(managers.some(manager => manager.id === id));
  assert.deepEqual(Vulkan.choices({ userDataDir: path.join(os.tmpdir(), "no-vulkan-runtime-" + process.pid) }, { adapted: noAdapted }).vulkanRuntimes.map(row => row.value),
    ["auto"]);
});

test("managed MacLauncher KosmicKrisp starts with empty download choices and no app fallback", t => {
  const Managed = require("../src/modules/shared/vulkan/managed");
  let queries = 0;
  const manager = Managed.createManager({ fetchUrlBuffer: () => { queries++; assert.fail("status must stay offline"); } });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-managed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { userDataDir: root, settings: {} }, state = manager.getState(context);
  assert.equal(manager.ui.management, "managed");
  assert.equal(manager.distributionRequired, false);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.deepEqual(state.catalog.versions, []);
  assert.deepEqual(state.catalog.installableVersions, []);
  assert.equal(Managed.createProvider(manager).installed(context).length, 0);
  assert.equal(queries, 0);
  assert.equal(fs.existsSync(path.join(root, "runtimes")), false);
});

test("managed MacLauncher KosmicKrisp selections retain the complete closure and full launch verification", () => {
  const Managed = require("../src/modules/shared/vulkan/managed"), calls = [];
  const payloadRoot = path.join(os.tmpdir(), "managed-vulkan-payload");
  const manifest = { minimumMacOS: "27.0", runtimeFiles: { loader: "libvulkan.1.dylib" }, files: [
    {path: "libvulkan_kosmickrisp.dylib", architectures: ["arm64"]},
    {path: "libvulkan.1.dylib", architectures: ["arm64"]},
    {path: "libCompiler.dylib", architectures: ["arm64"]}, {path: "LICENSE"}] };
  let ready = true;
  const provider = Managed.createProvider({
    label: "MacLauncher KosmicKrisp",
    getState: () => ({installed: [{version:"selected"}]}),
    resolveSelection: (_entry, _settings, _data, options) => {
      calls.push(options);
      return {version:options.version, ready, install: ready ? {payloadRoot,manifest,executablePath:path.join(payloadRoot,manifest.files[0].path)} : null};
    }
  });
  const context = {userDataDir: os.tmpdir(), settings:{}};
  const installed = provider.installed(context)[0];
  assert.equal(installed.id, "maclauncher-kosmickrisp:selected");
  assert.equal(installed.label, "MacLauncher KosmicKrisp selected");
  assert.equal(Managed.createManager().ui.sectionLabel, "MacLauncher KosmicKrisp");
  assert.equal(installed.readable.length, 3);
  assert.equal(installed.library, path.join(payloadRoot, "libvulkan.1.dylib"));
  assert.equal(installed.minimumMacOS, "27.0");
  assert.equal(provider.resolve(installed, context).driver, path.join(payloadRoot, "libvulkan_kosmickrisp.dylib"));
  assert.deepEqual(calls, [{version:"selected",verification:"status"},{version:"selected",verification:"full"}]);
  ready = false;
  assert.throws(() => provider.resolve(installed, context), /Install this version in Runtimes/);
});

test("saved MacLauncher KosmicKrisp choices request exact consented installation and reuse installed packages", () => {
  const uses = [], versions = [], context = {userDataDir: os.tmpdir(), settings:{}, runtimeSettings:{vulkanRuntime:"kosmickrisp:maclauncher"}, recordRuntimeUse: row => uses.push(row)};
  let ready = false;
  const manager = {id:"maclauncher-kosmickrisp",resolveSelection: (_entry,_settings,_data,options) => {
    versions.push(options.version); return {version:options.version || "recommended",ready,install:ready ? {installDir:"/installed/native"} : null};
  }};
  const dependencies = {adaptedManager:manager};
  assert.deepEqual(Vulkan.requirements(context, dependencies), [{managerId:manager.id,version:"recommended",requiresDownload:true,installOptions:{}}]);
  context.runtimeSettings.vulkanRuntime = "maclauncher-kosmickrisp:older";
  assert.equal(Vulkan.requirements(context, dependencies)[0].version, "older");
  ready = true;
  assert.deepEqual(Vulkan.requirements(context, dependencies), []);
  assert.deepEqual(uses, [{managerId:manager.id,version:"older",sectionId:"default",sourcePath:"/installed/native"}]);
  for (const request of ["auto"]) {
    context.runtimeSettings.vulkanRuntime = request;
    assert.deepEqual(Vulkan.requirements(context, dependencies), []);
  }
  for (const [request, managerId, version] of [["moltenvk:1.0", "vulkan-moltenvk", "1.0"], ["kosmickrisp:stock", "vulkan-kosmickrisp", "stock"]]) {
    context.runtimeSettings.vulkanRuntime = request;
    assert.deepEqual(Vulkan.requirements(context, dependencies), [{managerId, version, requiresDownload:true, installOptions:{}}]);
  }
  assert.deepEqual(versions,[undefined,"older","older"]);
});

test("KosmicKrisp per-game former manager version and CPU remain readable without changing the record", t => {
  const Managed = require("../src/modules/shared/vulkan/managed");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kosmickrisp-game-choice-"));
  t.after(() => fs.rmSync(userDataDir, {recursive: true, force: true}));
  const manager = Managed.createManager({systemVersionSync: () => "27.0", hostCapabilities: {platform: "darwin", hardwareArch: "arm64", macOSVersion: "27.0"},
    fetchUrlBuffer: () => assert.fail("per-game version and CPU reads remain offline")});
  const entry = {runtimeData: {[Managed.formerProjectId]: {version: "27.0.0-devel-MCLv8", architecture: "x64", note: "retained"}}};
  const before = JSON.stringify(entry);
  assert.equal(manager.chooseArchitecture(entry, {}, userDataDir), "x64");
  const selection = manager.resolveSelection(entry, {}, userDataDir, {verification: "status"});
  assert.equal(selection.version, "27.0.0-devel-MCLv8"); assert.equal(selection.architecture, "x64");
  assert.equal(manager.chooseArchitecture(entry, {}, userDataDir, {architecture: "arm64"}), "arm64");
  const current = {runtimeData: {...entry.runtimeData, [manager.id]: {version: "27.0.0-devel-MCLv12", architecture: "arm64"}}};
  const preferred = manager.resolveSelection(current, {}, userDataDir, {verification: "status"});
  assert.equal(preferred.version, "27.0.0-devel-MCLv12"); assert.equal(preferred.architecture, "arm64");
  assert.equal(JSON.stringify(entry), before);
});

test("MacLauncher KosmicKrisp retains earlier selections, installations and catalog downloads", {skip: process.platform !== "darwin" || process.arch !== "arm64"}, async t => {
  const Managed = require("../src/modules/shared/vulkan/managed"), Bundled = require("../src/modules/shared/runtime/bundled-native");
  const { createProjectBuildManager } = require("../src/modules/shared/runtime/project-build-manager");
  const { nativeTool, packageFor } = require("./helpers/managed-tool-fixture.cjs");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kosmickrisp-rename-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const legacyId = "vulkan-kosmickrisp-gles32", older = "27.0.0-devel-MCLv8", newer = "27.0.0-devel-MCLv9";
  const binary = nativeTool(path.join(root, "native"), "", {architecture: "arm64"}).binary;
  const fixtures = [older, newer, "27.0.0-devel-MCLv12"].map((version, index) => packageFor(path.join(root, version), {
    id: index < 2 ? legacyId : Managed.projectId, version, architecture: "arm64", filesPrefix: "files/",
    manifest: {managerId: index < 2 ? legacyId : Managed.projectId, platform: "darwin", executableRelative: "libvulkan_kosmickrisp.dylib",
      runtimeFiles: {loader: "libvulkan.1.dylib"}, upstreamRevision: "a".repeat(40), dependencies: [],
      notices: [{name: "Fixture", license: "MIT", sourceUrl: "https://example.com/source", path: "LICENSE"}]},
    entries: ["libvulkan_kosmickrisp.dylib", "libvulkan.1.dylib"].map(name => ({path: name, bytes: binary, mode: 0o755, architectures: ["arm64"]}))
      .concat([{path: "LICENSE", bytes: Buffer.from("fixture license\n"), mode: 0o644}])
  }));
  const catalog = id => ({schemaVersion: 2, projectId: id, updatePolicy: "manual", packages: fixtures.filter(item => item.record.id === id).map(item => item.record)});
  let offline = false;
  const requests = [];
  const dependencies = {systemVersionSync: () => "27.0", fetchUrlBuffer: async url => {
    assert.equal(offline, false, "status and selection never fetch"); requests.push(url);
    const id = url.endsWith("/" + legacyId + ".json") ? legacyId : Managed.projectId;
    return {status: 200, body: Buffer.from(JSON.stringify(catalog(id)))};
  }, downloadToFile: async (url, destination) => {
    assert.equal(offline, false); requests.push(url);
    const fixture = fixtures.find(item => item.record.asset.url === url);
    assert.ok(fixture, "downloads keep the published asset identity");
    fs.copyFileSync(fixture.archive, destination);
  }};
  const legacy = createProjectBuildManager({projectId: legacyId, label: "KosmicKrisp GLES 3.2", repository: "procrastinine/maclauncher-builds",
    manifestRelative: "manifest.json", sourceRelative: null, filesPrefix: "files/", nativeLibrary: true,
    executableRelative: manifest => manifest.executableRelative,
    verifyPayload: selected => Bundled.verifyPayload(selected.root, selected.declaration), dependencies});
  const userDataDir = path.join(root, "existing-profile");
  await legacy.refreshCatalog({userDataDir, force: true});
  const installed = [];
  for (const version of [older, newer]) installed.push(await legacy.installRuntime({userDataDir, version, architecture: "arm64"}));
  const manager = Managed.createManager(dependencies), provider = Managed.createProvider(manager);
  const settings = {runtimes: {[legacyId]: {defaultVersion: older, defaultArchitecture: "arm64"}}};
  const context = {userDataDir, settings, runtimeSettings: {vulkanRuntime: "kosmickrisp:maclauncher-gles32"}};
  const options = {managers: [], adaptedManager: manager, adapted: provider, architecture: "arm64",
    hostCapabilities: {platform: "darwin", hardwareArch: "arm64", macOSVersion: "27.0"}};
  offline = true;
  await t.test("saved manager defaults and both old Vulkan choices retain the same installed version", () => {
    const before = JSON.stringify(settings), count = requests.length;
    assert.equal(manager.resolveSelection(null, settings, userDataDir).version, older);
    assert.equal(manager.resolveSelection(null, settings, userDataDir).ready, true);
    assert.equal(manager.getState({userDataDir, runtimeSettings: settings.runtimes}).defaultVersion, older);
    const game = {runtimeData: {[legacyId]: {version: older, architecture: "arm64"}}}, gameBefore = JSON.stringify(game);
    const gameSelection = manager.resolveSelection(game, {}, userDataDir, {verification: "status"});
    assert.equal(gameSelection.version, older); assert.equal(gameSelection.architecture, "arm64"); assert.equal(gameSelection.ready, true);
    assert.equal(gameSelection.install.installDir, installed[0].installDir); assert.equal(JSON.stringify(game), gameBefore);
    for (const request of ["kosmickrisp:maclauncher-gles32", "kosmickrisp-gles32:" + older]) {
      context.runtimeSettings.vulkanRuntime = request;
      assert.equal(Vulkan.resolve(context, options).version, older);
      assert.deepEqual(Vulkan.requirements(context, options), []);
      const choices = Vulkan.choices(context, options).vulkanRuntimes;
      assert.ok(choices.some(row => row.value === request && !row.label.includes("not installed")), "the saved alias remains selected");
    }
    const explicit = {runtimes: {...settings.runtimes, [manager.id]: {defaultVersion: newer}}};
    assert.equal(manager.resolveSelection(null, explicit, userDataDir).version, newer);
    assert.equal(manager.getState({userDataDir, settings: explicit.runtimes[manager.id], runtimeSettings: explicit.runtimes}).defaultVersion, newer);
    const cleared = {runtimes: {...settings.runtimes, [manager.id]: {defaultVersion: null}}};
    assert.equal(manager.resolveSelection(null, cleared, userDataDir).version, newer, "an explicit new default reset supersedes the former saved default");
    assert.equal(JSON.stringify(settings), before, "reading old settings never rewrites them");
    assert.equal(requests.length, count);
  });
  await t.test("old runtime directories and receipts remain recognized in place without mutation", () => {
    const formerRoot = path.join(userDataDir, "runtimes", legacyId);
    const snapshot = directory => fs.readdirSync(directory, {recursive: true, withFileTypes: true}).map(entry => {
      const file = path.join(entry.parentPath || entry.path, entry.name), stat = fs.statSync(file);
      return [path.relative(directory, file), stat.ino, stat.size, stat.mtimeMs, stat.isFile() ? hashFile(file) : null];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    const before = snapshot(formerRoot), count = requests.length;
    assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", manager.id)), false);
    const state = manager.getState({userDataDir, runtimeSettings: settings.runtimes});
    assert.deepEqual(new Set(state.installed.filter(row => row.ready).map(row => row.installDir)), new Set(installed.map(row => row.installDir)));
    for (const item of installed) {
      const selected = manager.resolveSelection(null, settings, userDataDir, {version: item.version, verification: "full"});
      assert.equal(selected.ready, true);
      assert.equal(selected.install.installDir, item.installDir);
      const row = provider.installed(context).find(row => row.version === item.version);
      assert.equal(row.id, "maclauncher-kosmickrisp:" + item.version);
      assert.ok(provider.resolve(row, context).driver.startsWith(item.installDir + path.sep));
    }
    assert.deepEqual(snapshot(formerRoot), before, "old runtime bytes, paths and filesystem identities stay intact");
    assert.equal(fs.existsSync(path.join(userDataDir, "runtimes", manager.id)), false);
    assert.equal(requests.length, count);
  });
  await t.test("unreadable former settings and unavailable former choices warn and use normal fallback", () => {
    const warnings = [], logger = {warn: (...args) => warnings.push(args.join(" "))};
    const badSettings = {runtimes: {[legacyId]: {defaultVersion: {version: older}}}};
    const tolerant = Managed.createManager({...dependencies, logger});
    assert.equal(tolerant.resolveSelection(null, badSettings, userDataDir).version, newer);
    assert.ok(warnings.length > 0);
    const previous = JSON.stringify(context), count = requests.length;
    for (const request of ["kosmickrisp-gles32:unknown-version", "kosmickrisp-gles32:../invalid"]) {
      const oldContext = {...context, logger, runtimeSettings: {vulkanRuntime: request}};
      const number = warnings.length;
      assert.equal(Vulkan.resolve(oldContext, options).version, older);
      assert.deepEqual(Vulkan.requirements(oldContext, options), []);
      assert.ok(warnings.length > number);
    }
    assert.equal(JSON.stringify(context), previous);
    assert.equal(requests.length, count);
  });
  await t.test("Runtimes discovers both catalogs and installs the old MCLv8 arm64 publication", async () => {
    offline = false;
    const freshData = path.join(root, "fresh-profile"), fresh = Managed.createManager(dependencies);
    assert.deepEqual(fresh.getState({userDataDir: freshData}).catalog.versions, []);
    const count = requests.length;
    await fresh.refreshCatalog({userDataDir: freshData, force: true});
    for (const id of [Managed.projectId, legacyId]) assert.ok(requests.slice(count).some(url => url.endsWith("/catalogs/" + id + ".json")));
    const state = fresh.getState({userDataDir: freshData});
    assert.ok(state.catalog.installableVersions.includes(older));
    assert.ok(state.catalog.installableVersions.includes(fixtures[2].record.version));
    const selected = await fresh.installRuntime({userDataDir: freshData, version: older, architecture: "arm64"});
    assert.equal(selected.version, older);
    offline = true;
    const reloaded = Managed.createManager(dependencies);
    assert.equal(reloaded.resolveSelection(null, {}, freshData, {version: older}).ready, true);
    assert.ok(reloaded.getState({userDataDir: freshData}).catalog.installableVersions.includes(older));
  });
});

test("managed Vulkan profiles accept published revisions and retain source and payload integrity", {skip: process.platform !== "darwin"}, t => {
  const Managed = require("../src/modules/shared/vulkan/managed"), Bundled = require("../src/modules/shared/runtime/bundled-native");
  const architectures = require("../src/modules/shared/runtime/local-native").readMachOArchitectures("/usr/bin/true", {allowLibrary: true});
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-published-profiles-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [manager, library, prefix] of [[Managed.createManager(), "libvulkan_kosmickrisp.dylib", "files/"],
    [Managed.createSceneManager(), "libMoltenVK-scene.dylib", ""]]) {
    for (const version of ["2030.1", "2030.2"]) {
      const directory = path.join(root, manager.id + version), revision = (version.endsWith("1") ? "1" : "2").repeat(40);
      fs.mkdirSync(path.join(directory, prefix), {recursive: true});
      const names = [library, ...(prefix ? ["libvulkan.1.dylib"] : []), "LICENSE"];
      const files = names.map(name => {
        const file = path.join(directory, prefix, name), native = name !== "LICENSE";
        fs.writeFileSync(file, native ? fs.readFileSync("/usr/bin/true") : "fixture license", {mode: native ? 0o755 : 0o644});
        fs.chmodSync(file, native ? 0o755 : 0o644);
        return {path: name, size: fs.statSync(file).size, mode: native ? 0o755 : 0o644, sha256: hashFile(file),
          ...(native ? {architectures} : {})};
      });
      const manifest = {schemaVersion: 1, managerId: manager.id, version, arch: process.arch, platform: "darwin",
        minimumMacOS: "13.0", upstreamRevision: revision, executableRelative: library, files,
        provenance: {sourceRevision: revision, verifiedBuild: true, capabilities: {openglES: "3.2"}},
        notices: [{name: "Fixture", license: "MIT", sourceUrl: "https://example.com/source", path: "LICENSE"}], dependencies: [],
        ...(prefix ? {runtimeFiles: {loader: "libvulkan.1.dylib"}} : {provider: {schema: 1, provider: "moltenvk",
          sceneOperationAPI: 1, sceneStagingAPI: 1, sceneOperationResources: "prepared-tracked-boundary", originalOutputRetained: true,
          library, minimumMacOS: "13.0", architectures: files[0].architectures, files: [files[0]]}})};
      const file = path.join(directory, "manifest.json");
      const seal = () => {fs.writeFileSync(file, JSON.stringify(manifest));fs.chmodSync(file, 0o644);return {id: manager.id, version, arch: process.arch,
        minimumMacOS: "13.0", manifestRelative: "manifest.json", manifestSha256: hashFile(file), sourceSha256: "e".repeat(64),
        source: {repository: "ExampleOwner/upstream", revision}};};
      let record = seal();
      const selected = manager.inspectPackage(directory, record);
      assert.equal(selected.manifest.upstreamRevision, revision);
      assert.equal(selected.executablePath, path.join(directory, prefix, library));
      Bundled.verifyPayload(directory, selected.declaration);
      assert.equal(manager.inspectPackage(directory, {...record, source: {revision: "f".repeat(40)}}).sourceIdentity.revision, "f".repeat(40));
      const producerSource = {repository: "procrastinine/maclauncher-builds", revision: "f".repeat(40)};
      const produced = manager.inspectPackage(directory, {...record, source: producerSource});
      assert.equal(produced.manifest.upstreamRevision, revision);
      assert.equal(produced.declaration.source.revision, producerSource.revision);
      manifest.provenance.sourceRevision = "a".repeat(40);
      assert.equal(manager.inspectPackage(directory, {...seal(), source: producerSource}).sourceIdentity.provenanceRevision, "a".repeat(40));
      assert.throws(() => Bundled.validateManifest(manifest), /Invalid bundled runtime manifest/);
      manifest.provenance.sourceRevision = revision;
      record = seal();
      fs.appendFileSync(file, " ");
      assert.throws(() => manager.inspectPackage(directory, record), /manifest changed/);
      record = seal();
      if (prefix) {
        manifest.provenance.verifiedBuild = false;
        manifest.provenance.capabilities.openglES = "3.1";
        assert.equal(manager.inspectPackage(directory, seal()).manifest.provenance.verifiedBuild, false);
      } else {
        manifest.provider.sceneOperationAPI = 0;
        assert.throws(() => manager.inspectPackage(directory, seal()), /profile/);
        manifest.provider.sceneOperationAPI = 1;
      }
      record = seal();
      const intact = manager.inspectPackage(directory, record);
      const binaryPath = path.join(directory, prefix, library), tampered = fs.readFileSync(binaryPath);
      tampered[tampered.length - 1] ^= 1;
      fs.writeFileSync(binaryPath, tampered);
      assert.throws(() => Bundled.verifyPayload(directory, intact.declaration), /checksum.*changed/i);
    }
  }
});

test("Vulkan supplier catalogs list every published version without seeds or fixed restrictions and read their cache offline", async t => {
  const Libraries = require("../src/modules/shared/vulkan/libraries");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-platform-catalog-"));
  t.after(() => { Harness.network.routes = null; fs.rmSync(root, {recursive: true, force: true}); });
  const versions = ["1.4.2", "2030.1", "2030.2"];
  const routes = {
    moltenvk: Harness.githubRoutes("KhronosGroup/MoltenVK", versions.map(value => Harness.githubRelease("KhronosGroup/MoltenVK", "v" + value, ["MoltenVK-macos.tar"]))),
    kosmickrisp: {[LWJGL_LIST]: {folders: versions.map(value => value + "/")}, ...Object.fromEntries(versions.flatMap(value => [
      [kosmickrispUrl(value), {status: 200, headers: {"content-length": "1234"}, body: Buffer.alloc(0)}], [kosmickrispUrl(value) + ".git", "a".repeat(40)]]))}
  };
  for (const backend of ["moltenvk", "kosmickrisp"]) {
    const userDataDir = path.join(root, backend), manager = Libraries.createManager(backend, {systemVersionSync: () => "27.0"});
    let requests = Harness.network.requests.length;
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
    Harness.network.routes = routes[backend];
    await manager.refreshCatalog({userDataDir, force: true});
    Harness.network.routes = null;
    const state = manager.getState({userDataDir});
    assert.deepEqual(new Set(state.catalog.versions), new Set(versions));
    assert.deepEqual(state.catalog.installableVersions.sort(), [...versions].sort(), "no listed version carries a fixed macOS restriction");
    assert.ok(manager.core.catalog.every(pin => pin.minimumMacOS === undefined), "the macOS floor is read from the installed library");
    requests = Harness.network.requests.length;
    const offline = Libraries.createManager(backend, {systemVersionSync: () => "27.0"});
    assert.deepEqual(new Set(offline.getState({userDataDir}).catalog.versions), new Set(versions));
    assert.equal(Harness.network.requests.length, requests, "cached state stays offline");
  }
});

test("stock KosmicKrisp discovers upstream metadata, installs verified closures and reuses exact choices offline",
  {skip: process.platform !== "darwin" || process.arch !== "arm64"}, async t => {
    const Libraries = require("../src/modules/shared/vulkan/libraries");
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-release-catalog-"));
    t.after(() => { Harness.network.routes = null; fs.rmSync(root, {recursive: true, force: true}); });
    const source = path.join(root, "fixture.c"), driver = path.join(root, "driver.dylib");
    fs.writeFileSync(source, "int driver_fixture(void){return 1;}\n");
    execFileSync("/usr/bin/clang", ["-dynamiclib", "-arch", "arm64", "-mmacosx-version-min=13.0",
      "-Wl,-install_name,@rpath/libvulkan_kosmickrisp.dylib", source, "-o", driver]);
    const bottleRoot = path.join(root, "bottle"), prefix = path.join(bottleRoot, "vulkan-loader/888.777.6");
    fs.mkdirSync(path.join(prefix, "lib"), {recursive: true});
    fs.copyFileSync(driver, path.join(prefix, "lib/libvulkan.1.99.888.dylib"));
    fs.writeFileSync(path.join(prefix, "LICENSE.txt"), "fixture loader license");
    const bottle = path.join(root, "loader.tar.gz");
    execFileSync("/usr/bin/tar", ["-czf", bottle, "-C", bottleRoot, "vulkan-loader"]);
    const driverSha = hashFile(driver), bottleSha = hashFile(bottle), versions = ["2030.2", "2030.1"];
    const bottleUrl = "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + bottleSha;
    let listings = 0, downloads = 0, metadataFailure = false, tamperedBottle = false;
    const routes = {
      [LWJGL_LIST]: () => { listings++; return metadataFailure ? {status: 403, headers: {}, body: Buffer.alloc(0)} : {folders: versions.map(version => version + "/")}; },
      "https://formulae.brew.sh/api/formula/vulkan-loader.json": {name: "vulkan-loader", versions: {stable: "888.777.6"}, bottle: {stable: {files: {
        arm64_golden_gate: {sha256: "f".repeat(64), url: "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + "f".repeat(64)},
        arm64_tahoe: {sha256: bottleSha, url: bottleUrl}}}}},
      "https://ghcr.io/token": {token: "fixture-token"},
      [bottleUrl]: () => { downloads++; return tamperedBottle ? Buffer.concat([fs.readFileSync(bottle), Buffer.from("tampered")]) : fs.readFileSync(bottle); }
    };
    // The build host states each library's size; it states an S3 SHA-256 for one release.
    for (const [index, version] of versions.entries()) {
      routes[kosmickrispUrl(version)] = (url, {method} = {}) => {
        if (method !== "HEAD") downloads++;
        return {status: 200, body: fs.readFileSync(driver), headers: {"content-length": String(fs.statSync(driver).size),
          ...(index === 1 ? {"x-amz-checksum-sha256": Buffer.from(driverSha, "hex").toString("base64")} : {})}};
      };
      routes[kosmickrispUrl(version) + ".git"] = String(index + 1).repeat(40) + "\n";
    }
    Harness.network.routes = routes;
    const userDataDir = path.join(root, "data"), manager = Libraries.createManager("kosmickrisp", {systemVersionSync: () => "26.0"});
    let requests = Harness.network.requests.length;
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
    assert.equal(Harness.network.requests.length, requests);
    await manager.refreshCatalog({userDataDir, force: true});
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, versions);
    assert.equal(listings, 1);
    assert.equal(downloads, 0, "Refresh reads metadata only");
    assert.ok(!Harness.network.requests.slice(requests).some(url => /formulae\.brew\.sh|ghcr\.io/.test(url)), "the loader is chosen when the library is installed");
    const pin = manager.core.catalog.find(pin => pin.version === versions[0]);
    assert.equal(pin.asset.integrity, "recorded-local");
    assert.equal(pin.asset.bytes, fs.statSync(driver).size);
    assert.equal(pin.upstreamRevision, "1".repeat(40));
    assert.equal(manager.core.catalog.find(pin => pin.version === versions[1]).asset.sha256, driverSha);
    const installed = await manager.installRuntime({userDataDir, version: versions[0]});
    assert.equal(installed.archiveSha256, driverSha);
    assert.equal(installed.integritySource, "recorded-local");
    assert.deepEqual(installed.installationMetadata.libraries.map(row => row.file), ["libvulkan_kosmickrisp.dylib", "libvulkan.1.dylib"]);
    assert.match(installed.installationMetadata.minimumMacOS, /^13\./);
    const licenseDirectory = path.join(installed.installDir, "licenses"), sourceLicenses = path.resolve(__dirname, "../src/modules/shared/vulkan/notices");
    assert.equal(fs.readFileSync(path.join(licenseDirectory, "Vulkan-Loader.txt"), "utf8"), "fixture loader license");
    for (const name of fs.readdirSync(sourceLicenses))
      assert.deepEqual(fs.readFileSync(path.join(licenseDirectory, name)), fs.readFileSync(path.join(sourceLicenses, name)), "Bundled texts merge without discarding the loader's licence");
    tamperedBottle = true;
    await assert.rejects(manager.installRuntime({userDataDir, version: versions[1]}), /vulkan-loader\.tar\.gz does not match the checksum its publisher lists/);
    tamperedBottle = false;
    await manager.installRuntime({userDataDir, version: versions[1]});
    metadataFailure = true;
    await assert.rejects(manager.refreshCatalog({userDataDir, force: true}), /403/);
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, versions, "failed refresh retains the catalog");
    Harness.network.routes = null;
    requests = Harness.network.requests.length;
    const offline = Libraries.createManager("kosmickrisp", {systemVersionSync: () => "26.0"});
    const settings = {runtimes: {[offline.id]: {defaultVersion: versions[0]}}};
    assert.equal(offline.resolveSelection(null, settings, userDataDir).version, versions[0]);
    assert.equal(offline.resolveSelection(null, settings, userDataDir).ready, true);
    const context = {userDataDir}, options = {managers: [offline], adapted: noAdapted, architecture: "arm64", macOSVersion: "26.0"};
    assert.equal(Vulkan.installed(context, options).length, 2);
    assert.equal(Harness.network.requests.length, requests, "installed and cached choices stay offline");
    fs.appendFileSync(path.join(installed.installDir, "libvulkan.1.dylib"), "tampered");
    assert.equal(Vulkan.installed(context, options).length, 1, "a changed loader cannot enter a graphics path");
  });
