const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");
const defaults = require("./manifest.json").runtime.entries.playcover.settings.defaults;
const DEVICES = ["iPad13,8", "iPad8,6", "iPad14,5", "iPhone14,3"];
function normalize(value = {}) {
  const settings = { ...defaults, ...value };
  for (const key of ["keymapping", "pauseKeymappingOnTextInput", "scrollWheel"])
    if (typeof settings[key] !== "boolean") throw new Error("Invalid PlayCover input setting.");
  for (const [key, minimum, maximum] of [["mouseSensitivity", 1, 1000], ["windowWidth", 320, 7680], ["windowHeight", 240, 4320]])
    if (!Number.isInteger(settings[key]) || settings[key] < minimum || settings[key] > maximum)
      throw new Error(`${key === "mouseSensitivity" ? "Mouse sensitivity" : key === "windowWidth" ? "Window width" : "Window height"} must be a whole number from ${minimum} to ${maximum}.`);
  if (!["native", "fixed", "resizable"].includes(settings.windowMode)) throw new Error("Choose a supported PlayCover window mode.");
  if (!DEVICES.includes(settings.deviceModel)) throw new Error("Choose a supported iOS device model.");
  return settings;
}
function playToolsSettings(value) {
  const settings = normalize(value);
  // PlayTools uses synthesized Codable decoding. Include its complete property
  // set so a missing unrelated key cannot silently reset the selected options.
  return {
    keymapping: settings.keymapping, sensitivity: settings.mouseSensitivity,
    disableTimeout: false, iosDeviceModel: settings.deviceModel,
    windowWidth: settings.windowWidth, windowHeight: settings.windowHeight,
    customScaler: 2, resolution: { native: 0, fixed: 2, resizable: 6 }[settings.windowMode],
    aspectRatio: 1, displayRotation: 0, notch: false, bypass: false,
    discordActivity: { enable: false, applicationID: "", details: "", state: "", image: "" },
    version: "2.0.0", playChain: false, playChainDebugging: false,
    inverseScreenValues: false, windowFixMethod: 0, rootWorkDir: true,
    noKMOnInput: settings.pauseKeymappingOnTextInput, enableScrollWheel: settings.scrollWheel,
    hideTitleBar: false, floatingWindow: false, checkMicPermissionSync: false,
    limitMotionUpdateFrequency: false, disableBuiltinMouse: false,
    resizableAspectRatioType: 0, resizableAspectRatioWidth: 0, resizableAspectRatioHeight: 0,
    blockSleepSpamming: false, ignoreUnityKeyboardInitializationError: false
  };
}
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
function plist(value) {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<${Number.isInteger(value) ? "integer" : "real"}>${value}</${Number.isInteger(value) ? "integer" : "real"}>`;
  if (typeof value === "string") return `<string>${escape(value)}</string>`;
  return "<dict>" + Object.entries(value).map(([key, item]) => `<key>${escape(key)}</key>${plist(item)}`).join("") + "</dict>";
}
function writeSettings({ root, bundleId, settings }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(bundleId || "") || bundleId.includes("..")) throw new Error("Invalid iOS application identifier.");
  const directory = path.join(root, "data/home/Library/Containers/io.playcover.PlayCover/App Settings");
  Writable.assertOwnDirectory(root, directory);
  const file = path.join(directory, bundleId + ".plist");
  const contents = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' + plist(playToolsSettings(settings)) + "</plist>\n";
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(contents) || fs.readFileSync(file, "utf8") !== contents)
    Writable.atomicWrite(file, contents, { root });
  return file;
}
module.exports = { normalize, playToolsSettings, writeSettings };
