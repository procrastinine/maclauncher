const { createPublisherAppManager } = require("../../shared/runtime/publisher-app");
const Catalog = require("./catalog");

function createManager(dependencies = {}) {
  return createPublisherAppManager({ id: "dreamm", label: "DREAMM", sourceUrl: Catalog.SOURCE_URL,
    upstream: Catalog.source, appName: /^dreamm.*\.app$/i, dependencies });
}

module.exports = createManager();
module.exports.createManager = createManager;
