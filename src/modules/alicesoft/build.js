const path = require("node:path");
const { buildPinnedRuntime } = require("../shared/runtime/pinned-native-build");
const { buildManagedSystem4 } = require("./system4-build");
const PortableSystem3 = require("./system3-portable");
const PortableSystem35 = require("./system35-portable");

async function buildManagedRuntime({ manager, version, sourceDir, userDataDir, logger, signal, onProgress, onRuntimeStateChange, dependencies }) {
  if (manager.id === "xsystem4") return buildManagedSystem4({ manager, version, sourceDir, userDataDir, logger, signal, onProgress, dependencies });
  const system3 = manager.id === "system3";
  if (!system3 && manager.id !== "xsystem35") throw new Error("Unknown AliceSoft runtime builder.");
  if (system3 && typeof version === "string" && version.trim().replace(/^v/, "") === PortableSystem3.VERSION) {
    throw new Error(`System3 ${PortableSystem3.VERSION} source builds require the portable dependency recipe and its pinned source archives.`);
  }
  if (!system3 && typeof version === "string" && version.trim().replace(/^v/, "") === PortableSystem35.VERSION) {
    throw new Error(`xsystem35 ${PortableSystem35.VERSION} source builds require the portable dependency recipe and its pinned source archives.`);
  }
  return buildPinnedRuntime({
    manager, version, sourceDir: sourceDir || path.resolve(__dirname, "../../external", system3 ? "system3-sdl2" : "xsystem35-sdl2"), userDataDir,
    context: { logger, onRuntimeStateChange }, signal, onProgress, dependencies,
    cmakeOptions: system3 ? ["-DSYSTEM3_SDL_VERSION=2"] : ["-DENABLE_PORTMIDI=OFF"],
    resolveExecutable: root => path.join(root, system3 ? "system3" : "src/xsystem35")
  });
}

async function buildRuntime(manager, entry, payload, context) {
  const requested = payload?.version || context.runtimeSettings?.version;
  const version = requested && requested !== "auto" ? requested : manager.resolveSelection(entry, context.settings, context.userDataDir).version;
  const installed = await buildManagedRuntime({ manager, version,
    sourceDir: payload?.sourceDir || context.runtimeSettings?.sourcePath, userDataDir: context.userDataDir,
    logger: context.logger, signal: context.signal, onProgress: context.onProgress, onRuntimeStateChange: context.onRuntimeStateChange });
  if (entry) entry.runtimeData = { ...entry.runtimeData, [manager.id]: { ...entry.runtimeData?.[manager.id], version: installed.version } };
  return { ready: true, version: installed.version, runtimePath: installed.runtimePath,
    upstreamRevision: installed.upstreamRevision, sha256: installed.sha256, logPath: installed.logPath,
    provenanceVerified: installed.provenanceVerified };
}

module.exports = { buildRuntime, buildManagedRuntime };
