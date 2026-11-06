// KiriKiri downloads without a Runtimes row; see core/component-service.js.
module.exports = [
  require("../shared/runtime/pinned-file").component(require("./font").asset, { users: ["KiriKiri SDL2"],
    description: "The fallback font that KAG3 scripts use under KiriKiri SDL2 when a game ships none." })
];
