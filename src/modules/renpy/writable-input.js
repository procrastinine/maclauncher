const path = require("node:path");
const Writable = require("../shared/writable-input");
const ProjectOverlay = require("./runtime/project-overlay");

function prepareInput(entry, context = {}) {
  if (!Writable.immutableRoot(entry)) return entry;
  const gameOnly = entry.moduleData?.gameOnly === true;
  const macProfile = relative => /^lib[\\/](?:py[23]-)?mac-[^\\/]+[\\/]/i.test(relative);
  const view = Writable.ensureView(entry, context, {
    moduleId: "renpy", policyId: gameOnly ? "renpy-game-v1" : "renpy-project-v1",
    privateFile: relative => ProjectOverlay.isPrivateFile(relative) || /\.(?:sh|rpyc?|rpyb|rpymc?|py[co]?)$/i.test(relative) || macProfile(relative),
    seedFile: relative => /^(?:saves|Ren'Py Data)[\\/]/i.test(relative),
    omitTree: relative => gameOnly && /^(?:cache|__pycache__)$/i.test(relative),
    emptyDirectories: gameOnly ? ["cache", "saves"] : ["lib", "game/cache", "game/saves"],
    overlayTree: (relative, options) => !gameOnly && relative === "game" ? ProjectOverlay.ensureGameOverlay(options) : null
  });
  Writable.rememberView(entry, view);
  return Writable.runtimeEntry(entry);
}

module.exports = { prepareInput };
