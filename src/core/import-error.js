const fs = require("node:fs");
const path = require("node:path");

// Translate only at the import boundary. The cause keeps the original diagnostic
// while every caller (Finder, Add and drops) receives the same actionable text.
function userImportError(error, input) {
  if (error?.code === "ABORT_ERR" || error?.name === "AbortError") return error;
  const paths = /^[A-Za-z]:\\/.test(input) ? path.win32 : path;
  const name = paths.basename(input);
  const extension = paths.extname(name).toLowerCase();
  let kind = extension ? `${extension.slice(1).toUpperCase()} file` : "file";
  try { if (fs.statSync(input).isDirectory()) kind = extension === ".app" ? "Mac application" : "folder"; } catch {}
  const item = `“${name}”`;
  const code = error?.code;
  let message;
  if (code === "DETECTION_CONFLICT") {
    message = `${item} contains more than one possible game. Add the game file or a more specific folder.`;
  } else if (code === "DETECTION_UNSUPPORTED" || code === "DETECTION_UNSUPPORTED_EXTENSION") {
    message = `${item} is a ${kind} MacLauncher does not recognize as a game. Add the game's application, main game file or complete folder.`;
  } else if (code === "DETECTION_NOT_FOUND" || code === "ENOENT") {
    message = `${item} could not be found. Locate the file or folder and add it again.`;
  } else if (code === "EACCES" || code === "EPERM") {
    message = `${item} could not be read. Check its access permissions in Finder and add it again.`;
  } else if (code === "DETECTION_LIMIT") {
    message = `${item} could not be searched completely. Add the main game file or a more specific folder.`;
  } else if (String(code).startsWith("INSTALLER_")) {
    const next = code === "INSTALLER_ENCRYPTED" ? "Use an unencrypted offline installer."
      : code === "INSTALLER_MISSING_PARTS" ? "Keep all companion data files beside the installer and add it again."
      : code === "INSTALLER_READER_FAILED" || code === "INSTALLER_TOOL_MISSING" ? "Open Runtimes → Tools → Installer reader to choose or install a reader version, then add the installer again."
      : "Add a complete offline installer with its companion data files, or add the installed game's folder.";
    message = `${item} is an installer whose game data could not be read. ${next}`;
  } else {
    message = `${item} could not be added (${kind}). Check that the file or folder is complete and readable, then add it again.`;
  }
  const result = new Error(message, { cause: error });
  if (code != null) result.code = code;
  if (error?.detection) result.detection = error.detection;
  if (error?.stack) result.stack += `\nCaused by: ${error.stack}`;
  return result;
}

module.exports = { userImportError };
