// NScripter downloads without a Runtimes row; see core/component-service.js.
module.exports = [
  require("../shared/runtime/pinned-file").component(require("./font").asset, { users: ["ONScripter-Yuri", "ONScripter-EN"],
    description: "The fallback Japanese font for NScripter games that ship no default.ttf and have no font set in settings." })
];
