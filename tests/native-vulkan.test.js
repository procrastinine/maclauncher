const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const Vulkan = require("../src/modules/shared/vulkan");
const { hashFile } = require("../src/modules/shared/runtime/pinned-native-manager");
const noIncluded = { installed: () => [] };

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
  const dependencies = { managers, architecture: "arm64", macOSVersion: "26.0", included: noIncluded };
  const context = { userDataDir: root, runtimeSettings: { vulkanRuntime: "kosmickrisp:fixture" } };
  const selected = Vulkan.resolve(context, dependencies);
  assert.equal(selected.library, loader); assert.deepEqual(selected.readable, [driver, loader]);
  let fullChecks = 0;
  const includedRecord = { id: "kosmickrisp:maclauncher-gles32", backend: "kosmickrisp", included: true,
    label: "KosmicKrisp · GLES 3.2 (included)", library: loader, driver, readable: [driver, loader] };
  const withIncluded = { ...dependencies, included: { installed: () => [includedRecord], resolve: item => { fullChecks++; return item; } } };
  assert.deepEqual(Vulkan.choices(context, withIncluded).vulkanRuntimes.map(item => item.value), ["auto", "kosmickrisp:fixture", includedRecord.id]);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: {} }, withIncluded).id, "kosmickrisp:fixture");
  assert.equal(fullChecks, 0);
  assert.equal(Vulkan.resolve({ ...context, runtimeSettings: { vulkanRuntime: includedRecord.id } }, withIncluded), includedRecord);
  assert.equal(fullChecks, 1);
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
  assert.deepEqual(Vulkan.choices({ userDataDir: path.join(os.tmpdir(), "no-vulkan-runtime-" + process.pid) }, { included: noIncluded }), {
    vulkanRuntimes: [{ value: "auto", label: "Automatic" }] });
});

test("included Vulkan uses the sealed component, compatible host and the shared ICD environment", t => {
  const Bundled = require("../src/modules/shared/runtime/bundled-native");
  const { createProvider } = require("../src/modules/shared/vulkan/included");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vulkan-included-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "1.0.0", id = "vulkan-kosmickrisp-gles32", directory = path.join(root, id, version, "arm64"), payload = path.join(directory, "files");
  fs.mkdirSync(payload, { recursive: true });
  const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(6, 12);
  const driver = "libvulkan_kosmickrisp.dylib", loader = "libvulkan.1.dylib", dependency = "libCompiler.dylib";
  for (const file of [driver, loader, dependency]) fs.writeFileSync(path.join(payload, file), binary, { mode: 0o755 });
  fs.writeFileSync(path.join(payload, "LICENSE"), "MIT", { mode: 0o644 });
  const revision = "a".repeat(40);
  const manifest = { schemaVersion: 1, managerId: id, version, upstreamRevision: revision, platform: "darwin", arch: "arm64",
    minimumMacOS: "27.0", executableRelative: driver, runtimeFiles: { loader }, provenance: { sourceRevision: revision },
    notices: [{ name: "Driver", license: "MIT", sourceUrl: "https://example.org", path: "LICENSE" }],
    dependencies: [{ file: driver, links: ["@loader_path/" + dependency] }, { file: dependency, links: ["/usr/lib/libSystem.B.dylib"] }, { file: loader, links: ["/usr/lib/libSystem.B.dylib"] }],
    files: Bundled.fileInventory(payload).map(file => { const stat = fs.statSync(path.join(payload, file)); return {
      path: file, size: stat.size, mode: stat.mode & 0o777, sha256: hashFile(path.join(payload, file)), ...(file.endsWith(".dylib") ? { architectures: ["arm64"] } : {}) }; }) };
  const manifestFile = path.join(directory, "manifest.json"); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const declarations = () => [{ id, version, arch: "arm64", manifestSha256: hashFile(manifestFile) }];
  let hostVersion = "27.0", signatures = 0;
  const provider = createProvider({ resourceRoot: root, platform: "darwin", arch: "arm64", dependencies: {
    declarations, hostArch: "arm64", systemVersionSync: () => hostVersion, verifySignaturesSync: () => { signatures++; } } });
  const context = { userDataDir: root, runtimeSettings: { vulkanRuntime: "kosmickrisp:maclauncher-gles32" } };
  const dependencies = { managers: [], included: provider };
  assert.equal(Vulkan.choices(context, dependencies).vulkanRuntimes[1].value, context.runtimeSettings.vulkanRuntime);
  assert.equal(signatures, 0, "choices only read component status");
  const selection = Vulkan.resolve(context, dependencies);
  assert.equal(selection.library, path.join(payload, loader)); assert.equal(selection.driver, path.join(payload, driver));
  assert.deepEqual(selection.readable.sort(), [driver, loader, dependency].map(file => path.join(payload, file)).sort());
  assert.equal(signatures, 1);
  for (const newerVersion of ["27.1", "27.2", "28.0"]) {
    hostVersion = newerVersion;
    assert.equal(provider.installed().length, 1);
    assert.equal(provider.resolve(selection).version, version);
  }
  const environment = Vulkan.environment(selection, root);
  assert.equal(environment.KL_MVK_DYLIB, selection.library);
  assert.equal(JSON.parse(fs.readFileSync(environment.VK_DRIVER_FILES)).ICD.library_path, selection.driver);
  for (const olderVersion of ["13.0", "26.0"]) {
    hostVersion = olderVersion;
    assert.deepEqual(provider.installed(), []);
    assert.throws(() => provider.resolve(selection), /requires macOS 27/);
  }
  hostVersion = "27.0";
  const changed = Buffer.from(binary); changed[31] = 1;
  fs.writeFileSync(path.join(payload, dependency), changed);
  assert.throws(() => provider.resolve(selection), /checksum or permissions changed/);
});
