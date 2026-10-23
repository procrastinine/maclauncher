const { mergeSettingsChanges } = require("./settings-merge");

const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

// A host may hold settings while a dialog or worker runs. Implicit defaults are
// not edits; normalize fresh state and apply only changes made to its snapshot.
function createSettingsSnapshots({ readSettings, normalize = value => value, commitSettings }) {
  const snapshots = new WeakMap();
  const read = () => {
    const value = readSettings();
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
      const raw = read();
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
