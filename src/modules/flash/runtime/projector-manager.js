const path = require("node:path");
const { createProjectBuildManager } = require("../../shared/runtime/project-build-manager");
const Bundled = require("../../shared/runtime/bundled-native");
const AppBundle = require("../../shared/runtime/app-bundle");
const Native = require("../../shared/runtime/local-native");

const ID = "flash-projector";
const UPSTREAM_VERSION = "35.0.0.60";
const VERSION = `${UPSTREAM_VERSION}-MCLv1`;
const APP_RELATIVE = "Flash Player.app";
const EXECUTABLE_RELATIVE = APP_RELATIVE + "/Contents/MacOS/Flash Player";

function verifyProjector(selected) {
  Bundled.verifyPayload(selected.root, selected.declaration);
  const appPath = path.join(selected.payloadRoot, APP_RELATIVE);
  const executablePath = path.join(selected.payloadRoot, EXECUTABLE_RELATIVE);
  const info = AppBundle.readInfoPlist(appPath);
  const architectures = Native.readMachOArchitectures(executablePath);
  if (info.CFBundleShortVersionString !== UPSTREAM_VERSION ||
      info.CFBundleExecutable !== "Flash Player" ||
      info.CFBundleIdentifier !== "com.macromedia.Flash Player.app" ||
      !architectures.includes("arm64") || !architectures.includes("x86_64"))
    throw new Error("The Flash Player package has a different version or CPU architecture.");
  AppBundle.validateAppBundle(appPath, { executablePath });
}

function createManager({ dependencies = {} } = {}) {
  const manager = createProjectBuildManager({
    projectId: ID, runtimeId: "projector", label: "Adobe Flash Player", fallbackVersion: VERSION,
    repository: "procrastinine/maclauncher-builds", upstreamUrl: "https://www.adobe.com/products/flashplayer/end-of-life.html", upstreamLabel: "Adobe Flash Player", manifestRelative: "manifest.json",
    sourceRelative: null, filesPrefix: "files/", executableRelative: EXECUTABLE_RELATIVE,
    supportsDefault: true, dependencies,
    validateManifest(manifest) {
      if (manifest.managerId !== ID || manifest.platform !== "darwin" ||
          manifest.executableRelative !== EXECUTABLE_RELATIVE)
        throw new Error("The Flash Player package has a different application layout.");
    },
    verifyPayload: verifyProjector
  });
  const resolve = manager.resolveSelection;
  manager.resolveSelection = (...args) => {
    const selection = resolve(...args);
    if (selection.install) {
      selection.install.appPath = path.join(selection.install.payloadRoot, APP_RELATIVE);
      selection.install.executablePath = path.join(selection.install.payloadRoot, EXECUTABLE_RELATIVE);
    }
    return selection;
  };
  return manager;
}

const manager = createManager();
module.exports = manager;
manager.__test = { createManager, verifyProjector, VERSION, UPSTREAM_VERSION, EXECUTABLE_RELATIVE };
