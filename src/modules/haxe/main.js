const manifest = require("./manifest.json");
const { detectGame, UNSUPPORTED } = require("./detect");

module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [],
  normalizeRuntimeId: () => "inspection", canLaunchRuntime: () => false,
  ensureRuntime: async () => { throw new Error(UNSUPPORTED); },
  launchRuntime: async () => { throw new Error(UNSUPPORTED); } };
