const fs = require("node:fs");
const path = require("node:path");
const Rosetta = require("../../shared/runtime/rosetta");

// renpy.sh is a shell script, including in SDKs whose Python is Intel-only.
// Inspect the binary the script selects before launching it; a directory named
// "mac-universal" is not evidence that the executable contains an arm64 slice.
async function ensureTranslation(libInfo, context = {}, executableName = "renpy", service = Rosetta) {
  if (!libInfo?.dir) throw new Error("Ren'Py macOS libraries are missing.");
  let executable = path.join(libInfo.dir, executableName);
  if (!fs.existsSync(executable) && executableName !== "renpy") executable = path.join(libInfo.dir, "renpy");
  if (!fs.existsSync(executable)) throw new Error("Ren'Py macOS executable is missing.");
  return service.ensureForExecutable(executable, context);
}

module.exports = { ensureTranslation };
