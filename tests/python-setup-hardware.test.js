const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const Host = require("../src/modules/shared/runtime/host-capabilities");
const Python = require("../src/modules/shared/runtime/python");

function intelProcess(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...descriptor, value: "x64" });
  t.after(() => Object.defineProperty(process, "arch", descriptor));
}
function capabilities(hardwareArch) {
  return Host.getHostCapabilities({ platform: "darwin", launcherArch: "x64", hardwareArch,
    macOSVersion: "27.0", rosettaAvailable: hardwareArch === "arm64" });
}

test("Python setup admits an ARM build from an Intel process on Apple Silicon without changing its default publisher CPU", async t => {
  const { main } = await import("../scripts/setup-python-runtime.mjs");
  const translated = capabilities("arm64"), reachedPreparation = new Error("Reached preparation without writing or downloading");
  intelProcess(t);
  const host = t.mock.method(Host, "getHostCapabilities", () => translated);
  t.mock.method(fs, "mkdtempSync", () => { throw reachedPreparation; });
  await assert.rejects(main(["--arch", "arm64"]), error => error === reachedPreparation);
  assert.equal(host.mock.callCount(), 1, "The shared hardware capability owns the execution check");
  assert.equal(Python.embeddedPythonProfile().architecture, "x86_64", "Default publisher selection remains the process CPU");
  assert.equal(Python.embeddedPythonProfile("arm64").architecture, "arm64");
});

test("Python setup refuses an ARM build on an Intel Mac before filesystem or download preparation", async t => {
  const { main } = await import("../scripts/setup-python-runtime.mjs");
  const intel = capabilities("x64");
  intelProcess(t);
  t.mock.method(Host, "getHostCapabilities", () => intel);
  t.mock.method(fs, "mkdtempSync", () => assert.fail("Wrong-CPU preparation must not start"));
  await assert.rejects(main(["--arch", "arm64"]), /Apple Silicon Python build installs on an Apple Silicon Mac/);
});

test("Python setup keeps native Intel and Apple Silicon preparation and the macOS requirement", async () => {
  const { assertPythonBuildHost } = await import("../scripts/setup-python-runtime.mjs");
  assert.doesNotThrow(() => assertPythonBuildHost("x64", capabilities("x64")));
  assert.doesNotThrow(() => assertPythonBuildHost("arm64", capabilities("arm64")));
  assert.throws(() => assertPythonBuildHost("x64", { platform: "linux", hardwareArch: "x64" }), /Apple Silicon/);
});
