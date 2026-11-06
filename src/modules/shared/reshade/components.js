const path = require("node:path");

// Graphics caches without a Runtimes row; see core/component-service.js.
module.exports = [
  require("../runtime/runtime-components").cacheComponent({
    id: "graphics-model-archives",
    label: "Neural model source archives",
    description: "Publisher archives kept after a neural model was extracted from them, so another model from the same archive needs no second download.",
    location: ({ userDataDir }) => path.join(userDataDir, "runtimes", "graphics-neural-models", ".source-archives"),
    users: ["Neural model installations"]
  })
];
