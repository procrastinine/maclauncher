const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Bundled = require("../../runtime/bundled-native");
const Included = require("../../runtime/included-helpers");
const Isolation = require("../../runtime/network-isolation");
const run = promisify(execFile);
const ID = "web-renderer-network";
const declarations = () => require("../distribution-supplementals.json");

// The trusted browser broker stays outside this profile: Chromium applies its
// own GPU/network-service profiles. Publisher Node code executes in a renderer
// which installs this process-wide policy before reading any game code.
async function resolveRendererNetwork({ resourcesRoot, platform = process.platform, arch = process.arch,
  dependencies = {} } = {}) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch))
    throw new Error("Browser game network isolation requires macOS on Apple Silicon or Intel.");
  const pin = declarations().find(item => item.id === ID);
  if (!pin) throw new Error("The included browser network helper is unavailable. Reinstall MacLauncher.");
  const directory = Included.resolveIncluded(declarations(), { id: pin.id, version: pin.version, arch, resourcesRoot })?.directory;
  if (!directory) throw new Error("The included browser network helper is missing. Reinstall MacLauncher.");
  Bundled.verifyPayload(directory, pin);
  const record = JSON.parse(Bundled.readRegular(path.join(directory, pin.manifestRelative), Bundled.LIMITS.manifestBytes).bytes);
  const binary = pin.files.find(file => file.path === "renderer-network.node");
  if (!binary || record.schemaVersion !== 1 || record.id !== ID || record.version !== pin.version ||
      record.sourceSha256 !== pin.sourceSha256 || record.binarySha256 !== binary.sha256 ||
      record.scope !== "node-capable-game-renderer-network" || record.nodeAPI !== 1)
    throw new Error("The browser network helper build identity changed.");
  const libraryPath = path.join(directory, binary.path);
  await (dependencies.verifySignature || (file => run("/usr/bin/codesign", ["--verify", "--strict", file],
    { timeout: 30000, maxBuffer: 1024 * 1024 })))(libraryPath);
  return { libraryPath, version: pin.version };
}

function rendererArguments(helper, port) {
  if (!helper?.libraryPath || !path.isAbsolute(helper.libraryPath)) throw new Error("The browser network helper is unavailable.");
  return [`--maclauncher-network-helper=${encodeURIComponent(helper.libraryPath)}`,
    `--maclauncher-network-profile=${Buffer.from(Isolation.profile({ assetPort: port }), "utf8").toString("base64")}`];
}

module.exports = { resolveRendererNetwork, rendererArguments };
