const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Graphics = require("../src/modules/crossover/sikarugir/graphics");
const Hardware = require("../src/modules/crossover/sikarugir/graphics/hardware");
const { X64, image } = require("./fixtures/macho-image");

function put(file, bytes = "fixture") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function builtinDll(file, architecture, label) {
  const bytes = Buffer.alloc(512); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(120, 60);
  bytes.write("Wine builtin DLL\0", 64); bytes.writeUInt32LE(0x4550, 120);
  bytes.writeUInt16LE(architecture === "i386-windows" ? 0x14c : 0x8664, 124); bytes.writeUInt16LE(0x2000, 142);
  bytes.write(label, 256); return put(file, bytes);
}
function fixture(t, { rendererParent = "Frameworks" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-sikarugir-graphics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contents = path.join(root, "Template.app", "Contents"), frameworks = path.join(contents, "Frameworks");
  put(path.join(frameworks, "libcommon.dylib"), image({ cpu: X64, minimumOS: 0x000e0000 }));
  put(path.join(frameworks, "libMoltenVK.dylib"), image({ cpu: X64, minimumOS: 0x000b0000 }));
  put(path.join(frameworks, "libvulkan_kosmickrisp.dylib"), image({ cpu: X64, minimumOS: 0x001a0000 }));
  fs.symlinkSync("libcommon.dylib", path.join(frameworks, "libalias.dylib"));
  put(path.join(frameworks, "SikarugirSdk.framework", "SikarugirSdk"), image({ cpu: X64, minimumOS: 0x001a0000 }));
  put(path.join(contents, "MacOS", "launcher"));
  put(path.join(contents, "Configure.app", "Contents", "MacOS", "Configure"));
  const renderers = path.join(contents, rendererParent, "renderer");
  for (const [name, modules] of Object.entries(Graphics.__test.CORE_DLLS)) {
    put(path.join(renderers, name, "version"), name + "-1.0"); put(path.join(renderers, name, "LICENSE"), name + " license");
    for (const architecture of name === "d3dmetal" ? ["x86_64-windows"] : ["i386-windows", "x86_64-windows"]) {
      for (const module of modules) builtinDll(path.join(renderers, name, "wine", architecture, module + ".dll"), architecture, `${name}/${architecture}/${module}`);
    }
  }
  put(path.join(renderers, "dxmt", "wine", "x86_64-windows", "_d3d12.dll"), "experimental");
  put(path.join(renderers, "dxmt", "wine", "x86_64-unix", "winemetal.so"), image({ cpu: X64, minimumOS: 0x000e0000 }));
  put(path.join(renderers, "d3dmetal", "wine", "x86_64-unix", "d3d11.so"), image({ cpu: X64, minimumOS: 0x000e0000 }));
  put(path.join(renderers, "d3dmetal", "external", "D3DMetal.framework", "Versions", "A", "Resources", "version.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key><string>4.0b2</string></dict></plist>");
  put(path.join(renderers, "d3dmetal", "external", "D3DMetal.framework", "Versions", "A", "Resources", "libdxccontainer.dylib"),
    image({ cpu: X64, minimumOS: 0x001a0400 }));
  for (const [name, library] of [["MoltenVK_icd.json", "libMoltenVK.dylib"], ["kosmickrisp_mesa_icd.json", "libvulkan_kosmickrisp.dylib"]]) {
    put(path.join(contents, "Resources", "vulkan", "icd.d", name), JSON.stringify({ file_format_version: "1.0.0", ICD: {
      library_path: "../../../Frameworks/" + library, api_version: "1.4.0", ...(name === "MoltenVK_icd.json" ? { is_portability_driver: true } : {}) } }));
  }
  const gst = path.join(frameworks, "GStreamer.framework", "Versions", "1.0");
  put(path.join(gst, "lib", "libgst.dylib"), image({ cpu: X64, minimumOS: 0x000b0000 }));
  put(path.join(gst, "lib", "gstreamer-1.0", "plugin.dylib"), image({ cpu: X64, minimumOS: 0x000b0000 }));
  put(path.join(gst, "libexec", "gstreamer-1.0", "gst-plugin-scanner"), "scanner");
  const engineRoot = path.join(root, "engine", "wswine.bundle");
  // The Wine layout reads its CPU from the actual Unix ntdll image.
  put(path.join(engineRoot, "lib", "wine", "x86_64-unix", "ntdll.so"), image({ cpu: X64 }));
  put(path.join(engineRoot, "bin", "wine")); put(path.join(engineRoot, "bin", "wineserver"));
  for (const architecture of ["i386-windows", "x86_64-windows"]) for (const name of ["ntdll", "apisetschema"]) {
    builtinDll(path.join(engineRoot, "lib", "wine", architecture, name + ".dll"), architecture, name);
  }
  put(path.join(engineRoot, "share", "wine", "nls", "c_932.nls"));
  return { root, contents, frameworks, renderers, engineRoot, support: path.join(root, "install", "support") };
}
async function installed(t, options) {
  const f = fixture(t, options), metadata = await Graphics.stageTemplateClosure({ templateRoot: f.contents, destinationRoot: f.support });
  return { ...f, metadata, install: { templateRoot: f.support, engineRoot: f.engineRoot, executablePath: path.join(f.engineRoot, "bin", "wine"), capabilities: { msync: true } } };
}
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("graphics staging excludes wrapper UI and keeps runtime links, notices and optional driver floors separate", async t => {
  const f = await installed(t);
  assert.equal(f.metadata.minimumBaseMacOS, "14.0.0");
  assert.equal(f.metadata.graphicsCapabilities.minimumMacOS.kosmickrisp, "26.0.0");
  assert.equal(f.metadata.graphicsCapabilities.minimumMacOS.d3dmetal, "26.4.0");
  assert.equal(f.metadata.componentVersions.d3dmetal, "4.0b2");
  for (const unwanted of ["MacOS", "Configure.app", "Frameworks/SikarugirSdk.framework"]) assert.equal(fs.existsSync(path.join(f.support, unwanted)), false);
  assert.equal(fs.readlinkSync(path.join(f.support, "Frameworks", "libalias.dylib")), "libcommon.dylib");
  assert.equal(fs.readFileSync(path.join(f.support, "Frameworks", "renderer", "dxmt", "LICENSE"), "utf8"), "dxmt license");
  assert.equal(fs.existsSync(path.join(f.support, "Resources", "vulkan", "icd.d", "MoltenVK_icd.json")), true);
});
test("graphics staging finds renderers in the Template's SharedSupport folder and installs them in the same place", async t => {
  const f = await installed(t, { rendererParent: "SharedSupport" });
  assert.equal(fs.existsSync(path.join(f.contents, "Frameworks", "renderer")), false);
  assert.equal(f.metadata.relativePaths.templateRenderers, "SharedSupport/renderer");
  assert.equal(f.metadata.relativePaths.renderers, "Frameworks/renderer");
  for (const name of ["dxmt", "dxvk", "dxvk3", "d9vk", "cncDdraw", "d3dmetal"]) assert.equal(f.metadata.graphicsCapabilities[name], true, name);
  assert.equal(f.metadata.graphicsCapabilities.minimumMacOS.d3dmetal, "26.4.0");
  assert.equal(f.metadata.componentVersions.d3dmetal, "4.0b2");
  assert.ok(f.metadata.nativeDependencies.some(item => item.path === "renderer/dxmt/wine/x86_64-unix/winemetal.so"));
  assert.equal(fs.readFileSync(path.join(f.support, "Frameworks", "renderer", "dxmt", "LICENSE"), "utf8"), "dxmt license");
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "d3dmetal" }, viewRoot: path.join(f.root, "game", "view"),
    host: { hardwareArch: "arm64", macOSVersion: "26.5" }, executableArchitecture: "x86_64" });
  assert.ok(result.env.DYLD_FALLBACK_FRAMEWORK_PATH.includes(path.join(fs.realpathSync(f.support), "Frameworks", "renderer", "d3dmetal", "external")));
  const legacy = await installed(t);
  assert.equal(legacy.metadata.relativePaths.templateRenderers, "Frameworks/renderer");
  assert.deepEqual(legacy.metadata.graphicsCapabilities, f.metadata.graphicsCapabilities);
});
test("D3DMetal is not offered below its measured or recorded macOS floor", async t => {
  const f = await installed(t), capabilities = version => Graphics.capabilitiesFor(f.install, f.support, { hardwareArch: "arm64", macOSVersion: version });
  assert.equal(capabilities("26.3").d3dmetal, false);
  assert.equal(capabilities("26.4").d3dmetal, true);
  const early = fixture(t);
  fs.rmSync(path.join(early.renderers, "d3dmetal", "external", "D3DMetal.framework", "Versions", "A", "Resources", "libdxccontainer.dylib"));
  assert.equal(Graphics.inspectTemplateClosure(early.contents).graphicsCapabilities.minimumMacOS.d3dmetal, Graphics.MINIMUM_MACOS.d3dmetal);
});
test("recorded renderer floors, physical CPU and unknown host facts remain independent", async t => {
  const f = await installed(t), metadata = structuredClone(f.metadata);
  metadata.graphicsCapabilities.minimumMacOS.d3dmetal = "15.4.2";
  metadata.graphicsCapabilities.minimumMacOS.dxvk3 = "26.4.2";
  const install = { ...f.install, graphicsMetadata: metadata };
  const capabilities = host => Graphics.capabilitiesFor(install, f.support, { platform: "darwin", ...host });
  assert.equal(capabilities({ hardwareArch: "arm64", macOSVersion: "15.4.1" }).d3dmetal, false);
  const older = capabilities({ hardwareArch: "arm64", macOSVersion: "15.4.2" });
  assert.equal(older.d3dmetal, true, "a working earlier installed Template keeps its own measured floor");
  assert.equal(older.dxmt, true);assert.equal(older.moltenvk, true);
  assert.equal(capabilities({ hardwareArch: "arm64", macOSVersion: "26.4.1" }).dxvk3, false);
  assert.equal(capabilities({ hardwareArch: "arm64", macOSVersion: "26.4.2" }).dxvk3, true);
  const intel = capabilities({ hardwareArch: "x64", macOSVersion: "27.0" });
  assert.equal(intel.d3dmetal, false);assert.equal(intel.kosmickrisp, false);assert.equal(intel.dxvk3, false);
  assert.equal(intel.dxmt, true);assert.equal(intel.moltenvk, true);
  const unknown = capabilities({ hardwareArch: null, macOSVersion: null });
  assert.equal(unknown.d3dmetal, true);assert.equal(unknown.automaticKosmicKrisp, false,
    "automatic GPU choice still waits for the native device query");
  metadata.graphicsCapabilities.minimumMacOS.kosmickrisp = "26.4.2";
  const higher = capabilities({ hardwareArch: "arm64", macOSVersion: "26.4.1" });
  assert.equal(higher.kosmickrisp, false);
  assert.throws(() => Graphics.__test.selectGraphics({ vulkanBackend: "kosmickrisp" }, higher, "x86_64"), /macOS 26\.4\.2 or later/);
  assert.equal(Graphics.__test.selectGraphics({}, higher, "x86_64").vulkanBackend, "moltenvk");
});
test("graphics discovery orders known layouts by an open-ended version threshold", t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.contents, "SharedSupport", "renderer"), { recursive: true });
  for (const version of ["1.0.24", "1.0.25", "2.0.0"]) assert.equal(Graphics.templateRenderers(f.contents, version), "SharedSupport/renderer");
  assert.equal(Graphics.templateRenderers(f.contents, "1.0.23"), "Frameworks/renderer");
  fs.rmSync(f.renderers, { recursive: true });
  assert.equal(Graphics.templateRenderers(f.contents, "1.0.21"), "SharedSupport/renderer", "the other layout remains a fallback");
  fs.rmSync(path.join(f.contents, "SharedSupport"), { recursive: true });
  fs.mkdirSync(path.join(f.contents, "Resources", "Libraries", "renderer"), { recursive: true });
  assert.equal(Graphics.inspectTemplateClosure(f.contents, { templateVersion: "2.0.0" }).relativePaths.templateRenderers, "Resources/Libraries/renderer");
});
test("graphics staging without a renderer folder records none and rejects ambiguous content search", async t => {
  const f = fixture(t);
  fs.rmSync(f.renderers, { recursive: true });
  const metadata = Graphics.inspectTemplateClosure(f.contents);
  assert.equal(metadata.relativePaths.templateRenderers, null);
  for (const name of ["dxmt", "dxvk", "d3dmetal"]) assert.equal(metadata.graphicsCapabilities[name], false);
  fs.mkdirSync(path.join(f.contents, "Other", "renderer"), { recursive: true }); fs.mkdirSync(path.join(f.contents, "Another", "renderer"), { recursive: true });
  assert.throws(() => Graphics.inspectTemplateClosure(f.contents), /more than one renderer folder/);
});
test("graphics staging rejects escaping library aliases before copying", async t => {
  const f = fixture(t), outside = put(path.join(f.root, "outside.dylib"));
  fs.symlinkSync(outside, path.join(f.frameworks, "libescape.dylib"));
  await assert.rejects(Graphics.stageTemplateClosure({ templateRoot: f.contents, destinationRoot: f.support }), /escapes its package/);
  assert.equal(fs.existsSync(f.support), false);
});
test("graphics staging cancellation does not publish a partial runtime", async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(Graphics.stageTemplateClosure({ templateRoot: f.contents, destinationRoot: f.support, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fs.existsSync(f.support), false);
});
test("Automatic on older macOS uses DXMT without forcing Tahoe D9VK and selects MoltenVK", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: {}, viewRoot, host: { hardwareArch: "arm64", macOSVersion: "15.7" }, executableArchitecture: "x86" });
  assert.deepEqual(result.components, ["dxmt"]); assert.equal(result.vulkanBackend, "moltenvk");
  assert.equal(result.capabilities.kosmickrisp, false); assert.equal(result.capabilities.msync, true);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d11.dll")), true);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d9.dll")), false);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "x86_64-windows", "_d3d12.dll")), false);
  assert.deepEqual(result.dllOverrides, ["d3d10core,d3d11,dxgi,winemetal=b"]);
  assert.equal(JSON.parse(fs.readFileSync(result.env.VK_DRIVER_FILES)).ICD.library_path, fs.realpathSync(path.join(f.support, "Frameworks", "libMoltenVK.dylib")));
});
test("DLSS adds DXMT vendor libraries only when explicitly enabled and keeps shared binaries unchanged", async t => {
  const f = await installed(t), root = path.join(f.support, "Frameworks", "renderer", "dxmt", "wine", "x86_64-windows");
  for (const name of ["nvapi64", "nvngx"]) builtinDll(path.join(root, name + ".dll"), "x86_64-windows", name);
  const original = path.join(root, "nvngx.dll"), before = hash(original);
  const prefixPath = path.join(f.root, "game", "prefix"), system32 = path.join(prefixPath, "drive_c", "windows", "system32");
  put(path.join(system32, "d3d11.dll"), "existing prefix library");
  const external = put(path.join(f.root, "custom.dll"), "custom library");fs.symlinkSync(external, path.join(system32, "d3d10core.dll"));
  const base = { install: f.install, prefixPath, host: { hardwareArch: "arm64", macOSVersion: "15.7" }, executableArchitecture: "x86_64" };
  const enabled = await Graphics.prepareGraphicsView({ ...base, settings: { dlss: true }, viewRoot: path.join(f.root, "game", "dlss") });
  assert.equal(enabled.env.DXMT_ENABLE_NVEXT, "1");
  assert.equal(enabled.env.D3DM_ENABLE_METALFX, "0");
  assert.equal(enabled.dlss.enabled, true);
  assert.ok(enabled.dllOverrides.some(line => line.includes("nvapi64,nvngx=b")));
  assert.equal(fs.realpathSync(path.join(enabled.dllRoot, "x86_64-windows", "nvngx.dll")), fs.realpathSync(original));
  await enabled.applyPrefix();
  assert.equal(fs.readlinkSync(path.join(system32, "nvngx.dll")), path.join(enabled.dllRoot, "x86_64-windows", "nvngx.dll"));
  assert.equal(fs.readFileSync(path.join(system32, "d3d11.dll"), "utf8"), "existing prefix library");
  assert.equal(fs.readlinkSync(path.join(system32, "d3d10core.dll")), external);
  const disabled = await Graphics.prepareGraphicsView({ ...base, settings: {}, viewRoot: path.join(f.root, "game", "default") });
  assert.equal(disabled.env.DXMT_ENABLE_NVEXT, "0");
  assert.equal(fs.existsSync(path.join(disabled.dllRoot, "x86_64-windows", "nvngx.dll")), false);
  await disabled.applyPrefix();
  assert.equal(fs.existsSync(path.join(system32, "nvngx.dll")), false, "disabling integration removes only its managed prefix link");
  assert.equal(fs.readFileSync(path.join(system32, "d3d11.dll"), "utf8"), "existing prefix library");
  assert.equal(fs.readlinkSync(path.join(system32, "d3d10core.dll")), external);
  assert.equal(hash(original), before);
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, settings: { dlss: true }, executableArchitecture: "x86", viewRoot: path.join(f.root, "game", "x86") }), /64-bit Windows/);
  fs.unlinkSync(original);
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, settings: { dlss: true }, viewRoot: path.join(f.root, "game", "missing") }), /unavailable/);
});
test("D3DMetal DLSS requires the engine's actual path conversion exports before preparing a game", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "dlss-d3dm");
  const options = { install: f.install, settings: { graphicsBackend: "d3dmetal", dlss: true }, viewRoot,
    host: { hardwareArch: "arm64", macOSVersion: "27.0" }, executableArchitecture: "x86_64" };
  const ntdll = path.join(f.engineRoot, "lib", "wine", "x86_64-unix", "ntdll.so");
  for (const symbols of [[], ["wine_nt_to_unix_file_name", "wine_unix_to_nt_file_name"], ["ntdll_get_unix_file_name"]]) {
    fs.writeFileSync(ntdll, image({ cpu: X64, symbols }));
    await assert.rejects(Graphics.prepareGraphicsView(options), /cannot expose MetalFX Temporal through D3DMetal/);
    assert.equal(fs.existsSync(viewRoot), false);
  }
  fs.writeFileSync(ntdll, image({ cpu: X64, symbols: ["ntdll_get_unix_file_name", "ntdll_get_dos_file_name"] }));
  const result = await Graphics.prepareGraphicsView(options);
  assert.equal(result.dlss.d3dmetal, true);
  assert.equal(result.env.D3DM_ENABLE_METALFX, "1");
  // Ordinary D3DMetal rendering does not need NGX discovery.
  fs.writeFileSync(ntdll, image({ cpu: X64 }));
  const plain = await Graphics.prepareGraphicsView({ ...options, settings: { graphicsBackend: "d3dmetal" }, viewRoot: viewRoot + "-off" });
  assert.equal(plain.dlss.enabled, false);
});
test("Automatic on Tahoe selects KosmicKrisp under D9VK while retaining DXMT and private cache state", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const before = hash(path.join(f.support, "Frameworks", "renderer", "dxmt", "wine", "i386-windows", "d3d11.dll"));
  const options = { install: f.install, settings: {}, viewRoot, host: { hardwareArch: "arm64", macOSVersion: "26.1", physicalAppleGPU: true }, executableArchitecture: "x86" };
  const result = await Graphics.prepareGraphicsView(options);
  assert.deepEqual(result.components, ["dxmt", "d9vk"]); assert.equal(result.vulkanBackend, "kosmickrisp");
  assert.equal(fs.realpathSync(path.join(result.dllRoot, "i386-windows", "d3d9.dll")), fs.realpathSync(path.join(f.support, "Frameworks", "renderer", "d9vk", "wine", "i386-windows", "d3d9.dll")));
  assert.equal(result.env.GST_REGISTRY_1_0, path.join(viewRoot, "gstreamer-registry.bin"));
  assert.equal(result.env.VK_DRIVER_FILES, result.env.VK_ICD_FILENAMES);
  assert.ok(result.env.DYLD_FALLBACK_LIBRARY_PATH.includes(path.join(fs.realpathSync(f.engineRoot), "lib", "wine", "x86_64-unix")));
  await Graphics.prepareGraphicsView(options);
  assert.equal(hash(path.join(f.support, "Frameworks", "renderer", "dxmt", "wine", "i386-windows", "d3d11.dll")), before);
});
test("Automatic keeps DXMT and chooses MoltenVK when physical Apple GPU support is unknown or virtual", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const base = { install: f.install, settings: {}, viewRoot, executableArchitecture: "x86" };
  await Graphics.prepareGraphicsView({ ...base, host: { hardwareArch: "arm64", macOSVersion: "26.1", physicalAppleGPU: true } });
  const result = await Graphics.prepareGraphicsView({ ...base, host: { hardwareArch: "arm64", macOSVersion: "26.1", physicalAppleGPU: false } });
  assert.deepEqual(result.components, ["dxmt"]); assert.equal(result.vulkanBackend, "moltenvk");
  assert.equal(result.capabilities.kosmickrisp, true); assert.equal(result.capabilities.automaticKosmicKrisp, false);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d9.dll")), false);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d8.dll")), false);
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d11.dll")), true);
  const explicit = await Graphics.prepareGraphicsView({ ...base, settings: { vulkanBackend: "kosmickrisp" },
    host: { hardwareArch: "arm64", macOSVersion: "26.1", physicalAppleGPU: false } });
  assert.equal(explicit.vulkanBackend, "kosmickrisp"); assert.deepEqual(explicit.components, ["dxmt", "d9vk"]);
});
test("graphics hardware evidence is conservative, bounded to display records and cached without network", async () => {
  assert.equal(Hardware.physicalAppleGpu({ SPDisplaysDataType: [{ sppci_model: "Apple M4 Pro" }] }), true);
  assert.equal(Hardware.physicalAppleGpu({ SPDisplaysDataType: [{ sppci_model: "Apple Paravirtual device" }] }), false);
  assert.equal(Hardware.physicalAppleGpu({ SPDisplaysDataType: [] }), false);
  assert.equal(Hardware.physicalAppleGpu({ gpuDevice: [{ deviceString: "Apple M2 Max" }] }), true);
  Hardware.__test.reset(); let calls = 0, time = 100;
  const dependencies = { read: async () => { calls++; return { physicalAppleGPU: false, source: "unavailable" }; }, now: () => time };
  const host = { platform: "darwin", hardwareArch: "arm64" };
  await Promise.all([Hardware.graphicsHardware(host, dependencies), Hardware.graphicsHardware(host, dependencies)]);
  assert.equal(calls, 1); await Hardware.graphicsHardware(host, dependencies); assert.equal(calls, 1);
  time += Hardware.__test.CACHE_MS; await Hardware.graphicsHardware(host, dependencies); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Hardware.graphicsHardware(host, { ...dependencies, signal: controller.signal }), { name: "AbortError" });
  Hardware.__test.reset();
});
test("WineD3D has no replacement DLLs but still configures a Vulkan driver for direct Vulkan applications", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "wined3d", vulkanBackend: "moltenvk" }, viewRoot, host: { hardwareArch: "arm64", macOSVersion: "26.1" } });
  assert.deepEqual(result.components, []); assert.deepEqual(result.dllOverrides, []);
  assert.equal(result.wineRoot, fs.realpathSync(f.engineRoot));
  assert.equal(result.vulkanBackend, "moltenvk"); assert.ok(fs.existsSync(result.env.VK_DRIVER_FILES));
});
test("private MoltenVK discovery works for Windows instance flags and preserves upstream driver metadata", async t => {
  const f = await installed(t), source = path.join(f.support, "Resources", "vulkan", "icd.d", "MoltenVK_icd.json");
  const before = hash(source), original = JSON.parse(fs.readFileSync(source));
  const options = { install: f.install, settings: { graphicsBackend: "wined3d", vulkanBackend: "moltenvk" },
    viewRoot: path.join(f.root, "game", "moltenvk"), host: { hardwareArch: "arm64", macOSVersion: "26.1" } };
  const result = await Graphics.prepareGraphicsView(options), descriptor = JSON.parse(fs.readFileSync(result.env.VK_DRIVER_FILES));
  assert.equal(original.ICD.is_portability_driver, true); assert.equal(descriptor.ICD.is_portability_driver, false);
  assert.equal(descriptor.ICD.api_version, original.ICD.api_version); assert.equal(hash(source), before);
  assert.equal(result.env.VK_DRIVER_FILES, result.env.VK_ICD_FILENAMES);
  const kosmic = await Graphics.prepareGraphicsView({ ...options, settings: { graphicsBackend: "wined3d", vulkanBackend: "kosmickrisp" },
    viewRoot: path.join(f.root, "game", "kosmic") });
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(kosmic.env.VK_DRIVER_FILES)).ICD, "is_portability_driver"), false);
});
test("DXVK selects the older MoltenVK-compatible layout or full newer KosmicKrisp layout", async t => {
  const f = await installed(t);
  for (const [driver, component] of [["moltenvk", "dxvk"], ["kosmickrisp", "dxvk3"]]) {
    const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "dxvk", vulkanBackend: driver }, viewRoot: path.join(f.root, "game", driver), host: { hardwareArch: "arm64", macOSVersion: "26.1" } });
    assert.deepEqual(result.components, [component]);
  }
});
test("unsupported host, D3DMetal 32-bit game and malformed settings fail with actionable messages", async t => {
  const f = await installed(t);
  const base = { install: f.install, viewRoot: path.join(f.root, "game", "view"), host: { hardwareArch: "arm64", macOSVersion: "15.7" } };
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, settings: { vulkanBackend: "kosmickrisp" } }), /Apple Silicon and macOS 26/);
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, host: { hardwareArch: "arm64", macOSVersion: "26.5" }, settings: { graphicsBackend: "d3dmetal" }, executableArchitecture: "x86" }), /64-bit Windows/);
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, settings: { graphicsBackend: "bogus" } }), /Unsupported Direct3D/);
  await assert.rejects(Graphics.prepareGraphicsView({ ...base, host: { hardwareArch: "arm64", macOSVersion: "13.6" } }), /requires macOS 14/);
});
test("D3DMetal stages its native bridge without modifying shared framework files", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "d3dmetal" }, viewRoot, host: { hardwareArch: "arm64", macOSVersion: "26.5" }, executableArchitecture: "x86_64" });
  assert.deepEqual(result.components, ["d3dmetal"]);
  assert.ok(result.env.DYLD_FALLBACK_FRAMEWORK_PATH.includes(path.join(fs.realpathSync(f.support), "Frameworks", "renderer", "d3dmetal", "external")));
  assert.ok(fs.lstatSync(path.join(result.dllRoot, "x86_64-unix", "d3d11.so")).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(result.dllRoot, "i386-windows", "d3d12.dll")), false);
});
test("DirectDraw compatibility is an explicit 32-bit override independent of the Direct3D selection", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const options = { install: f.install, settings: { graphicsBackend: "wined3d", cncDdraw: true }, viewRoot,
    host: { hardwareArch: "arm64", macOSVersion: "26.5" }, executableArchitecture: "x86" };
  const result = await Graphics.prepareGraphicsView(options);
  assert.deepEqual(result.components, ["cnc_ddraw"]); assert.deepEqual(result.dllOverrides, ["ddraw=b"]);
  assert.ok(fs.existsSync(path.join(result.dllRoot, "i386-windows", "ddraw.dll")));
  assert.equal(fs.existsSync(path.join(result.dllRoot, "x86_64-windows", "d3d11.dll")), false);
  await assert.rejects(Graphics.prepareGraphicsView({ ...options, executableArchitecture: "x86_64" }), /32-bit Windows/);
});
test("per-game renderer paths reject links into shared installations and changed DLL selections", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "game", "view");
  const options = { install: f.install, settings: {}, viewRoot, host: { hardwareArch: "arm64", macOSVersion: "15.7" } };
  await assert.rejects(Graphics.prepareGraphicsView({ ...options, viewRoot: path.join(f.support, "view") }), /outside the shared runtime/);
  fs.mkdirSync(path.dirname(viewRoot), { recursive: true }); fs.symlinkSync(f.support, viewRoot);
  await assert.rejects(Graphics.prepareGraphicsView(options), /symbolic links|outside the shared runtime/);
  fs.unlinkSync(viewRoot); const result = await Graphics.prepareGraphicsView(options);
  const dll = path.join(result.dllRoot, "i386-windows", "d3d11.dll"); fs.unlinkSync(dll); fs.writeFileSync(dll, "modified");
  await assert.rejects(Graphics.prepareGraphicsView(options), /private renderer selection changed/);
});
test("selected renderers use a private loader anchor with shared immutable fallback and reusable small copies", async t => {
  const f = await installed(t), options = { install: f.install, settings: {}, viewRoot: path.join(f.root, "game", "view"),
    host: { hardwareArch: "arm64", macOSVersion: "15.7" } };
  const original = path.join(f.engineRoot, "bin", "wine"), sourceNtdll = path.join(f.engineRoot, "lib", "wine", "x86_64-unix", "ntdll.so");
  const before = [hash(original), hash(sourceNtdll)];
  const result = await Graphics.prepareGraphicsView(options), ntdll = path.join(result.dllRoot, "x86_64-unix", "ntdll.so");
  assert.equal(result.wineRoot, path.join(options.viewRoot, "wine"));
  assert.equal(result.env.WINEDLLPATH, path.join(fs.realpathSync(f.engineRoot), "lib", "wine"));
  assert.equal(result.env.DYLD_LIBRARY_PATH.split(path.delimiter)[0], result.libraryOverride);
  for (const [copy, source] of [[result.executablePath, original], [ntdll, sourceNtdll]]) {
    assert.ok(fs.lstatSync(copy).isFile()); assert.equal(hash(copy), hash(source)); assert.notEqual(fs.statSync(copy).ino, fs.statSync(source).ino);
  }
  for (const name of ["ntdll.dll", "apisetschema.dll"]) assert.equal(fs.realpathSync(path.join(result.dllRoot, "x86_64-windows", name)),
    fs.realpathSync(path.join(f.engineRoot, "lib", "wine", "x86_64-windows", name)));
  assert.equal(fs.realpathSync(path.join(result.wineRoot, "share")), fs.realpathSync(path.join(f.engineRoot, "share")));
  const inode = fs.statSync(ntdll).ino; await Graphics.prepareGraphicsView(options); assert.equal(fs.statSync(ntdll).ino, inode);
  assert.deepEqual([hash(original), hash(sourceNtdll)], before);
  fs.writeFileSync(ntdll, "changed"); await assert.rejects(Graphics.prepareGraphicsView(options), /private Wine loader changed/);
  assert.deepEqual([hash(original), hash(sourceNtdll)], before);
});
test("renderer selection validates actual Wine DLL format and architecture before launch", async t => {
  const f = await installed(t), source = path.join(f.support, "Frameworks", "renderer", "dxmt", "wine", "i386-windows", "d3d11.dll");
  const options = { install: f.install, settings: {}, viewRoot: path.join(f.root, "game", "view"), host: { hardwareArch: "arm64", macOSVersion: "15.7" } };
  builtinDll(source, "x86_64-windows", "wrong machine");
  await assert.rejects(Graphics.prepareGraphicsView(options), /does not match its Windows architecture/);
  const bytes = fs.readFileSync(source); bytes.fill(0, 64, 128); fs.writeFileSync(source, bytes);
  await assert.rejects(Graphics.prepareGraphicsView(options), /supported Wine builtin DLL package/);
});
test("engines with a separate Unix loader retain its distinct address-space layout", async t => {
  const f = await installed(t), unixLoader = path.join(f.engineRoot, "lib", "wine", "x86_64-unix", "wine");
  put(unixLoader, "producer loader with small PAGEZERO and fixed high text address");
  const options = { install: f.install, settings: {}, viewRoot: path.join(f.root, "game", "modern-view"), host: { hardwareArch: "arm64", macOSVersion: "15.7" } };
  const result = await Graphics.prepareGraphicsView(options), copy = path.join(result.dllRoot, "x86_64-unix", "wine");
  assert.equal(fs.lstatSync(copy).isSymbolicLink(), false);
  assert.equal(hash(copy), hash(unixLoader));assert.notEqual(hash(copy), hash(result.executablePath));
  assert.notEqual(fs.statSync(copy).ino, fs.statSync(unixLoader).ino);
  const inode = fs.statSync(copy).ino;await Graphics.prepareGraphicsView(options);assert.equal(fs.statSync(copy).ino, inode);
  fs.writeFileSync(copy, "changed");await assert.rejects(Graphics.prepareGraphicsView(options), /private Wine loader changed/);
  assert.equal(fs.readFileSync(unixLoader, "utf8"), "producer loader with small PAGEZERO and fixed high text address");
});
test("camera rendering uses one private matched closure and a distinct immutable native-library alias", async t => {
  const f = await installed(t), base = path.join(f.support, "Frameworks/renderer/dxmt/wine"), directory = path.join(f.root, "camera");
  for (const name of ["nvapi64", "nvngx"]) builtinDll(path.join(base, "x86_64-windows", name + ".dll"), "x86_64-windows", name);
  for (const name of ["d3d11", "dxgi", "nvngx"]) builtinDll(path.join(directory, "x86_64-windows", name + ".dll"), "x86_64-windows", "adapted " + name);
  put(path.join(directory, "x86_64-unix/winemetal.so"), "forwarder");
  const selectedBase = path.join(f.root, "managed-bridge/wine");fs.cpSync(base, selectedBase, { recursive: true });
  const native = path.join(selectedBase, "x86_64-unix/winemetal.so"), before = hash(native), cameraBridge = { baseRoot: selectedBase, dxmt: { directory, native } };
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { dlss: true, graphicsBackend: "dxmt" }, viewRoot: path.join(f.root, "game/camera-view"),
    host: { hardwareArch: "arm64", macOSVersion: "26.0" }, executableArchitecture: "x86_64", cameraBridge });
  for (const file of ["x86_64-windows/d3d11.dll", "x86_64-windows/dxgi.dll", "x86_64-windows/nvngx.dll", "x86_64-unix/winemetal.so"])
    assert.equal(fs.realpathSync(path.join(result.dllRoot, file)), fs.realpathSync(path.join(directory, file)));
  assert.equal(fs.realpathSync(path.join(result.dllRoot, "x86_64-windows/winemetal.dll")), fs.realpathSync(path.join(selectedBase, "x86_64-windows/winemetal.dll")));
  assert.equal(result.env.MACLAUNCHER_DXMT_BASE_LIBRARY, path.join(result.dllRoot, "x86_64-unix/maclauncher-dxmt-original.so"));
  assert.equal(fs.realpathSync(result.env.MACLAUNCHER_DXMT_BASE_LIBRARY), fs.realpathSync(native));assert.equal(hash(native), before);
});

