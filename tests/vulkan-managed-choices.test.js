const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

test("both installed CPU builds of one managed KosmicKrisp version give a consumer one choice", t => {
  const Managed = require("../src/modules/shared/vulkan/managed"), MachO = require("./fixtures/macho-image");
  const payloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vulkan-managed-choices-"));
  t.after(() => fs.rmSync(payloadRoot, { recursive: true, force: true }));
  for (const name of ["libvulkan_kosmickrisp.dylib", "libvulkan.1.dylib"]) fs.writeFileSync(path.join(payloadRoot, name), MachO.image({ cpu: MachO.ARM64 }));
  const requests = [];
  const install = { payloadRoot, executablePath: path.join(payloadRoot, "libvulkan_kosmickrisp.dylib"),
    manifest: { minimumMacOS: "26.0", runtimeFiles: { loader: "libvulkan.1.dylib" }, files: [] } };
  const provider = Managed.createProvider({ id: "maclauncher-kosmickrisp", label: "MacLauncher KosmicKrisp",
    getState: () => ({ defaultVersion: "2", installed: [{ version: "1", architecture: "arm64" }, { version: "2", architecture: "arm64" },
      { version: "1", architecture: "x64" }, { version: "2", architecture: "x64" }] }),
    resolveSelection: (_entry, _settings, _data, options) => { requests.push(options.version); return { ready: true, version: options.version, install }; } });
  assert.deepEqual(provider.installed({ userDataDir: payloadRoot, settings: {} }).map(row => row.version), ["2", "1"]);
  assert.deepEqual(requests, ["2", "1"]);
});
