const { prepareBrowserGlobals, setupNwjsCompatibility } = require("../shared/web/preload/nwjs-compat");

function install(context = {}) {
  prepareBrowserGlobals();
  require("./userenv-shim").install(globalThis);
  const config = context.config || {};
  const saveDir = config.saveDir || (config.gameDataDir && require("node:path").join(config.gameDataDir, "modules", "tyrano", "saves"));
  require("./file-storage").install(globalThis, saveDir);
}

module.exports = { setup: setupNwjsCompatibility, install };
