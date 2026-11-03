const { prepareBrowserGlobals, setupNwjsCompatibility } = require("../shared/web/preload/nwjs-compat");

function install(context = {}) {
  prepareBrowserGlobals();
  require("./userenv-shim").install(globalThis);
  const config = context.config || {};
  const saveDir = require("./file-storage").resolveDirectory(config);
  require("./file-storage").install(globalThis, saveDir);
}

module.exports = { setup: setupNwjsCompatibility, install };
