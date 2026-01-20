function install() {
  try {
    const Shim = require("./webview2-shim");
    if (typeof Shim?.install === "function") Shim.install(globalThis);
  } catch {}
}

module.exports = {
  install
};
