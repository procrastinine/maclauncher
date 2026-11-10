const { createPublisherAppManager } = require("../../shared/runtime/publisher-app");
const Catalog = require("./catalog");

function createManager(dependencies = {}) {
  return createPublisherAppManager({ id: "raze", label: "Raze", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source, appName: /^raze.*\.app$/i, dependencies });
}

module.exports = createManager();
module.exports.createManager = createManager;
