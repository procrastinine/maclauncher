const test = require("node:test"), assert = require("node:assert/strict");
const Requirements = require("../src/modules/shared/runtime/feature-requirements");

test("requirements use physical hardware and preserve unknown capability measurements", () => {
  assert.deepEqual(Requirements.requirementSupport(Requirements.METAL4,
    {platform: "darwin", hardwareArch: "arm64", launcherArch: "x64", macOSVersion: "26.0"}), {supported: true, reason: null});
  assert.equal(Requirements.requirementSupport(Requirements.METAL4,
    {platform: "darwin", hardwareArch: "x64", macOSVersion: "27.0"}).supported, false);
  assert.deepEqual(Requirements.requirementSupport(Requirements.METALFX.temporal, {platform: "darwin"}), {supported: null, reason: null});
  assert.equal(Requirements.requirementSupport({minimumMacOS: "33.1"}, {macOSVersion: "33.0"}).supported, false);
  assert.equal(Requirements.requirementSupport({minimumMacOS: "33.1"}, {macOSVersion: "33.1.4"}).supported, true);
});

test("in-process requirements are independent of physical CPU and accept architecture aliases", () => {
  const nativeLibrary = {executionArchitectures: ["arm64", "x86_64"], minimumMacOS: "13.0"};
  assert.equal(Requirements.requirementSupport(nativeLibrary,
    {hardwareArch: "arm64", executionArch: "x64", macOSVersion: "13.0"}).supported, true);
  assert.equal(Requirements.requirementSupport({executionArchitectures: ["arm64"]},
    {hardwareArch: "arm64", executionArch: "x64"}).supported, false);
  assert.deepEqual(Requirements.requirementSupport(nativeLibrary, {hardwareArch: "arm64", macOSVersion: "27.0"}),
    {supported: null, reason: null});
  assert.equal(Requirements.requirementSupport({executionArchitectures: ["x64"]}, {executionArch: "amd64"}).supported, true);
});
