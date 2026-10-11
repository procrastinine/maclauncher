const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "zz_maclauncher_console.rpy";
const MARKER = "# MacLauncher Ren'Py developer tools v1";
const BOOL_OPTIONS = ["developer", "fastSkip"];

function normalizeOptions(options = {}) {
  const result = {};
  for (const name of BOOL_OPTIONS) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") throw new Error(`${name} must be a boolean.`);
    result[name] = options[name] === true;
  }
  return result;
}
function toolsPaths(gameDir) {
  if (!gameDir || !fs.statSync(gameDir).isDirectory()) throw new Error("Game directory missing.");
  return [".rpy", ".rpyc", ".rpyb"].map(ext => path.join(gameDir, path.parse(FILE_NAME).name + ext));
}
function regularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error("Ren'Py developer tool paths must be regular files.");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function getDeveloperToolsStatus(gameDir) {
  if (!gameDir || !fs.existsSync(gameDir)) return { consolePresent: false, consoleInstalled: false };
  const files = toolsPaths(gameDir);
  const present = files.map(regularFile);
  const installed = present[0] && fs.readFileSync(files[0], "utf8").startsWith(MARKER + "\n");
  return { consolePresent: present.some(Boolean), consoleInstalled: Boolean(installed), consoleShortcut: "Shift+O" };
}
function installDeveloperTools(gameDir, options = {}) {
  const normalized = normalizeOptions(options);
  const files = toolsPaths(gameDir);
  const status = getDeveloperToolsStatus(gameDir);
  if (status.consolePresent && !status.consoleInstalled) throw new Error("An unowned file already uses the Ren'Py developer tools filename; refusing to overwrite it.");
  // Only invoked by the explicit install action. Do not set config.developer
  // unless requested: enabling the console alone leaves developer reload off.
  const source = `${MARKER}\n# Installed explicitly. Remove through MacLauncher, then restart the game.\ninit 999 python:\n    config.console = True\n` +
    (normalized.developer ? "    config.developer = True\n" : "") +
    (normalized.fastSkip ? "    config.fast_skipping = True\n" : "");
  // Compiled caches must be regenerated when options change.
  for (const compiled of files.slice(1)) if (regularFile(compiled)) fs.unlinkSync(compiled);
  fs.writeFileSync(files[0], source, { encoding: "utf8", flag: status.consoleInstalled ? "w" : "wx" });
  return { ...getDeveloperToolsStatus(gameDir), ...normalized, restartRequired: true };
}
function removeDeveloperTools(gameDir) {
  const files = toolsPaths(gameDir);
  const status = getDeveloperToolsStatus(gameDir);
  if (status.consolePresent && !status.consoleInstalled) throw new Error("Cannot verify ownership of the Ren'Py developer tools files; refusing to remove them.");
  for (const file of files) if (regularFile(file)) fs.unlinkSync(file);
  return { ...getDeveloperToolsStatus(gameDir), restartRequired: true };
}

module.exports = { FILE_NAME, MARKER, normalizeOptions, getDeveloperToolsStatus, installDeveloperTools, removeDeveloperTools };
