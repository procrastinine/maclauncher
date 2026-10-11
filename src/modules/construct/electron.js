const { prepareBrowserGlobals, setupNwjsCompatibility } = require("../shared/web/preload/nwjs-compat");

function install() {
  prepareBrowserGlobals();
  try {
    const Shim = require("./webview2-shim");
    if (typeof Shim?.install === "function") Shim.install(globalThis);
  } catch {}
}

module.exports = {
  setup: setupNwjsCompatibility,
  install
};
