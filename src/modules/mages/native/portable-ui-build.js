const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");
const Base = require("./portable-build");
const Dependency = require("./portable-dependencies");
const Overlay = require("./windows-ui-overlay");
const Session = require("./windows-ui-session");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.10.8.810-windows-v5";
const PROFILE = "windows-mpk2-sc3-input-macos13-v5";
const PROFILE_SHA256 = Session.PROFILE_SHA256;
const RECIPE_FILES = Object.freeze([...new Set([__filename, ...Base.RECIPE_FILES,
  require.resolve("./windows-ui-overlay"), require.resolve("./windows-ui-data"), require.resolve("./windows-ui-session"),
  path.join(__dirname, "windows-input.h"), path.join(__dirname, "windows-input.cpp"),
  path.join(__dirname, "windows-input-state.h"), Session.PROFILE_SOURCE])]);

function overlayIdentity() {
  const hash = crypto.createHash("sha256");
  for (const file of RECIPE_FILES) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

async function buildWindowsInputImpacto(options) {
  throwIfAborted(options.signal);
  const identity = overlayIdentity();
  if (Native.hashFile(Session.PROFILE_SOURCE) !== PROFILE_SHA256) throw new Error("Impacto Windows input profile checksum changed.");
  // The portable recipe makes a fresh source export and builds its complete
  // codec/dependency closure. This version adds the input overlay to that owned
  // export and recompiles only the changed engine units.
  const base = await Base.buildPortableImpacto(options);
  throwIfAborted(options.signal);
  const workRoot = path.dirname(base.logPath), sourceRoot = path.join(base.sourceRoot, "impacto");
  const windowsUiOverlay = Overlay.applyWindowsUiOverlay(sourceRoot);
  const env = Dependency.environment(base.runtimeRoot, base.sdk,
    [path.join(workRoot, "avcpp"), path.join(workRoot, "ffmpeg"), base.dependencyStack.prefix]);
  env.GIT_CEILING_DIRECTORIES = workRoot;
  const run = options.dependencies?.runBuildCommand || Source.runBuildCommand;
  const runOptions = { cwd: workRoot, logPath: base.logPath, env, signal: options.signal, timeout: 20 * 60 * 1000 };
  options.onProgress?.({ phase: "build", project: "impacto-windows-input" });
  await run(base.tools.cmake, base.configureOptions.impacto, runOptions);
  await run(base.tools.cmake, ["--build", path.join(base.outputRoot, "impacto"), "--parallel", "2"], runOptions);
  await run(base.tools.cmake, ["--install", path.join(base.outputRoot, "impacto")], runOptions);
  const dependencyLink = await Base.linkDependencyPaths(base.executable,
    [base.dependencyStack.prefix, path.join(workRoot, "ffmpeg")],
    { logPath: base.logPath, env, signal: options.signal, dependencies: options.dependencies });
  Base.validateDependencyStack(base.dependencyStack);
  if (overlayIdentity() !== identity) throw new Error("Impacto Windows input build recipe changed during compilation.");
  const result = { ...base, version: VERSION, profile: PROFILE, profileSha256: PROFILE_SHA256,
    overlaySha256: identity, baseRecipeSha256: base.overlaySha256, windowsUiOverlay,
    executableSha256: Native.hashFile(base.executable), executableFloor: Base.assertMinimumMacOS(base.executable),
    dependencyLink, completedAt: new Date().toISOString() };
  fs.renameSync(path.join(workRoot, "portable-build.json"), path.join(workRoot, "portable-base-build.json"));
  fs.writeFileSync(path.join(workRoot, "portable-build.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

module.exports = { VERSION, PROFILE, PROFILE_SHA256, RECIPE_FILES, overlayIdentity, buildWindowsInputImpacto };
