const manifest = require("./manifest.json");
const { buildRpgmakerModule } = require("../shared/mvmz/rpgmaker-module");
const LibCatalog = require("./libs/catalog");
const LibPatcher = require("./libs/patcher");

module.exports = buildRpgmakerModule({
  manifest,
  engineId: "mv",
  saveExtension: "rpgsave",
  smokeTest: {
    script: `StorageManager.save(0, JSON.stringify([{ __maclauncher: true, t: Date.now() }]));`,
    expectedFiles: ["global.rpgsave"]
  },
  libs: {
    catalog: LibCatalog,
    patcher: LibPatcher
  }
});
