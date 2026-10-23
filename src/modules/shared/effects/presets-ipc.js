const Presets = require("./presets"), Plan = require("./plan"), Runtime = require("./runtime");
function register({ ipcMain, userDataDir, app, loadSettings, pickFile }) {
  const entry = plan => ({ gameId: "graphics-preset-editor", effects: plan || { schema: 1, mode: "advanced", video: [] } });
  const options = () => ({ userDataDir, app, settings: loadSettings(), graphicsHost: "window", graphicsArchitecture: "arm64" });
  ipcMain.handle("launcher:listEffectsPresets", () => Presets.list(userDataDir));
  ipcMain.handle("launcher:saveEffectsPreset", (_event, value) => Presets.save(userDataDir, value));
  ipcMain.handle("launcher:deleteEffectsPreset", (_event, id, updatedAt) => Presets.remove(userDataDir, id, updatedAt));
  ipcMain.handle("launcher:getEffectsPresetEditor", (_event, plan) => Runtime.info(entry(plan == null ? null : Plan.validate(plan)), options()));
  ipcMain.handle("launcher:getEffectsPresetParameters", (_event, nodeId, plan) => Runtime.describe(entry(), nodeId, plan, options()));
  ipcMain.handle("launcher:pickEffectsPresetFile", (_event, kind) => pickFile(kind));
}
module.exports = { register };
