const { createPinnedNativeManager } = require("../../shared/runtime/pinned-native-manager");
const { locatePackaged } = require("../../shared/runtime/release-files");
const Catalog = require("./catalog");

// A release may rename its app or place it in a folder; the known name wins.
function resolveExecutable(root) {
  const app = locatePackaged(root, ["EasyRPG Player.app", /\.app$/i]);
  if (!app) throw new Error("The EasyRPG release does not contain a Mac app bundle.");
  return app;
}

function createManager(dependencies = {}) {
  return createPinnedNativeManager({ id: "easyrpg", label: "EasyRPG Player", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source, resolveExecutable, dependencies });
}

const manager = createManager();
manager.createManager = createManager;
manager.resolveExecutable = resolveExecutable;
module.exports = manager;
