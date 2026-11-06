const test = require("node:test");
const assert = require("node:assert/strict");

test("both installed CPU builds of one managed KosmicKrisp version give a consumer one choice", () => {
  const Managed = require("../src/modules/shared/vulkan/managed");
  const requests = [];
  const install = { payloadRoot: "/fixture", executablePath: "/fixture/libvulkan_kosmickrisp.dylib",
    manifest: { minimumMacOS: "26.0", runtimeFiles: { loader: "libvulkan.1.dylib" }, files: [] } };
  const provider = Managed.createProvider({ id: "maclauncher-kosmickrisp", label: "MacLauncher KosmicKrisp",
    getState: () => ({ defaultVersion: "2", installed: [{ version: "1", architecture: "arm64" }, { version: "2", architecture: "arm64" },
      { version: "1", architecture: "x64" }, { version: "2", architecture: "x64" }] }),
    resolveSelection: (_entry, _settings, _data, options) => { requests.push(options.version); return { ready: true, version: options.version, install }; } });
  assert.deepEqual(provider.installed({ userDataDir: "/fixture", settings: {} }).map(row => row.version), ["2", "1"]);
  assert.deepEqual(requests, ["2", "1"]);
});
