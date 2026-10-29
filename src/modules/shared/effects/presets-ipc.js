const Presets = require("./presets"), Plan = require("./plan"), Runtime = require("./runtime");
function register({ ipcMain, userDataDir, app, loadSettings, pickFile, changed, inventoryRevision }) {
  const entry = plan => ({ gameId: "graphics-preset-editor", effects: plan || { schema: 1, mode: "advanced", video: [] } });
  const options = () => ({ userDataDir, app, settings: loadSettings(), graphicsHost: "window", graphicsArchitecture: "arm64",
    ...(inventoryRevision ? { inventoryRevision: inventoryRevision() } : {}) });
  ipcMain.handle("launcher:listEffectsPresets", () => Presets.list(userDataDir));
  ipcMain.handle("launcher:getEffectsPresetNotices", () => Presets.notices(userDataDir));
  ipcMain.handle("launcher:saveEffectsPreset", (_event, value) => {
    const saved = Presets.save(userDataDir, value);changed?.(Presets.list(userDataDir));return saved;
  });
  ipcMain.handle("launcher:deleteEffectsPreset", (_event, id, updatedAt) => {
    const rows = Presets.remove(userDataDir, id, updatedAt);changed?.(rows);return rows;
  });
  ipcMain.handle("launcher:getEffectsPresetEditor", (_event, plan) => Runtime.info(entry(plan == null ? null : Plan.validate(plan)), options()));
  ipcMain.handle("launcher:getEffectsPresetParameters", (_event, nodeId, plan) => Runtime.describe(entry(), nodeId, plan, options()));
  ipcMain.handle("launcher:pickEffectsPresetFile", (_event, kind, expectedOperation) => expectedOperation===undefined?pickFile(kind):pickFile(kind,expectedOperation));
}
module.exports = { register };