test("GPU compute helper pairs use a private Wine anchor even for direct Vulkan without renderer replacements", async t => {
  const f = await installed(t), viewRoot = path.join(f.root, "compute", "view");
  const windows = builtinDll(path.join(f.root, "helper", "maclauncher-compute.dll"), "x86_64-windows", "compute helper");
  const unix = put(path.join(f.root, "helper", "maclauncher-compute.so"), image({ cpu: X64, minimumOS: 0x000e0000 }));
  const original = hash(f.install.executablePath);
  const result = await Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "wined3d", vulkanBackend: "kosmickrisp" },
    viewRoot, host: { hardwareArch: "arm64", macOSVersion: "26.4" }, executableArchitecture: "x64",
    helperLibraries: [{ name: "maclauncher-compute", windows, unix }] });
  assert.deepEqual(result.components, []);
  assert.notEqual(result.executablePath, f.install.executablePath);
  assert.equal(hash(f.install.executablePath), original);
  assert.equal(fs.realpathSync(path.join(result.dllRoot, "x86_64-windows", "maclauncher-compute.dll")), fs.realpathSync(windows));
  assert.equal(fs.realpathSync(path.join(result.dllRoot, "x86_64-unix", "maclauncher-compute.so")), fs.realpathSync(unix));
  assert.deepEqual(result.dllOverrides, ["maclauncher-compute=b"]);
  await assert.rejects(Graphics.prepareGraphicsView({ install: f.install, settings: { graphicsBackend: "wined3d" },
    viewRoot: path.join(f.root, "compute", "reserved"), host: { hardwareArch: "arm64", macOSVersion: "26.4" },
    helperLibraries: [{ name: "ntdll", windows, unix }] }), /helper name/);
});

