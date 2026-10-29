const manifest = require("./manifest.json");
const manager = require("./runtime/manager");
const { createProvider } = require("./provider");

module.exports = { id: manifest.id, manifest, detectGame: () => null,
  runtimeManagers: [manager], runtimeProvider: createProvider({ manager }) };

module.exports = require("../shared/decompilation/native").withTools(module.exports);
