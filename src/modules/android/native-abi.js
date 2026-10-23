const path = require("node:path");
const ARM64 = "arm64-v8a", ARM32 = ["armeabi-v7a", "armeabi"];
function supported(profile = {}) { return profile.arm32Version === 1 ? [ARM64, ...ARM32] : [ARM64]; }
function select(architectures, profile = {}) {
  const values = Array.isArray(architectures) ? architectures : [];
  return supported(profile).find(abi => !values.length || values.includes(abi)) || null;
}
function fromDirectory(directory) {
  const leaf = path.basename(directory || "");
  return ARM32.includes(leaf) ? leaf : ARM64;
}
function installedProfile(entry, context) {
  try { return require("./runtime").resolveSelected(entry, context)?.profile || {}; }
  catch { return {}; }
}
module.exports = { ARM64, ARM32, supported, select, fromDirectory, installedProfile };
