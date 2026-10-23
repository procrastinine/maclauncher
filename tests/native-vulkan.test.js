const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Vulkan = require("../src/modules/shared/vulkan");
const { hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");
const noAdapted = { installed: () => [] };

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

test("managed GLES 3.2 has an offline installable catalog and no app fallback", t => {
  const Managed = require("../src/modules/shared/vulkan/managed");
  let queries = 0;
  const manager = Managed.createManager({ fetchUrlBuffer: () => { queries++; assert.fail("status must stay offline"); } });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-managed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { userDataDir: root, settings: {} }, state = manager.getState(context);
  assert.equal(manager.ui.management, "managed");
  assert.equal(manager.distributionRequired, false);
  assert.deepEqual(state.catalog.includedVersions, []);
  assert.ok(state.catalog.versions.length > 0);
  assert.ok(state.catalog.installableVersions.includes(state.catalog.recommendedVersion));
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
