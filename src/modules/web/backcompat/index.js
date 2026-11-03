// Backcompat: MacLauncher 0.5.1 schema-1 Web writable-input records.
// Runs once for existing games through the persisted profile migration.
// Delete when upgrades from this released layout are no longer supported.
const Writable = require("../../shared/backcompat/writable-input");
module.exports = { legacyGameMirrors: (entry, context) =>
  entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, context) : [] };
