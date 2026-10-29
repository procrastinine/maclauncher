const fs = require("node:fs");
const path = require("node:path");
const { getUiServices } = require("../shared/ui-services");

async function pickPaths(payload, context, { title, multiple = false, files = true, directories = false, filters } = {}) {
  if (payload?.filePaths !== undefined && (!Array.isArray(payload.filePaths) || payload.filePaths.some(file => typeof file !== "string")))
    throw new Error("mpv selection requires a list of local paths.");
  const result = payload?.filePaths !== undefined ? { canceled: payload.filePaths.length === 0, filePaths: payload.filePaths }
    : await getUiServices(context).dialog.showOpenDialog({ title,
      properties: [...(files ? ["openFile"] : []), ...(directories ? ["openDirectory"] : []), ...(multiple ? ["multiSelections"] : [])],
      ...(filters ? { filters } : {}) });
  if (result.canceled || !result.filePaths?.length) return multiple ? { filePaths: [] } : { filePath: null };
  if (result.filePaths.length > (multiple ? 256 : 1)) throw new Error("Too many mpv paths were selected.");
  const selected = [...new Set(result.filePaths)];
  for (const file of selected) {
    if (typeof file !== "string" || file.length > 16384 || !path.isAbsolute(file) || /[\0\r\n]/.test(file))
      throw new Error("mpv requires absolute local file or folder paths.");
    let stat;
    try { stat = fs.statSync(file); } catch { throw new Error("The selected mpv file or folder was not found."); }
    if (!(files && stat.isFile() || directories && stat.isDirectory())) throw new Error("The selected mpv path has the wrong file or folder type.");
  }
  return multiple ? { filePaths: selected } : { filePath: selected[0] };
}

const settingsActions = {
  updatePlugin: async (payload, context) => {
    const result = await require("./plugins").manager.updatePlugin({ ...context, id: payload?.id });
    context.onRuntimeStateChange?.({ managerId: "mpv-plugins" });return result;
  },
  installPlugin: async (payload, context) => {
    let source = payload?.source;
    if (!source) {
      const picked = await pickPaths(payload, context, { title: "Choose mpv plugin", directories: true, filters: [{ name: "mpv plugins", extensions: ["lua", "js", "zip"] }] });
      if (!picked.filePath) return { canceled: true };
      source = picked.filePath;
    }
    const result = await require("./plugins").manager.installRuntime({ ...context, source, scriptPath: payload?.scriptPath, label: payload?.label });
    context.onRuntimeStateChange?.({ managerId: "mpv-plugins" });return result;
  },
  setPluginEnabled: (payload, context) => {
    const result = require("./plugins").manager.setCustomEnabled({ userDataDir: context.userDataDir, id: payload?.id, enabled: payload?.enabled });
    context.onRuntimeStateChange?.({ managerId: "mpv-plugins" });return result;
  },
  pickConfigDirectory: (payload, context) => pickPaths(payload, context, { title: "Choose mpv configuration folder", files: false, directories: true }),
  pickConfigFiles: (payload, context) => pickPaths(payload, context, { title: "Choose mpv configuration files", multiple: true, filters: [{ name: "mpv configuration", extensions: ["conf"] }] }),
  pickScriptFiles: (payload, context) => pickPaths(payload, context, { title: "Choose mpv scripts", multiple: true, directories: true, filters: [{ name: "mpv scripts", extensions: ["lua", "js"] }] }),
  pickInputConfig: (payload, context) => pickPaths(payload, context, { title: "Choose mpv input configuration", filters: [{ name: "mpv configuration", extensions: ["conf"] }] })
};
const actions = Object.fromEntries(Object.entries(settingsActions).map(([id, action]) => [id, (_entry, payload, context) => action(payload, context)]));
module.exports = { settingsActions, actions };
