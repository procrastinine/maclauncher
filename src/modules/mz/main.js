const manifest = require("./manifest.json");
const { buildRpgmakerModule } = require("../shared/mvmz/rpgmaker-module");

module.exports = buildRpgmakerModule({
  manifest,
  engineId: "mz",
  saveExtension: "rmmzsave",
  smokeTest: {
    script: `StorageManager.saveZip(\"maclauncher_smoke\", \"hello\").then(() => true);`,
    expectedFiles: ["maclauncher_smoke.rmmzsave"]
  }
});
