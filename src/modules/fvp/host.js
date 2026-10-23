const fs = require("node:fs");
const path = require("node:path");
const Python = require("../shared/runtime/python");
const Native = require("../shared/runtime/local-native");

function resolveHostScript(directory = __dirname) {
  // Native Python cannot read Electron's virtual archive. Packaging unpacks
  // this one immutable script beside app.asar; development reads it directly.
  const file = path.join(directory, "host.py").replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
  if (!fs.statSync(file).isFile()) throw new Error("The included RFVP game adapter is missing. Reinstall MacLauncher.");
  return file;
}
function hostCommand(launch, install, { resolveRoot = Python.resolveEmbeddedPythonRoot, resolveBinary = Python.resolveEmbeddedPythonBinary, resolveScript = resolveHostScript } = {}) {
  const pythonPath = resolveBinary(resolveRoot());
  if (!pythonPath || !path.isAbsolute(pythonPath)) throw new Error("The included Python game host is missing. Reinstall MacLauncher.");
  const dylibPath = install.dylibPath;
  if (!path.isAbsolute(dylibPath || "") || !fs.statSync(dylibPath).isFile()) throw new Error("The RFVP native library is missing. Reinstall the selected runtime.");
  const helperPath = resolveScript();
  const architectures = Native.readMachOArchitectures(pythonPath), libraryArchitectures = Native.readMachOArchitectures(dylibPath, { allowLibrary: true });
  const architecture = process.arch === "x64" ? "x86_64" : process.arch;
  if (!architectures.includes(architecture) || !libraryArchitectures.includes(architecture)) throw new Error("The included game host and RFVP runtime must support this Mac's CPU.");
  return { executablePath: pythonPath, args: ["-I", "-u", helperPath, dylibPath, launch.playRoot, launch.textEncoding, launch.textHiDpi ? "1" : "0"] };
}
module.exports = { hostCommand, resolveHostScript };
