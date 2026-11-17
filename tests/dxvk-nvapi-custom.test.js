// Required first: it replaces the network functions before modules load.
require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Custom = require("../src/modules/shared/runtime/custom-runtime");
const DLSS = require("../src/modules/crossover/temporal/vulkan-dlss");
const { runRuntimeManagerAction } = require("../src/core/runtime-manager-service");

// A PE image with one code section and the named exports pointing into it.
function pe(exports = ["nvapi_QueryInterface"], { machine = 0x8664 } = {}) {
  const bytes = Buffer.alloc(4096), offset = 0x80, optional = offset + 24, section = optional + 240;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(offset, 60); bytes.writeUInt32LE(0x4550, offset); bytes.writeUInt16LE(machine, offset + 4);
  bytes.writeUInt16LE(1, offset + 6); bytes.writeUInt16LE(240, offset + 20); bytes.writeUInt16LE(0x2022, offset + 22);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108); bytes.writeUInt32LE(0x1000, optional + 112); bytes.writeUInt32LE(0x400, optional + 116);
  bytes.write(".text", section); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(3584, section + 16); bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x60000020, section + 36);
  bytes.writeUInt32LE(1, 0x210); bytes.writeUInt32LE(exports.length, 0x214); bytes.writeUInt32LE(exports.length, 0x218);
  bytes.writeUInt32LE(0x1050, 0x21c); bytes.writeUInt32LE(0x1090, 0x220); bytes.writeUInt32LE(0x10d0, 0x224);
  let cursor = 0x300;
  exports.forEach((name, i) => { bytes.writeUInt32LE(0x1800 + i, 0x250 + 4 * i); bytes.writeUInt32LE(cursor + 0xe00, 0x290 + 4 * i); bytes.writeUInt16LE(i, 0x2d0 + 2 * i); bytes.write(name, cursor); cursor += name.length + 1; });
  return bytes;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function register(manager, userDataDir, runtimePath) {
  return runRuntimeManagerAction({ manager, action: "registerCustom", payload: { sectionId: "default", runtimePath }, userDataDir,
    readSettings: () => ({}), saveSettings: () => {} });
}

test("a DXVK-NVAPI library or folder the user selects is registered after the same x64 entry-point check as a download, and Play uses it", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nvapi-custom-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), [manager] = DLSS.createManagers();
  Custom.instrumentManagers([manager]);
  assert.ok(manager.getState({ userDataDir }).sections.every(section => section.customRuntime), "Runtimes offers Register custom…");
  const release = path.join(root, "dxvk-nvapi-v0.9.1");
  write(path.join(release, "x32", "nvapi.dll"), pe(["nvapi_QueryInterface"], { machine: 0x14c }));
  const library = write(path.join(release, "x64", "nvapi64.dll"), pe());
  const folder = await register(manager, userDataDir, release);
  assert.equal(folder.executablePath, library, "a folder names its unique x64 library");
  assert.deepEqual(folder.architectures, ["x86_64"]);
  await assert.rejects(register(manager, userDataDir, write(path.join(root, "other", "nvapi64.dll"), pe(["NvAPI_Initialize"]))), /no NVAPI entry point/);
  await assert.rejects(register(manager, userDataDir, write(path.join(root, "x86", "nvapi64.dll"), pe(["nvapi_QueryInterface"], { machine: 0x14c }))), /x64 Windows library/);
  await assert.rejects(register(manager, userDataDir, path.join(root, "x86")), /no unique x64 library/);
  // Set as the default, the folder supplies Play's nvapi64.dll.
  const settings = { runtimes: { "dxvk-nvapi": manager.applySettingsUpdate("setDefault", { sectionId: "default", version: release }, {}) } };
  const selected = manager.resolveSelection({}, settings, userDataDir, { verification: "status" });
  assert.equal(selected.ready, true);
  assert.equal(selected.install.executablePath, library);
  const core = { id: "vkd3d-proton", resolveSelection: () => ({ ready: true, version: "1", install: { executablePath: library, root } }) };
  const inspect = () => ({ machine: 0x8664, exports: new Map(["nvapi_QueryInterface", "NVSDK_NGX_D3D11_EvaluateFeature", "NVSDK_NGX_D3D12_EvaluateFeature"].map(name => [name, { executable: true }])) });
  const dxgi = { path: path.join(root, "dxgi.dll"), machine: 0x8664, format: "pe" }, renderer = { engine: "dxvk", files: [dxgi] };
  const plan = { components: { d3d11: { used: renderer }, "vulkan-driver": { used: { engine: "kosmickrisp", files: [{ path: library, format: "macho" }] } } },
    placements: [{ description: renderer, file: dxgi, roles: ["d3d11"] }] };
  const prepared = await DLSS.prepare({}, { settings, userDataDir }, {}, plan, "x86_64", { native: [] },
    { runtimeManagers: [manager, core], hasCarrier: () => true, inspect });
  assert.equal(prepared.enabled, true);
  assert.equal(prepared.view.native.find(file => file.name === "nvapi64.dll").source, library);
});
