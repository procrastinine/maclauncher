const manifest = require("./manifest.json");

// A running app's window or the whole display as a graphics input. The
// captured image is composed color at the window's own pixel size, so the
// declared inputs leave out source resolution and every scene input; the
// shared capability filters hide the options that need them.
const graphicsInputs = Object.freeze({ source: "window-capture", sourceResolution: false, depth: false, motionVectors: false, methods: [], generationDefaults: Object.freeze({ keepStaticContent: true }) });

module.exports = {
  id: manifest.id, manifest,
  canLaunchRuntime: runtimeId => runtimeId === "capture" && process.platform === "darwin",
  resolveGraphicsInputs: () => ({ ...graphicsInputs }),
  launchRuntime: (_runtimeId, entry, context) => require("./launch").launch(entry, context),
  runtimeSettingsChanged: (entry, runtimeId, settings) => require("./launch").runtimeSettingsChanged(entry, runtimeId, settings),
  reviewRuntimeSettings: (runtimeId, next, previous, ui) => require("./launch").reviewRuntimeSettings(runtimeId, next, previous, ui),
  actions: {
    windowRemoveTarget(entry, { id }) {
      const launch = require("./launch"), removed = launch.removeTarget(entry.gameId, id);
      entry.moduleData = launch.sessionData(entry.gameId) || entry.moduleData;return removed;
    },
    windowTogglePointer(entry) { return require("./launch").windowTogglePointer(entry); }
  },
  appActions: require("./app-actions")
};
