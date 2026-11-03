// Released v0.5.1: optional generic writable-input schema 1 under games/<id>/modules/nitroplus.
// Called only for existing pending entries by the one-time original-game-mirrors-v1 migration.
// Delete after migration from released v0.5.1 profiles is no longer supported.
const path = require("node:path");
const Writable = require("../../shared/backcompat/writable-input");

function legacyGameMirrors(entry, context) {
    const rows = entry.moduleData?.writableInput?.schemaVersion === 1 ? Writable.legacyGameMirrors(entry, context) : [];
    const overlap = (left, right) => {
      const relative = path.relative(left, right);
      return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    };
    return rows.filter(row => !entry.saveDirOverride ||
      !overlap(row.mirrorRoot, entry.saveDirOverride) && !overlap(entry.saveDirOverride, row.mirrorRoot));
  }

module.exports = { legacyGameMirrors };
