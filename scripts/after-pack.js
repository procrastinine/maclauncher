const fs = require("node:fs");
const path = require("node:path");
const { parsePlistFile, savePlistFile } = require("app-builder-lib/out/util/plist");
const { Arch } = require("builder-util");
const { applicationDocumentTypes } = require("../src/core/file-associations");
const { restoreCopiedNativePayload } = require("./native-copy.cjs");
const Modules = require("../src/modules/registry");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const info = await parsePlistFile(infoPath);
  info.CFBundleDisplayName = "MacLauncher";
  const documentTypes = applicationDocumentTypes(Modules.listSupportedInputExtensions(), info.CFBundleIconFile);
  const managedTypes = new Set(documentTypes.map(type => type.CFBundleTypeName));
  info.CFBundleDocumentTypes = [
    ...(info.CFBundleDocumentTypes || []).filter(type => !managedTypes.has(type.CFBundleTypeName)),
    ...documentTypes
  ];
  await savePlistFile(infoPath, info);

  const projectDir = context.packager.info?.projectDir || path.resolve(__dirname, "..");
  const nativeSource = path.join(projectDir, "src", "resources", "native-runtimes");
  if (exists(nativeSource)) {
    const architecture = typeof context.arch === "string" ? context.arch : Arch[context.arch];
    restoreCopiedNativePayload({ sourceRoot: nativeSource,
      resourceRoot: path.join(resourcesPath, "native-runtimes"),
      requiredOnly: true,
      architectures: architecture === "universal" ? ["arm64", "x64"] : [architecture] });
  }
  const check = require('./check-packaging.cjs');
  check.assertRuntimeBoundary(appPath);
  check.inspectAsar(path.join(resourcesPath, 'app.asar'), {
    product: 'MacLauncher', version: context.packager.appInfo.version
  });
};
