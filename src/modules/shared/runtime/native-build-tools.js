const fs = require("node:fs");
const path = require("node:path");
const Native = require("./local-native");
const Source = require("./pinned-native-build");

// Source installation is an explicit action. Ordinary packaged execution uses
// already built runtime payloads and never needs a compiler or global CLI.
const PACKAGES = Object.freeze({
  cmake: Object.freeze({ filename: "cmake-4.4.4-macos-universal.tar.gz", url: "https://github.com/Kitware/CMake/releases/download/v4.4.4/cmake-4.4.4-macos-universal.tar.gz", sha256: "4b7b73704b1db9b374e5c9ab8e17ac6148b817b6396ee75cd94a852cbac9d305" }),
  ninja: Object.freeze({ filename: "ninja-1.13.2-mac.zip", url: "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-mac.zip", sha256: "c99048673aa765960a99cf10c6ddb9f1fad506099ff0a0e137ad8960a88f321b" })
});

async function resolveBuildTool(name, { findBuildTool = Source.findBuildTool, packageArchive, temporary, arch = process.arch } = {}) {
  if (!Object.hasOwn(PACKAGES, name)) throw new Error("Unsupported portable native build tool.");
  try { return findBuildTool(name); } catch {}
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch) ||
      typeof packageArchive !== "function" || !path.isAbsolute(temporary || "")) {
    throw new Error("Portable native build tools require a Mac and a managed temporary directory.");
  }
  const root = path.join(temporary, "tools", name);
  await packageArchive(name, root);
  const executable = name === "cmake"
    ? path.join(root, "cmake-4.4.4-macos-universal", "CMake.app", "Contents", "bin", "cmake")
    : path.join(root, "ninja");
  if (!Native.readMachOArchitectures(executable).includes(arch)) throw new Error(`Portable ${name} is missing ${arch} support.`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

module.exports = { PACKAGES, resolveBuildTool };