test("vendor dependencies use fallback paths while the HUD and private ntdll override remain available", async t => {
  const f = await installed(t), frameworks = path.join(f.support, "Frameworks"), gstLib = path.join(frameworks, "GStreamer.framework", "Versions", "1.0", "lib");
  fs.mkdirSync(gstLib, {recursive: true});
  const translatorView = {identity: "fallback-scope", links: {}, env: {}, dllOverrides: [],
    libraryPaths: [path.join(f.root, "translator-dependencies")], frameworkPaths: [path.join(f.root, "translator-frameworks")]};
  const result = await Graphics.prepareGraphicsView({install: f.install, settings: {graphicsBackend: "dxmt"},
    viewRoot: path.join(f.root, "game", "fallback-view"), host: {hardwareArch: "arm64", macOSVersion: "26.4"}, translatorView});
  const vendors = [frameworks, gstLib, path.join(f.engineRoot, "lib/wine/x86_64-unix"),
    path.join(frameworks, "renderer/dxmt/wine/x86_64-unix"), ...translatorView.libraryPaths];
  assert.deepEqual(result.env.DYLD_LIBRARY_PATH.split(path.delimiter), [result.libraryOverride],
    "only the private ntdll anchor may override system library lookup");
  assert.deepEqual(fs.readdirSync(result.libraryOverride), ["ntdll.so"]);
  assert.equal(fs.realpathSync(path.join(result.libraryOverride, "ntdll.so")), fs.realpathSync(path.join(result.dllRoot, "x86_64-unix/ntdll.so")));
  const canonical = value => fs.existsSync(value) ? fs.realpathSync(value) : value;
  const fallback = result.env.DYLD_FALLBACK_LIBRARY_PATH.split(path.delimiter).map(canonical);
  for (const directory of vendors) assert.ok(fallback.includes(canonical(directory)), directory);
  assert.equal(result.env.DYLD_FRAMEWORK_PATH, undefined);
  assert.ok(result.env.DYLD_FALLBACK_FRAMEWORK_PATH.split(path.delimiter).map(canonical).includes(canonical(frameworks)));
  assert.ok(result.env.DYLD_FALLBACK_FRAMEWORK_PATH.split(path.delimiter).includes(translatorView.frameworkPaths[0]));
  const launch = require("../src/modules/crossover/sikarugir/launch").buildEnvironment({metalHud: true}, f.install,
    path.join(f.root, "game"), path.join(f.root, "prefix"), result, {baseEnvironment: {}});
  assert.equal(launch.environment.MTL_HUD_ENABLED, "1");
  const stock = require("../src/modules/crossover/sikarugir/launch").prefixRuntime(f.install, path.join(f.root, "game"));
  assert.equal(stock.env.DYLD_LIBRARY_PATH, undefined);
  assert.ok(stock.env.DYLD_FALLBACK_LIBRARY_PATH.split(path.delimiter).map(canonical).includes(canonical(frameworks)));
});
