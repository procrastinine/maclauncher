const path = require("node:path");
const { buildPinnedRuntime } = require("../../shared/runtime/pinned-native-build");

// Upstream's bytecode JIT emits x86 instructions. ARM builds only supply the
// HashLink/C support library; they are not interchangeable with the bytecode VM.
async function buildRuntime({ userDataDir, version = "1.16", sourcePath, sdlSourcePath, openalSourcePath, logger, signal, onProgress } = {}) {
  const graphics = require("./legacy-build");
  const dynamic = require("./dynamic-legacy-build");
  if (version === dynamic.VERSION) return dynamic.buildRuntime({ userDataDir, sourcePath, sdlSourcePath, openalSourcePath, logger, signal, onProgress });
  if (version === graphics.VERSION) return graphics.buildRuntime({ userDataDir, sourcePath, sdlSourcePath, openalSourcePath, logger, signal, onProgress });
  if (version === graphics.UPSTREAM_VERSION) throw new Error("HashLink 1.9 remains available. Select 1.9 Mac graphics v2 for a new build.");
  const manager = require("./manager");
  const pin = manager.core.catalog.find(entry => entry.version === version);
  if (!pin?.localBuild || version !== "1.16") throw new Error("This source build supports HashLink 1.16. Other compatible native distributions can be imported.");
  return buildPinnedRuntime({ manager, version, userDataDir,
    sourceDir: sourcePath || path.resolve(__dirname, "../../../external/hashlink"), signal, onProgress,
    context: { logger }, resolveExecutable: output => path.join(output, "bin", "hl"),
    cmakeOptions: ["-DCMAKE_OSX_ARCHITECTURES=x86_64", "-DWITH_VM=ON", "-DBUILD_TESTING=OFF", "-DDOWNLOAD_DEPENDENCIES=OFF",
      "-DWITH_FMT=OFF", "-DWITH_SDL=OFF", "-DWITH_OPENAL=OFF", "-DWITH_SQLITE=OFF", "-DWITH_SSL=OFF", "-DWITH_UV=OFF", "-DWITH_HEAPS=OFF", "-DWITH_UI=ON"] });
}
module.exports = { buildRuntime };
