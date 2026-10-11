const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const manager = require("./manager");
const Native = require("../../shared/runtime/local-native");
const { validatePinnedSource, stagePinnedFiles, runBuildCommand, findBuildTool } = require("../../shared/runtime/pinned-native-build");

const VERSION = "0.9.5-cli-v2";
const REVISION = "b33f0e7275ea1fc8a82459b418f6a7b5f1b40108";

function adaptSource(source, version = VERSION) {
  const cmakePath = path.join(source, "gemrb", "CMakeLists.txt");
  let cmake = fs.readFileSync(cmakePath, "utf8");
  const unsafe = '"${SDL_FULL_PATH}")';
  if (!cmake.includes(unsafe)) throw new Error("GemRB SDL build overlay no longer matches its pinned source.");
  cmake = cmake.replace(unsafe, '"${BUNDLE_FRAMEWORK_PATH}/${SDL_REAL_BASENAME}")');
  cmake = cmake.replace('get_filename_component(SDL_FULL_PATH "${SDL_LIB}" REALPATH)',
    'get_filename_component(SDL_FULL_PATH "${SDL_LIB}" REALPATH)\n\t\tget_filename_component(SDL_REAL_BASENAME "${SDL_FULL_PATH}" NAME)');
  const nib = /  # compile nib\n  ADD_CUSTOM_COMMAND \(TARGET gemrb POST_BUILD[^]*?COMMENT "Compiling GemRB\.xib"\)\n/;
  if (!nib.test(cmake)) throw new Error("GemRB CLI build overlay no longer matches its pinned source.");
  cmake = cmake.replace(nib, "  # MacLauncher CLI entry does not load the optional GUI configuration nib.\n");
  fs.writeFileSync(cmakePath, cmake);
  const wrapperPath = path.join(source, "platforms", "apple", "CocoaWrapper", "mac", "CocoaWrapper.mm");
  let wrapper = fs.readFileSync(wrapperPath, "utf8");
  const signature = 'int main (int __unused argc, char ** __unused argv)\n{';
  if (!wrapper.includes(signature)) throw new Error("GemRB native entry overlay no longer matches its pinned source.");
  wrapper = wrapper.replace('#import "Logging/Logging.h"', '#import "Logging/Logging.h"\n#import "Logging/Loggers/Stdio.h"');
  wrapper = wrapper.replace(signature, `int main (int argc, char ** argv)
{
  // MacLauncher keeps game configuration in its own per-game data directory.
  if (argc > 1) {
    @autoreleasepool {
      NSApplication* app = [NSApplication sharedApplication];
      CocoaWrapper* delegate = [[CocoaWrapper alloc] init];
      [app setDelegate:delegate];
      [app setActivationPolicy:NSApplicationActivationPolicyRegular];
      try {
        auto settings = LoadFromArgs(argc, argv);
        ToggleLogging(settings.Logging);
        AddLogWriter(createStdioLogWriter());
        SanityCheck();
        Interface engine(std::move(settings));
        engine.Main();
      } catch (CoreInitializationException& error) {
        Log(FATAL, "MacLauncher", "{}", error);
        [delegate release];
        return 1;
      }
      [delegate release];
      return 0;
    }
  }`);
  fs.writeFileSync(wrapperPath, wrapper);
  if (version === "0.9.5-cli-v2") {
    const references = path.join(source, "gemrb", "core", "GUI", "GUIScriptInterface.h");
    let header = fs.readFileSync(references, "utf8");
    for (const name of ["ViewScriptingRef", "WindowScriptingRef", "ControlScriptingRef"]) {
      const declaration = `class ${name} :`;
      if (!header.includes(declaration)) throw new Error("GemRB scripting reference export overlay no longer matches pinned source.");
      header = header.replace(declaration, `class GEM_EXPORT ${name} :`);
    }
    fs.writeFileSync(references, header);
  }
}

