const manifest = require("./manifest.json");
const { detectGame } = require("./detect");
const Tools = require("./tools");
module.exports = { id: manifest.id, manifest, detectGame, runtimeManagers: [], normalizeRuntimeId: () => "catsystem2-tools",
  distributionSupplementals: require("./runtime/distribution-supplementals.json"),
  ensureRuntime: async () => { throw new Error("CatSystem2 native gameplay is not supported. Archive and script tools are available in the inspector."); },
  launchRuntime: async () => { throw new Error("CatSystem2 native playback is unsupported. Archive and script tools are available in the inspector."); },
  actions: { inspectArchives: Tools.inspectArchives, inspectScripts: Tools.inspectScripts, exportScripts: Tools.exportScripts, exportArchive: Tools.exportArchive } };
