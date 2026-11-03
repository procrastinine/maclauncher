// Released v0.5.1 kept guest HOME and cwd under games/<id>/runtimes/mac32.
// Invoked only by the shared one-time existing-library migration.
// Remove with that migration once support for these released layouts ends.
const path = require("node:path");
const os = require("node:os");
const { runtimeDirectory } = require("../provider");

function legacyGameMirrors(entry, context) {
  const appPath = entry?.runtimeData?.mac32?.appPath;
  if (!path.isAbsolute(appPath || "") || !entry?.gameId) return [];
  const directory = runtimeDirectory(entry, context);
  return [
    { mirrorRoot: path.join(directory, "home"), sourceRoot: os.homedir() },
    { mirrorRoot: path.join(directory, "work"), sourceRoot: path.dirname(appPath) }
  ];
}

module.exports = { legacyGameMirrors };