async function buildRuntime({ userDataDir, sourcePath, version = VERSION, logger, signal, onProgress } = {}) {
  if (process.platform !== "darwin") throw new Error("GemRB CLI builds require macOS.");
  if (!["0.9.5-cli-v1", VERSION].includes(version)) throw new Error(`GemRB CLI build requires the listed version ${VERSION}.`);
  signal?.throwIfAborted();
  const installed = manager.core.resolveRegistered({ userDataDir, version });
  if (installed) return installed;
  const source = sourcePath || path.resolve(__dirname, "../../../external/gemrb");
  const checked = await validatePinnedSource(source, REVISION);
  const cmake = findBuildTool("cmake");
  // Build a private source copy. Upstream files and installed libraries stay untouched.
  const directory = manager.core.getInstallDir({ userDataDir, version });
  if (fs.existsSync(directory)) throw new Error("Remove the incomplete GemRB CLI build directory before rebuilding.");
  const copiedSource = path.join(directory, "source"), build = path.join(directory, "build");
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const sourceTreeSha256 = stagePinnedFiles(source, checked.files, copiedSource);
  adaptSource(copiedSource, version);
  const overlayHash = crypto.createHash("sha256")
    .update(Native.hashFile(path.join(copiedSource, "gemrb", "CMakeLists.txt")))
    .update(Native.hashFile(path.join(copiedSource, "platforms", "apple", "CocoaWrapper", "mac", "CocoaWrapper.mm")));
  if (version === "0.9.5-cli-v2") overlayHash.update(Native.hashFile(path.join(copiedSource, "gemrb", "core", "GUI", "GUIScriptInterface.h")));
  const overlaySha256 = overlayHash.digest("hex");
  const configureOptions = ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", "-DDISABLE_WERROR=ON", "-DUSE_TRACY=OFF", "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON"];
  const logPath = path.join(directory, "build.log");
  fs.writeFileSync(logPath, `GemRB ${version}\nPinned source ${REVISION}\nSource tree SHA-256 ${sourceTreeSha256}\nOverlay SHA-256 ${overlaySha256}\n`);
  logger?.info?.(`[runtime] build GemRB ${version}; ${logPath}`);
  const environment = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" };
  const commandOptions = { cwd: directory, logPath, env: environment, signal };
  onProgress?.({ downloaded: 5, total: 100 });
  await runBuildCommand(cmake, ["-S", copiedSource, "-B", build, ...configureOptions], commandOptions);
  onProgress?.({ downloaded: 20, total: 100 });
  // Upstream's Apple plugin bundle-loader flags reference the executable without
  // declaring that dependency for every plugin. Finish the loader before parallel
  // plugin links rather than racing the executable and dynamic bundles.
  await runBuildCommand(cmake, ["--build", build, "--target", "gemrb", "--parallel", "4"], commandOptions);
  onProgress?.({ downloaded: 50, total: 100 });
  await runBuildCommand(cmake, ["--build", build, "--parallel", "4"], commandOptions);
  onProgress?.({ downloaded: 85, total: 100 });
  const app = path.join(build, "gemrb", "gemrb.app");
  await runBuildCommand("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], commandOptions);
  await validatePinnedSource(source, REVISION);
  signal?.throwIfAborted();
  const verifiedBuild = { sourceRevision: REVISION, sourceTreeSha256, overlaySha256, configureOptions,
    hostPlatform: process.platform, hostArch: process.arch, logPath };
  fs.writeFileSync(path.join(directory, "build-evidence.json"), JSON.stringify({ version,
    upstreamRevision: REVISION, overlay: version.replace("0.9.5-", "maclauncher-"), architecture: process.arch,
    platform: process.platform, verifiedBuild, builtAt: new Date().toISOString() }, null, 2));
  const result = manager.core.registerLocal({ userDataDir, version, runtimePath: app, verifiedBuild });
  onProgress?.({ downloaded: 100, total: 100 });
  return result;
}

module.exports = { buildRuntime, adaptSource, VERSION, REVISION };
