const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const NwjsLauncher = require("../shared/web/runtime/nwjs-launcher");
const NwjsPatchedLauncher = require("../shared/web/runtime/nwjs-patched-launcher");
const NwjsRuntimeManager = require("../shared/web/runtime/nwjs-manager");

async function launchRuntime(runtimeId, entry, context) {
  if (runtimeId === "nwjs") {
    const runtimeSettings =
      context?.runtimeSettings && typeof context.runtimeSettings === "object"
        ? context.runtimeSettings
        : null;
    return NwjsLauncher.launchRuntime({
      entry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  if (runtimeId === "nwjs-patched") {
    const runtimeSettings =
      context?.runtimeSettings && typeof context.runtimeSettings === "object"
        ? context.runtimeSettings
        : null;
    return NwjsPatchedLauncher.launchRuntime({
      entry,
      moduleId: manifest.id,
      userDataDir: context.userDataDir,
      settings: context.settings,
      toolsButtonVisible: context.toolsButtonVisible,
      runtimeSettings,
      cheatsFilePath: context.cheatsFilePath,
      supportsCheats: false,
      patchConfig: null,
      logger: context.logger,
      onRuntimeStateChange: context.onRuntimeStateChange
    });
  }

  return null;
}

module.exports = {
  id: manifest.id,
  manifest,
  detectGame,
  launchRuntime,
  runtimeManagers: [NwjsRuntimeManager]
};
