const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Vulkan = require("../src/modules/shared/vulkan");
const { hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");
const noAdapted = { installed: () => [] };

test("Vulkan required drivers reuse manager defaults without seeding downloads or activating scene APIs", t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-defaults-"));
  t.after(() => fs.rmSync(userDataDir, {recursive:true,force:true}));
  const Libraries = require("../src/modules/shared/vulkan/libraries");
  const manager = Libraries.createManager("moltenvk", {systemVersionSync:()=>"26.0",
    fetchGithubReleases:()=>assert.fail("selection and requirements must stay offline")});
  const context = {userDataDir,settings:{},runtimeSettings:{vulkanRuntime:"auto"}};
  const dependencies = {managers:[manager],adapted:noAdapted,required:true};
  assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
  assert.deepEqual(Vulkan.requirements(context,dependencies),
    [{managerId:"vulkan-moltenvk",version:"1.4.2",requiresDownload:true,installOptions:{}}]);
  context.settings = {runtimes:{[manager.id]:{defaultVersion:"1.4.3"}}};
  assert.equal(Vulkan.requirements(context,dependencies)[0].version,"1.4.3");
  context.runtimeSettings.vulkanRuntime = "moltenvk:1.4.4";
  assert.equal(Vulkan.requirements(context,dependencies)[0].version,"1.4.4");
  assert.equal(manager.resolveSelection({},context.settings,userDataDir,{recommendedVersion:"1.4.5"}).version,"1.4.5");
  assert.equal(manager.resolveSelection({runtimeData:{[manager.id]:{version:"1.4.6"}}},context.settings,userDataDir,
    {recommendedVersion:"1.4.5"}).version,"1.4.6");
  context.runtimeSettings.vulkanRuntime = "auto";
  context.settings.runtimes[manager.id].defaultVersion = null;
  assert.throws(()=>Vulkan.requirements(context,dependencies),/compatible.*Vulkan runtime is unavailable/);
  const support = require("../src/modules/crossover/temporal/support-manager").createManager();
  assert.deepEqual(support.getState({userDataDir}).catalog.versions, []);
  assert.equal(support.resolveSelection({}, {}, userDataDir).version, "1.0.21");
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
  const managers = [{ backend: "kosmickrisp", core: { listInstalled: () => [install] } }];
  const dependencies = { managers, architecture: "arm64", macOSVersion: "26.0", adapted: noAdapted };
  const context = { userDataDir: root, runtimeSettings: { vulkanRuntime: "kosmickrisp:fixture" } };
  const selected = Vulkan.resolve(context, dependencies);
  assert.equal(selected.library, loader); assert.deepEqual(selected.readable, [driver, loader]);
  let fullChecks = 0;
  const adaptedRecord = { id: "kosmickrisp-gles32:fixture", backend: "kosmickrisp", projectId: "vulkan-kosmickrisp-gles32",
    label: "KosmicKrisp · GLES 3.2", library: loader, driver, readable: [driver, loader] };
  const withAdapted = { ...dependencies, adapted: { installed: () => [adaptedRecord], resolve: item => { fullChecks++; return item; } } };
  assert.deepEqual(Vulkan.choices(context, withAdapted).vulkanRuntimes.map(item => item.value), ["auto", "kosmickrisp:fixture", adaptedRecord.id]);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: {} }, withAdapted).id, "kosmickrisp:fixture");
  assert.equal(fullChecks, 0);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: { vulkanRuntime: adaptedRecord.id } }, withAdapted), adaptedRecord);
  assert.equal(fullChecks, 1);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: { vulkanRuntime: "kosmickrisp:maclauncher-gles32" } }, withAdapted), adaptedRecord);
  assert.equal(fullChecks, 2);
  const env = Vulkan.environment(selected, root);
  assert.equal(env.KL_MVK_DYLIB, loader);
  assert.equal(JSON.parse(fs.readFileSync(env.VK_DRIVER_FILES)).ICD.library_path, driver);
  assert.equal(env.VK_ICD_FILENAMES, env.VK_DRIVER_FILES);
  // A loader with a different CPU architecture cannot accompany an arm64 driver.
  build(loader, "x86_64");
  assert.deepEqual(Vulkan.choices(context, dependencies).vulkanRuntimes, [{ value: "auto", label: "Automatic" }]);
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
  assert.deepEqual(Vulkan.choices({ userDataDir: path.join(os.tmpdir(), "no-vulkan-runtime-" + process.pid) }, { adapted: noAdapted }), {
    vulkanRuntimes: [{ value: "auto", label: "Automatic" }] });
});

