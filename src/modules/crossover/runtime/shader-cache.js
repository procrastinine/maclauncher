const path = require("node:path");
const Writable = require("../../shared/writable-input");

function environment(directory, inherited = {}) {
  const cache = path.join(directory, "cache", "mesa"), dxvk = path.join(directory, "cache", "dxvk");
  // Wine's HOME and bottle are separate from this launcher-owned runtime tree.
  // Mesa creates its cache lazily. Explicit launch values keep their budget.
  Writable.assertOwnDirectory(directory, cache, { create: false });
  Writable.assertOwnDirectory(directory, dxvk, { create: false });
  return { MESA_SHADER_CACHE_DIR: cache, MESA_SHADER_CACHE_MAX_SIZE: inherited.MESA_SHADER_CACHE_MAX_SIZE ?? "4G" };
}
function prepare(directory, prefixPath) {
  environment(directory);
  return { DXVK_SHADER_CACHE_PATH: require('../../shared/runtime/wine-game-paths').windowsDirectoryPath(
    prefixPath, directory, path.join(directory, 'cache', 'dxvk')) };
}
module.exports = { environment, prepare };
