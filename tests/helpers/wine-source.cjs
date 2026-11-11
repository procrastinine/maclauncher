// The shared Wine provider and launch, bound to one Wine source descriptor.
const Sources = require("../../src/modules/crossover/sources");
const WineProvider = require("../../src/modules/crossover/sources/provider");
const WineLaunch = require("../../src/modules/crossover/sources/wine-launch");
function provider(id) {
  const source = Sources.get(id), createProvider = (options = {}) => WineProvider.createProvider({ source, ...options });
  return { ...createProvider(), createProvider, createLog: WineProvider.createLog };
}
const launch = id => WineLaunch.forSource(id);
module.exports = { provider, launch, source: Sources.get };
