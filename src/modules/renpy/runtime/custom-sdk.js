const fs = require("node:fs");
const path = require("node:path");
const Custom = require("../../shared/runtime/custom-runtime");
const { findMacLibDir } = require("./patcher");

function versionAt(root) {
  for (const name of ["renpy/vc_version.py", "renpy/__init__.py"]) {
    const file = path.join(root, name);
    try {
      if (fs.statSync(file).size > 256 * 1024) continue;
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/\bversion\s*=\s*["'](\d+\.\d+\.\d+)/) ||
        text.match(/\bversion_tuple\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) return match.length === 4 ? match.slice(1).join(".") : match[1];
    } catch {}
  }
  return null;
}

function inspect(runtimePath, { sectionId } = {}) {
  const major = sectionId === "v7" ? 7 : sectionId === "v8" ? 8 : null;
  if (!major) throw new Error("Choose a Ren'Py 7 or Ren'Py 8 runtime list.");
  let root = fs.statSync(runtimePath).isDirectory() ? runtimePath : path.dirname(runtimePath);
  for (let depth = 0; depth < 6; depth++, root = path.dirname(root)) {
    if (!["renpy.sh", "renpy.py", "renpy/__init__.py"].every(name => {
      try { return fs.statSync(path.join(root, name)).isFile(); } catch { return false; }
    }) || !fs.existsSync(path.join(root, "launcher"))) continue;
    const runtimeVersion = versionAt(root);
    if (!runtimeVersion) throw new Error("The selected SDK has no readable Ren'Py version metadata.");
    const actualMajor = Number(runtimeVersion.split(".")[0]);
    if ((major === 8 && actualMajor !== 8) || (major === 7 && (actualMajor < 1 || actualMajor > 7)))
      throw new Error("The selected Ren'Py SDK belongs to a different runtime list.");
    const lib = findMacLibDir(root, major);
    if (!lib) throw new Error("The selected Ren'Py SDK has no compatible macOS libraries.");
    const native = Custom.inspectNative(path.join(lib.dir, "renpy"));
    Custom.inspectNative(path.join(lib.dir, "python"));
    return { ...native, installDir: root, sdkRoot: root, root, payloadRoot: root,
      runtimeVersion, major, platform: lib.platform, launcherPath: ["Ren'Py.app", "renpy.app"]
        .map(name => path.join(root, name)).find(file => fs.existsSync(file)) || null };
  }
  throw new Error("Select a complete Ren'Py SDK containing renpy.sh, renpy.py, launcher and its macOS libraries.");
}

module.exports = { inspect };
