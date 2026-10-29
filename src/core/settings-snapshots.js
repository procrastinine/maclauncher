const { mergeSettingsChanges, settingsUnreadable } = require("./settings-merge");

const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

// A host may hold settings while a dialog or worker runs. Implicit defaults are
// not edits; normalize fresh state and apply only changes made to its snapshot.
// readSettings may throw. After a read error a loaded snapshot shows defaults,
// and a save fails instead of committing them over the stored document. A
// document that is not a JSON object (SyntaxError) contributes its readable
// top-level settings (`salvaged`); the commit keeps the document's bytes.
function createSettingsSnapshots({ readSettings, normalize = value => value, commitSettings }) {
  const snapshots = new WeakMap();
  const read = ({ strict = false } = {}) => {
    let value;
    try { value = readSettings(); }
    catch (error) {
      if (error instanceof SyntaxError) value = error.salvaged;
      else if (strict) throw settingsUnreadable(error);
    }
    return isRecord(value) ? value : {};
  };
  const normalized = value => normalize(structuredClone(value));
  return {
    load() {
      const settings = normalized(read());
      snapshots.set(settings, structuredClone(settings));
      return settings;
    },
    save(settings) {
      if (!snapshots.has(settings)) throw new TypeError("Save settings from a loaded snapshot.");
      // No await between reading and committing: the shared Node host is the writer.
      const raw = read({ strict: true });
      const next = mergeSettingsChanges(snapshots.get(settings), settings, normalized(raw));
      const committed = commitSettings(raw, next);
      if (!isRecord(committed)) throw new TypeError("Settings commits must synchronously return the saved document.");
      for (const key of Object.keys(settings)) delete settings[key];
      Object.assign(settings, structuredClone(committed));
      snapshots.set(settings, structuredClone(settings));
      return settings;
    }
  };
}

module.exports = { createSettingsSnapshots };