test("managed GLES 3.2 starts with empty download choices and no app fallback", t => {
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

test("managed GLES 3.2 selections retain the complete closure and full launch verification", () => {
  const Managed = require("../src/modules/shared/vulkan/managed"), calls = [];
  const payloadRoot = path.join(os.tmpdir(), "managed-vulkan-payload");
  const manifest = { minimumMacOS: "27.0", runtimeFiles: { loader: "libvulkan.1.dylib" }, files: [
    {path: "libvulkan_kosmickrisp.dylib", architectures: ["arm64"]},
    {path: "libvulkan.1.dylib", architectures: ["arm64"]},
    {path: "libCompiler.dylib", architectures: ["arm64"]}, {path: "LICENSE"}] };
  let ready = true;
  const provider = Managed.createProvider({
    getState: () => ({installed: [{version:"selected"}]}),
    resolveSelection: (_entry, _settings, _data, options) => {
      calls.push(options);
      return {version:options.version, ready, install: ready ? {payloadRoot,manifest,executablePath:path.join(payloadRoot,manifest.files[0].path)} : null};
    }
  });
  const context = {userDataDir: os.tmpdir(), settings:{}};
  const installed = provider.installed(context)[0];
  assert.equal(installed.id, "kosmickrisp-gles32:selected");
  assert.equal(installed.readable.length, 3);
  assert.equal(installed.library, path.join(payloadRoot, "libvulkan.1.dylib"));
  assert.equal(installed.minimumMacOS, "27.0");
  assert.equal(provider.resolve(installed, context).driver, path.join(payloadRoot, "libvulkan_kosmickrisp.dylib"));
  assert.deepEqual(calls, [{version:"selected",verification:"status"},{version:"selected",verification:"full"}]);
  ready = false;
  assert.throws(() => provider.resolve(installed, context), /Install this version in Runtimes/);
});

test("saved GLES 3.2 choices request exact consented installation and reuse installed packages", () => {
  const uses = [], versions = [], context = {userDataDir: os.tmpdir(), settings:{}, runtimeSettings:{vulkanRuntime:"kosmickrisp:maclauncher-gles32"}, recordRuntimeUse: row => uses.push(row)};
  let ready = false;
  const manager = {id:"vulkan-kosmickrisp-gles32",resolveSelection: (_entry,_settings,_data,options) => {
    versions.push(options.version); return {version:options.version || "recommended",ready,install:ready ? {installDir:"/installed/native"} : null};
  }};
  const dependencies = {adaptedManager:manager};
  assert.deepEqual(Vulkan.requirements(context, dependencies), [{managerId:manager.id,version:"recommended",requiresDownload:true,installOptions:{}}]);
  context.runtimeSettings.vulkanRuntime = "kosmickrisp-gles32:older";
  assert.equal(Vulkan.requirements(context, dependencies)[0].version, "older");
  ready = true;
  assert.deepEqual(Vulkan.requirements(context, dependencies), []);
  assert.deepEqual(uses, [{managerId:manager.id,version:"older",sectionId:"default",sourcePath:"/installed/native"}]);
  for (const request of ["auto","moltenvk:1.0","kosmickrisp:stock"]) {
    context.runtimeSettings.vulkanRuntime = request;
    assert.deepEqual(Vulkan.requirements(context, dependencies), []);
  }
  assert.deepEqual(versions,[undefined,"older","older"]);
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
        source: {revision}};};
      let record = seal();
      const selected = manager.inspectPackage(directory, record);
      assert.equal(selected.manifest.upstreamRevision, revision);
      assert.equal(selected.executablePath, path.join(directory, prefix, library));
      Bundled.verifyPayload(directory, selected.declaration);
      assert.throws(() => manager.inspectPackage(directory, {...record, source: {revision: "f".repeat(40)}}), /source pin.*selected catalog/i);
      fs.appendFileSync(file, " ");
      assert.throws(() => manager.inspectPackage(directory, record), /manifest changed/);
      record = seal();
      if (prefix) manifest.provenance.capabilities.openglES = "3.1";
      else manifest.provider.sceneOperationAPI = 0;
      assert.throws(() => manager.inspectPackage(directory, seal()), /profile/);
      if (prefix) manifest.provenance.capabilities.openglES = "3.2";
      else manifest.provider.sceneOperationAPI = 1;
      record = seal();
      const intact = manager.inspectPackage(directory, record);
      const binaryPath = path.join(directory, prefix, library), tampered = fs.readFileSync(binaryPath);
      tampered[tampered.length - 1] ^= 1;
      fs.writeFileSync(binaryPath, tampered);
      assert.throws(() => Bundled.verifyPayload(directory, intact.declaration), /checksum.*changed/i);
    }
  }
});

