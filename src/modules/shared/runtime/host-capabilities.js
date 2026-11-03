const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {METAL4, requirementSupport, versionAtLeast, normalizeArchitecture} = require("./feature-requirements");

const SYSTEM_VERSION = "/System/Library/CoreServices/SystemVersion.plist";
let hardwareArchitecture, systemVersion;

// Launcher defaults follow its process CPU, including an Intel launcher under Rosetta.
function defaultArchitecture() { return process.arch; }
function readHardwareArchitecture(platform, launcherArch, execute) {
  if (platform !== "darwin" || launcherArch !== "x64") return launcherArch;
  try {
    return execute("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
      encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"]
    }).trim() === "1" ? "arm64" : "x64";
  } catch { return launcherArch; }
}
function readSystemVersion(fileSystem, execute) {
  try {
    const bytes = fileSystem.readFileSync(SYSTEM_VERSION);
    if (bytes.length <= 65536) {
      const version = bytes.toString("utf8").match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      if (version) return version.trim();
    }
  } catch {}
  try { return execute("/usr/bin/sw_vers", ["-productVersion"], {encoding: "utf8", timeout: 3000}).trim(); }
  catch { return null; }
}

// Process architecture chooses downloads. Physical hardware decides whether a
// selected build can execute and which optional GPU providers can be used.
// Reading status is local; it never installs Rosetta or starts a GPU helper.
function getHostCapabilities(options = {}) {
  const platform = options.platform || process.platform;
  const launcherArch = normalizeArchitecture(options.launcherArch || defaultArchitecture());
  const execute = options.execFileSync || execFileSync, fileSystem = options.fileSystem || fs;
  const native = !options.platform && !options.launcherArch && !options.execFileSync && !options.fileSystem;
  let hardwareArch = normalizeArchitecture(options.hardwareArch);
  if (!hardwareArch) {
    if (native && hardwareArchitecture) hardwareArch = hardwareArchitecture;
    else {
      hardwareArch = readHardwareArchitecture(platform, launcherArch, execute);
      if (native) hardwareArchitecture = hardwareArch;
    }
  }
  const macOSVersion = options.macOSVersion || (platform === "darwin" ?
    native && systemVersion || readSystemVersion(fileSystem, execute) : null);
  if (native && macOSVersion) systemVersion = macOSVersion;
  const translated = platform === "darwin" && launcherArch === "x64" && hardwareArch === "arm64";
  let rosettaAvailable = options.rosettaAvailable;
  if (rosettaAvailable === undefined) {
    rosettaAvailable = translated;
    if (!rosettaAvailable && platform === "darwin" && hardwareArch === "arm64") {
      // The Rosetta service owns its runtime location, prompt and installation.
      try { rosettaAvailable = fileSystem.statSync(require("./rosetta").RUNTIME_PATH).isFile(); } catch {}
    }
  }
  const metal = options.metal || {state: "unknown"};
  const metal4Eligible = requirementSupport(METAL4, {platform, hardwareArch, macOSVersion}).supported === true;
  const devices = metal.state === "ready" ? metal.devices || [] : [];
  const metal4Supported = !metal4Eligible ? false : metal.state === "ready" ?
    devices.some(device => Object.values(device.metalfx || {}).some(operation => operation.metal4Supported === true)) : null;
  return {platform, launcherArch, hardwareArch, macOSVersion, translated,
    rosettaAvailable: Boolean(rosettaAvailable), metal: {...metal, metal4Eligible, metal4Supported}};
}

function architectureSupport(architecture, host = getHostCapabilities()) {
  const arch = normalizeArchitecture(architecture);
  if (arch === "universal" || arch === "any" || arch === host.hardwareArch)
    return {supported: true, installRosetta: false, reason: null};
  if (host.platform === "darwin" && host.hardwareArch === "arm64" && arch === "x64")
    return {supported: true, installRosetta: !host.rosettaAvailable, reason: null};
  return {supported: false, installRosetta: false,
    reason: arch === "arm64" ? "Requires a Mac with Apple Silicon." : arch === "x64" ? "Requires an Intel Mac or Rosetta on Apple Silicon." : "Unsupported runtime architecture."};
}

module.exports = {getHostCapabilities, architectureSupport, defaultArchitecture, versionAtLeast};
