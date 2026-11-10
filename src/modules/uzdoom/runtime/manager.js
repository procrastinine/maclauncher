const { createPublisherAppManager } = require("../../shared/runtime/publisher-app");
const Catalog = require("./catalog");

function createManager(dependencies = {}) {
  return createPublisherAppManager({ id: "uzdoom", label: "UZDoom", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source, appName: /^uzdoom.*\.app$/i, dependencies });
}

module.exports = createManager();
module.exports.createManager = createManager;
