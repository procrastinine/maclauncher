const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Requirements = require("../src/modules/shared/runtime/feature-requirements");
const Host = require("../src/modules/shared/runtime/host-capabilities");
const Launch = require("../src/core/launch-capability");
const Hardware = require("../src/modules/shared/reshade/hardware-support");
const Neural = require("../src/modules/shared/reshade/neural");
const generator = import("../scripts/generate-system-requirements.mjs");

test("committed requirements match public capability and included-package declarations", async () => {
  const {documentFile, checkSystemRequirements} = await generator;
  checkSystemRequirements(fs.readFileSync(documentFile, "utf8"));
});

test("requirements detect changed API floors, package minima and processor builds", async () => {
  const {documentFile, checkSystemRequirements, generateSystemRequirements} = await generator;
  const text = fs.readFileSync(documentFile, "utf8");
  const requirements = {...Requirements, METAL4: {...Requirements.METAL4, minimumMacOS: "28.1"}};
  assert.throws(() => checkSystemRequirements(text, {requirements}), /differ from their source/);
  assert.match(generateSystemRequirements(text, {requirements}), /\| Metal 4 \| 28\.1 \|/);
  const packages = structuredClone(require("../src/modules/shared/runtime/included-package-metadata").declarations(require("../src/modules/shared/reshade/distribution-supplementals.json")));
  const row = packages[0].files.find(row => row.path === "libreshade-macos.dylib");
  row.minimumMacOS = "28.2";
  row.architectures = ["arm64"];
  assert.throws(() => checkSystemRequirements(text, {packages}), /differ from their source/);
  assert.match(generateSystemRequirements(text, {packages}), /\| Shared graphics effects \| [^|]+ \| Apple Silicon \| 28\.2 \|/);
  assert.throws(() => checkSystemRequirements(text, {appMinimum: "28.3"}), /differ from their source/);
});

test("generation preserves surrounding prose and the website's table markers", async () => {
  const {documentFile, checkSystemRequirements, generateSystemRequirements} = await generator;
  const text = fs.readFileSync(documentFile, "utf8"), prefix = "An unrelated paragraph.\n\n";
  assert.equal(generateSystemRequirements(prefix + text), prefix + text);
  const drift = text.replace("| Metal 4 |", "| Stale feature name |");
  assert.throws(() => checkSystemRequirements(drift), /differ from their source/);
  assert.equal(generateSystemRequirements(drift), text);
  for (const marker of ["platform-requirements", "selected-graphics-requirements"]) {
    assert.throws(() => generateSystemRequirements(text.replace(`<!-- ${marker}:end -->`, "")), /boundary/);
    assert.throws(() => generateSystemRequirements(text + `<!-- ${marker}:start -->`), /boundary/);
  }
});

test("documented API requirements agree with the host, MetalFX and neural gates", () => {
  for (const macOSVersion of ["13.0", "14.0", "15.0", "26.0", "27.0"])
    for (const [launcherArch, hardwareArch] of [["arm64", "arm64"], ["x64", "x64"], ["x64", "arm64"]]) {
      const host = {platform: "darwin", launcherArch, hardwareArch, macOSVersion, rosettaAvailable: true};
      assert.equal(Host.getHostCapabilities(host).metal.metal4Eligible,
        Requirements.requirementSupport(Requirements.METAL4, host).supported === true);
      for (const [name, requirement] of Object.entries(Requirements.METALFX)) {
        const expected = Requirements.requirementSupport(requirement, host);
        assert.equal(Hardware.operationReason({state: "unknown"}, name, {macOSVersion}),
          expected.supported === false ? expected.reason : null);
      }
      assert.equal(Neural.hostSupported({platform: "darwin", hostArchitecture: hardwareArch, macOSVersion}),
        Requirements.requirementSupport(Requirements.NEURAL, host).supported === true);
      assert.equal(Hardware.metalFX27InputsReason({metalFX27InputsAPI: 1}, {platform: "darwin", macOSVersion}),
        Requirements.requirementSupport(Requirements.METALFX_EXTRA_INPUTS, host).reason);
    }
});

test("documented processor behavior agrees with shared execution and launch gates", async () => {
  const {documentFile} = await generator, text = fs.readFileSync(documentFile, "utf8");
  assert.match(text, /Apple Silicon Macs execute ARM64 code directly and Intel code through/);
  assert.match(text, /Intel Macs execute Intel code/);
  assert.match(text, /By default, each app selects the processor build that matches its own/);
  // Use the actual included iOS helper declarations, without loading a game,
  // reading installed resources or starting any native helper.
  const mod = {distributionSupplementals: require("../src/modules/shared/runtime/included-package-metadata").declarations(require("../src/modules/ios/distribution-supplementals.json"))};
  const info = {runtime: {supported: ["playcover"], entries: {playcover: {}}}};
  for (const launcherArch of ["arm64", "x64"]) {
    const host = Host.getHostCapabilities({platform: "darwin", launcherArch, hardwareArch: launcherArch,
      macOSVersion: "27.0", rosettaAvailable: false});
    assert.equal(host.launcherArch, launcherArch);
    assert.equal(Host.architectureSupport("arm64", host).supported, launcherArch === "arm64");
    assert.equal(Host.architectureSupport("x64", host).supported, true);
    assert.equal(Host.architectureSupport("x64", host).installRosetta, launcherArch === "arm64");
    assert.equal(Launch.hostRequirement(mod, launcherArch) === null, launcherArch === "arm64");
    assert.equal(Launch.canLaunchEntry({mod, info, entry: {}, runtimeId: "playcover", context: {arch: launcherArch}}),
      launcherArch === "arm64");
  }
  const translated = Host.getHostCapabilities({platform: "darwin", launcherArch: "x64", hardwareArch: "arm64",
    macOSVersion: "27.0", rosettaAvailable: true});
  assert.equal(translated.launcherArch, "x64");
  assert.equal(Host.architectureSupport("arm64", translated).supported, true);
  assert.equal(Host.architectureSupport("x64", translated).installRosetta, false);
});
