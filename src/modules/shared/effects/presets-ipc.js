const Presets = require("./presets"), Plan = require("./plan"), Runtime = require("./runtime");
// `inspector(method, ...args)`, when given, runs the editor's discovery and
// parameter reads in the inspector's backend worker with data options; they
// read runtime inventories and verify the included graphics runtime's files.
function register({ ipcMain, userDataDir, app, loadSettings, pickFile, changed, inventoryRevision, inspector }) {
  const entry = plan => ({ gameId: "graphics-preset-editor", effects: plan || { schema: 1, mode: "advanced", video: [] } });
  const data = () => ({ settings: loadSettings(), graphicsHost: "window", graphicsArchitecture: "arm64",
    ...(inventoryRevision ? { inventoryRevision: inventoryRevision() } : {}) });
  const options = () => ({ userDataDir, app, ...data() });
  ipcMain.handle("launcher:listEffectsPresets", () => Presets.list(userDataDir));
  ipcMain.handle("launcher:getEffectsPresetNotices", () => Presets.notices(userDataDir));
  ipcMain.handle("launcher:saveEffectsPreset", (_event, value) => {
    const saved = Presets.save(userDataDir, value);changed?.(Presets.list(userDataDir));return saved;
  });
  ipcMain.handle("launcher:deleteEffectsPreset", (_event, id, updatedAt) => {
    const rows = Presets.remove(userDataDir, id, updatedAt);changed?.(rows);return rows;
  });
  ipcMain.handle("launcher:getEffectsPresetEditor", (_event, plan) => {
    const requested = entry(plan == null ? null : Plan.validate(plan));
    return inspector ? inspector("gameEffectsInfo", requested, data()) : Runtime.info(requested, options());
  });
  ipcMain.handle("launcher:getEffectsPresetParameters", (_event, nodeId, plan) =>
    inspector ? inspector("gameEffectParameters", entry(), nodeId, plan, data()) : Runtime.describe(entry(), nodeId, plan, options()));
  ipcMain.handle("launcher:pickEffectsPresetFile", (_event, kind, expectedOperation) => expectedOperation===undefined?pickFile(kind):pickFile(kind,expectedOperation));
  // A game's status read reports measured row costs; presets with the same
  // rows keep the latest total. A library that cannot be read is left alone.
  return { measured(plan, contexts) { try { if (Presets.recordCost(userDataDir, plan, contexts)) changed?.(Presets.list(userDataDir)); } catch {} } };
}
module.exports = { register };