test("Vulkan supplier catalogs retain exact historical macOS facts without seeds or future restrictions", async t => {
  const Libraries = require("../src/modules/shared/vulkan/libraries");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-platform-catalog-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [backend, version, observedRevision, minimumMacOS] of [
    ["moltenvk", "1.4.2", "db66022459ffb663aa2b50f6b018bc2e124f5edf", "12.0"],
    ["kosmickrisp", "3.4.3", "30fac9b95f99cda97312232be25ba55297bf9951", "26.0"]]) {
    const userDataDir = path.join(root, backend), versions = [version, "2030.1", "2030.2"];
    let revision = observedRevision, requests = 0;
    const tag = value => backend === "moltenvk" ? "v" + value : value;
    const dependencies = {systemVersionSync: () => "27.0",
      fetchGithubReleases: async () => {requests++;return versions.map(value => ({tag_name: tag(value), assets: [{
        name: "MoltenVK-macos.tar", digest: "sha256:" + "b".repeat(64), size: 1234,
        browser_download_url: `https://github.com/KhronosGroup/MoltenVK/releases/download/${tag(value)}/MoltenVK-macos.tar`}]}));},
      fetchGithubTags: async () => versions.map(value => ({name: tag(value), commit: {sha: value === version ? revision : "a".repeat(40)}})),
      headArtifact: async () => ({bytes: 1234}),
      fetchUrlBuffer: async url => url.startsWith("https://ghcr.io/token?")
        ? {status: 200, body: Buffer.from('{"token":"fixture-token"}')}
        : {status: 200, body: Buffer.from(JSON.stringify({name: "vulkan-loader", bottle: {stable: {files: {
          arm64_tahoe: {sha256: "b".repeat(64), url: "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + "b".repeat(64)}}}}}))}};
    const manager = Libraries.createManager(backend, dependencies);
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
    assert.equal(requests, 0);
    await manager.refreshCatalog({userDataDir, force: true});
    assert.deepEqual(new Set(manager.getState({userDataDir}).catalog.versions), new Set(versions));
    assert.equal(manager.core.catalog.find(pin => pin.version === version).minimumMacOS, minimumMacOS);
    for (const value of versions.slice(1)) assert.equal(manager.core.catalog.find(pin => pin.version === value).minimumMacOS, undefined);
    assert.equal(requests, 1);
    const offline = Libraries.createManager(backend, {...dependencies, fetchGithubReleases: () => assert.fail("cached state stays offline")});
    assert.deepEqual(new Set(offline.getState({userDataDir}).catalog.versions), new Set(versions));
    assert.equal(offline.core.catalog.find(pin => pin.version === version).minimumMacOS, minimumMacOS);
    revision = "c".repeat(40);
    await manager.refreshCatalog({userDataDir, force: true});
    assert.deepEqual(new Set(manager.getState({userDataDir}).catalog.versions), new Set(versions), "a changed source remains selectable");
    assert.equal(manager.core.catalog.find(pin => pin.version === version).minimumMacOS, undefined, "historical facts never apply to another revision");
  }
});

test("stock KosmicKrisp discovers upstream metadata, installs verified closures and reuses exact choices offline",
  {skip: process.platform !== "darwin" || process.arch !== "arm64"}, async t => {
    const Libraries = require("../src/modules/shared/vulkan/libraries"), HTTP = require("undici");
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-release-catalog-"));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
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
    let releases = 0, downloads = 0, metadataFailure = false, tamperedBottle = false;
    const previousDispatcher = HTTP.getGlobalDispatcher(), dispatcher = new HTTP.MockAgent();
    HTTP.setGlobalDispatcher(dispatcher);
    t.after(async () => {HTTP.setGlobalDispatcher(previousDispatcher);await dispatcher.close();});
    const metadata = [];
    for (const version of versions) dispatcher.get("https://build.lwjgl.org").intercept({method: "HEAD",
      path: `/release/${version}/macosx/arm64/libvulkan_kosmickrisp.dylib`}).reply(() => {
      metadata.push(version);
      return {statusCode: metadataFailure ? 403 : 200, data: "", responseOptions: {headers: {
        "content-length": String(fs.statSync(driver).size), ...(version === versions[1]
          ? {"x-amz-checksum-sha256": Buffer.from(driverSha, "hex").toString("base64")} : {})}}};
    }).persist();
    let redirectedHeads = 0;
    dispatcher.get("https://ghcr.io").intercept({method: "HEAD", path: new URL(bottleUrl).pathname,
      headers: {authorization: "Bearer fixture-token"}}).reply(307, "", {
      headers: {location: "https://pkg-containers.githubusercontent.com/vulkan-fixture"}}).persist();
    dispatcher.get("https://pkg-containers.githubusercontent.com").intercept({method: "HEAD", path: "/vulkan-fixture"}).reply(() => {
      redirectedHeads++;
      return {statusCode: 200, data: "", responseOptions: {headers: {"content-length": String(fs.statSync(bottle).size)}}};
    }).persist();
    const dependencies = {systemVersionSync: () => "26.0",
      fetchGithubReleases: async () => {releases++;return versions.map(version => ({tag_name: "v" + version}));},
      fetchGithubTags: async () => versions.map((version, index) => ({name: "v" + version, commit: {sha: String(index + 1).repeat(40)}})),
      fetchUrlBuffer: async url => {
        metadata.push(url);
        if (url.startsWith("https://ghcr.io/token?")) return {status: 200, body: Buffer.from('{"token":"fixture-token"}')};
        assert.equal(url, "https://formulae.brew.sh/api/formula/vulkan-loader.json");
        return {status: 200, body: Buffer.from(JSON.stringify({name: "vulkan-loader", bottle: {stable: {files: {
          arm64_golden_gate: {sha256: "f".repeat(64), url: "https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:" + "f".repeat(64)},
          arm64_tahoe: {sha256: bottleSha, url: bottleUrl}}}}}))};
      },
      downloadToFile: async (url, destination) => {
        downloads++;
        if (url === bottleUrl) {
          fs.copyFileSync(bottle, destination);
          if (tamperedBottle) fs.appendFileSync(destination, "tampered");
        } else {
          assert.ok(versions.some(version => url === `https://build.lwjgl.org/release/${version}/macosx/arm64/libvulkan_kosmickrisp.dylib`));
          fs.copyFileSync(driver, destination);
        }
      }};
    const userDataDir = path.join(root, "data"), manager = Libraries.createManager("kosmickrisp", dependencies);
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, []);
    assert.equal(metadata.length, 0);
    await manager.refreshCatalog({userDataDir, force: true});
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, versions);
    assert.equal(releases, 1);
    assert.equal(redirectedHeads, 1, "loader metadata follows the supplier's HEAD redirect without fetching the binary");
    assert.equal(downloads, 0, "Refresh reads metadata only");
    const pin = manager.core.catalog.find(pin => pin.version === versions[0]);
    assert.equal(pin.asset.integrity, "recorded-local");
    assert.equal(pin.upstreamRevision, "1".repeat(40));
    assert.equal(manager.core.catalog.find(pin => pin.version === versions[1]).asset.sha256, driverSha);
    const installed = await manager.installRuntime({userDataDir, version: versions[0]});
    assert.equal(installed.archiveSha256, driverSha);
    assert.equal(installed.artifactId, pin.asset.artifactId);
    assert.equal(installed.integritySource, "recorded-local");
    assert.deepEqual(installed.artifactVerification.architectures, ["arm64"]);
    assert.match(installed.catalogEntry.minimumMacOS, /^13\./);
    assert.equal(fs.readFileSync(path.join(installed.installDir, "Vulkan-Loader-LICENSE.txt"), "utf8"), "fixture loader license");
    tamperedBottle = true;
    await assert.rejects(manager.installRuntime({userDataDir, version: versions[1]}), /loader download differs/);
    tamperedBottle = false;
    await manager.installRuntime({userDataDir, version: versions[1]});
    metadataFailure = true;
    await assert.rejects(manager.refreshCatalog({userDataDir, force: true}), /403/);
    assert.deepEqual(manager.getState({userDataDir}).catalog.versions, versions, "failed refresh retains the catalog");
    const noNetwork = () => assert.fail("installed and cached choices stay offline");
    const offline = Libraries.createManager("kosmickrisp", {...dependencies, fetchGithubReleases: noNetwork,
      fetchGithubTags: noNetwork, fetchUrlBuffer: noNetwork, headArtifact: noNetwork, downloadToFile: noNetwork});
    const settings = {runtimes: {[offline.id]: {defaultVersion: versions[0]}}};
    assert.equal(offline.resolveSelection(null, settings, userDataDir).version, versions[0]);
    assert.equal(offline.resolveSelection(null, settings, userDataDir).ready, true);
    const context = {userDataDir}, options = {managers: [offline], adapted: noAdapted, architecture: "arm64", macOSVersion: "26.0"};
    assert.equal(Vulkan.installed(context, options).length, 2);
    fs.appendFileSync(path.join(installed.installDir, "libvulkan.1.dylib"), "tampered");
    assert.equal(Vulkan.installed(context, options).length, 1, "a changed loader cannot enter a graphics path");
  });
