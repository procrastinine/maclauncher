const fs = require("node:fs"), path = require("node:path");
// RetroArch and ReShade presets are small text files.
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Chooses a RetroArch .slangp or ReShade .ini preset and returns its name and
 * text. The effects editor parses and matches the text against the row's
 * parameters. Cancelling returns null.
 */
async function readShaderOptionsFile({dialog, owner}) {
  const options = {title: "Import shader options", buttonLabel: "Import", properties: ["openFile"],
    filters: [{name: "RetroArch and ReShade presets", extensions: ["slangp", "ini"]}]};
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths?.[0]) return null;
  const file = result.filePaths[0], name = path.basename(file);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${name} could not be read.`);
  if (stat.size > MAX_BYTES) throw new Error(`${name} is too large for a shader preset.`);
  const bytes = await fs.promises.readFile(file).catch(() => null);
  if (!bytes) throw new Error(`${name} could not be read.`);
  try { return {name, text: new TextDecoder("utf-8", {fatal: true}).decode(bytes)}; }
  catch { throw new Error(`${name} is not a text preset.`); }
}

function register({ipcMain, dialog, clipboard, owner}) {
  ipcMain.handle("launcher:importShaderOptions", () => readShaderOptionsFile({dialog, owner: owner()}));
  ipcMain.handle("launcher:readClipboardText", () => clipboard.readText());
  ipcMain.handle("launcher:writeClipboardText", (_event, text) => {
    if (typeof text !== "string") throw new Error("Choose text to copy.");
    clipboard.writeText(text);return true;
  });
}
module.exports = {register, readShaderOptionsFile};
