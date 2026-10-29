const fs = require("node:fs");
const path = require("node:path");
const Application = require("../../shared/native-application");
const { readInfoPlist } = require("../../shared/runtime/app-bundle");

async function prepareApplication(entry, context, install, directory) {
  const contents = path.dirname(path.dirname(install.executablePath)), app = path.dirname(contents);
  const info = readInfoPlist(app);
  if (!info) throw new Error("The DOSBox application metadata is unavailable.");
  const links = Object.fromEntries(fs.readdirSync(contents).filter(name => !["MacOS", "Resources", "Info.plist", "_CodeSignature"].includes(name))
    .map(name => [name, path.join(contents, name)]));
  const resources = path.join(contents, "Resources"), macos = path.join(contents, "MacOS");
  const resourceLinks = Object.fromEntries(fs.readdirSync(resources).map(name => [name, path.join(resources, name)]));
  const nativeLinks = Object.fromEntries(fs.readdirSync(macos).filter(name => name !== path.basename(install.executablePath))
    .map(name => [name, path.join(macos, name)]));
  context.recordRuntimeUse?.({ managerId: "dosbox-staging", version: install.version, sourcePath: install.installDir });
  return Application.prepare({ executablePath: install.executablePath, directory: path.join(directory, "application"),
    title: entry.name || "DOS game", links, resourceLinks, nativeLinks, originalInfo: info, showInDock: true,
    applicationLabel: "DOSBox", graphicsCompatible: true, signal: context.signal });
}
module.exports = { prepareApplication };
