const assert = require("node:assert/strict");
const test = require("node:test");
const { canLaunchEntry, hostRequirement } = require("../src/core/launch-capability");

const info = { supports: {}, runtime: { supported: ["runner", "inspect"], entries: { runner: {}, inspect: { launch: false } } } };
test("playback capability does not require an already installed runtime", () => {
  const entry = { moduleData: { format: "reviewed" } };
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "runner", mod: {
    canLaunchRuntime: (_id, game) => game.moduleData.format === "reviewed"
  } }), true);
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "inspect" }), false);
  assert.equal(canLaunchEntry({ info, entry, runtimeId: "missing" }), false);
});
test("module-owned host/format filtering disables unrelated entries without engine branches", () => {
  const mod = {
    filterRuntimeSupport: entry => entry.moduleData?.format === "reviewed" ? ["runner"] : [],
    canLaunchRuntime: (_id, _entry, _settings, context) => context.arch === "arm64"
  };
  const entry = { moduleData: { format: "reviewed" } };
  assert.equal(canLaunchEntry({ info, mod, entry, runtimeId: "runner", context: { arch: "arm64" } }), true);
  assert.equal(canLaunchEntry({ info, mod, entry, runtimeId: "runner", context: { arch: "x64" } }), false);
  assert.equal(canLaunchEntry({ info, mod, entry: { moduleData: { format: "other" } }, runtimeId: "runner", context: { arch: "arm64" } }), false);
  assert.equal(canLaunchEntry({ info: { ...info, supports: { launch: false } }, entry, runtimeId: "runner" }), false);
});
test("a game type whose included helpers have no build for this Mac's CPU explains the Mac it needs", () => {
  const helper = (id, launcherArchitectures) => ({ id, version: "1.0", launcherArchitectures });
  const appleSilicon = { distributionSupplementals: [helper("bridge", ["arm64", "x64"]), helper("reader", ["arm64"])] };
  const entry = { moduleData: {} };
  assert.equal(canLaunchEntry({ info, mod: appleSilicon, entry, runtimeId: "runner", context: { arch: "arm64" } }), true);
  assert.equal(canLaunchEntry({ info, mod: appleSilicon, entry, runtimeId: "runner", context: { arch: "x64" } }), false);
  assert.deepEqual(hostRequirement(appleSilicon, "x64"), { ids: ["reader"], architectures: ["arm64"], message: "Requires a Mac with Apple Silicon." });
  assert.equal(hostRequirement(appleSilicon, "arm64"), null);
  // Separate per-CPU publications of one helper cover both Macs.
  const perCpu = { distributionSupplementals: [helper("reader", ["arm64"]), { ...helper("reader", ["x64"]), version: "1.0-intel" }] };
  assert.equal(hostRequirement(perCpu, "x64"), null);
  assert.equal(hostRequirement({ distributionSupplementals: [helper("tool", ["x64"])] }, "arm64").message, "Requires an Intel Mac.");
  assert.equal(hostRequirement({}, "x64"), null);
});
test("host requirements use physical Apple Silicon when the launcher runs through Rosetta", t => {
  const Host = require("../src/modules/shared/runtime/host-capabilities");
  const translated = Host.getHostCapabilities({ platform: "darwin", launcherArch: "x64", hardwareArch: "arm64",
    macOSVersion: "26.0", rosettaAvailable: true });
  const descriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...descriptor, value: "x64" });
  t.after(() => Object.defineProperty(process, "arch", descriptor));
  let hardwareArch = translated.hardwareArch;
  t.mock.method(Host, "getHostCapabilities", () => ({ ...translated, hardwareArch }));
  const mod = { distributionSupplementals: [{ id: "reader", version: "1.0", launcherArchitectures: ["arm64"] }] };
  assert.equal(process.arch, "x64");
  assert.equal(hostRequirement(mod), null);
  assert.equal(canLaunchEntry({ mod, info, entry: {}, runtimeId: "runner" }), true);
  hardwareArch = "x64";
  assert.match(hostRequirement(mod).message, /Apple Silicon/);
  assert.equal(canLaunchEntry({ mod, info, entry: {}, runtimeId: "runner" }), false);
});
