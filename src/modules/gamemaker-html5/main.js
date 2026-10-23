const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const NwjsLauncher = require("../shared/web/runtime/nwjs-launcher");
const NwjsManager = require("../shared/web/runtime/nwjs-manager");

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId !== "nwjs") return null;
  return NwjsLauncher.launchRuntime({ entry, moduleId: manifest.id, userDataDir: context.userDataDir,
    settings: context.settings, context, runtimeSettings: context.runtimeSettings, supportsCheats: false,
    toolsButtonVisible: false, logger: context.logger, onRuntimeStateChange: context.onRuntimeStateChange });
}
module.exports = { ...require("../shared/web/metadata"), id: manifest.id, manifest, detectGame, launchRuntime,
  getRuntimeRequirements: NwjsLauncher.getRuntimeRequirements, runtimeManagers: [NwjsManager] };
