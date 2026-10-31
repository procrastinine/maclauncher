// A downloadable runtime manager has no option that names a version. Test rows
// reach it the way a publisher's rows do: through discovery, then one refresh
// that lists them.
const { createPinnedNativeManager } = require("../../src/modules/shared/runtime/pinned-native-manager");

async function listedManager(options, rows, userDataDir) {
  const manager = createPinnedNativeManager({ ...options, discoverCatalog: async () => rows });
  await manager.refreshCatalog({ userDataDir, force: true });
  return manager;
}

module.exports = { listedManager };
