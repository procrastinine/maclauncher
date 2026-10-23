const { prepareBrowserGlobals, setupNwjsCompatibility } = require("../shared/web/preload/nwjs-compat");

function setup(context) {
  const settings = context.config?.manifest?.settings;
  // WebView2 bundle metadata identifies browser exports. Advertising NW.js here
  // selects Node-only runtime branches, including inside browser workers.
  if (settings && typeof settings === "object" && !Array.isArray(settings) &&
      settings["content-mode"] === "bundle" && settings["distribution-mode"] === "evergreen") {
    return {};
  }
  return setupNwjsCompatibility(context);
}

function install() {
  prepareBrowserGlobals();
  try {
    const Shim = require("./webview2-shim");
    if (typeof Shim?.install === "function") Shim.install(globalThis);
  } catch {}
}

module.exports = {
  setup,
  install
};
