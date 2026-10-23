const path = require("node:path");
const { buildPinnedRuntime } = require("../shared/runtime/pinned-native-build");
const Compat = require("./native-compat");

function sourcePathFlags(manager, version, userDataDir) {
  const installDir = manager.core.getInstallDir({ userDataDir, version });
  const mappings = [[installDir, `maclauncher-build/krkrsdl2/${version}`], [path.join(installDir, "build-source"), "src/external/krkrsdl2"]];
  const quoted = value => "'" + value.replace(/'/g, "'\\''") + "'";
  return mappings.flatMap(([from, to]) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${quoted(from + "=" + to)}`)).join(" ");
}

async function buildManagedRuntime({ manager, version, sourceDir, userDataDir, logger, signal, onProgress, onRuntimeStateChange, dependencies }) {
  const pathFlags = sourcePathFlags(manager, version, userDataDir);
  return buildPinnedRuntime({
    manager, version, sourceDir: sourceDir || path.resolve(__dirname, "../../external/krkrsdl2"), userDataDir,
    context: { logger, onRuntimeStateChange }, signal, onProgress, dependencies,
    cmakeOptions: ["-DOPTION_BUILD_MACOS_BUNDLE=OFF", "-DOPTION_ENABLE_EXTERNAL_PLUGINS=OFF",
      // SDL invalidates its presented backbuffer. Upstream already uses this
      // full-frame presenter on Linux; the reviewed Mac build needs it too.
      `-DCMAKE_C_FLAGS=${pathFlags}`,
      `-DCMAKE_CXX_FLAGS=${pathFlags}${/^snapshot-124bdf8-macos-v[23]$/.test(version) ? " -DKRKRSDL2_RENDERER_FULL_UPDATES" : ""}`],
    ...(version === "MCLv1-1001" ? { prepareSource: Compat.prepareSource } : {}),
    overlay: path.join(__dirname, "overlays", "macos-compat.h"),
    resolveExecutable: root => path.join(root, "krkrsdl2")
  });
}

async function buildRuntime(manager, entry, payload, context) {
  const requested = payload?.version || context.runtimeSettings?.version;
  const version = requested && requested !== "auto" ? requested : manager.resolveSelection(entry, context.settings, context.userDataDir).version;
  const installed = await buildManagedRuntime({ manager, version,
    sourceDir: payload?.sourceDir || context.runtimeSettings?.sourcePath, userDataDir: context.userDataDir,
    logger: context.logger, signal: context.signal, onProgress: context.onProgress, onRuntimeStateChange: context.onRuntimeStateChange });
  if (entry) entry.runtimeData = { ...entry.runtimeData, krkrsdl2: { ...entry.runtimeData?.krkrsdl2, version: installed.version } };
  return { ready: true, version: installed.version, runtimePath: installed.runtimePath,
    upstreamRevision: installed.upstreamRevision, sha256: installed.sha256, logPath: installed.logPath,
    provenanceVerified: installed.provenanceVerified };
}

module.exports = { buildRuntime, buildManagedRuntime, sourcePathFlags };
