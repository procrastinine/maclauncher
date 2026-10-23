const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require("../shared/runtime/local-native");
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Resources = require("./system3-resource-overlay");

const VERSION = "1.8.0-MCLv1";
const REVISION = "461673bec729e7e0ec905921fc3e03aecf977a70";
const SOURCE_SHA256 = "7d5074ef5cce68c9f0f4246fb91f17ba8482f7ae798ddda9dd6208d8530f695c";
const sourcePath = path.resolve(__dirname, "../../external/system3-sdl2");

function overlayIdentity() {
  return crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve("./system3-resource-overlay")))
    .update(fs.readFileSync(require.resolve("../shared/runtime/portable-sdl2-fonts"))).update(fs.readFileSync(require.resolve("../shared/runtime/portable-sdl2-fonts.json"))).digest("hex");
}

async function buildPortableSystem3({ sourceDir = sourcePath, archives, workRoot, pathMappings = [], signal, onProgress, dependencies = {} }) {
  workRoot = Fonts.assertFreshBuildRoot(workRoot, { readOnlyRoots: [sourceDir] });
  const source = await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== SOURCE_SHA256) throw new Error("System3 source tree checksum does not match the selected version.");
  const overlaySha256 = overlayIdentity();
  const stack = await Fonts.buildDependencies({ archives, workRoot, pathMappings, signal, onProgress, dependencies });
  const sourceRoot = path.join(workRoot, "system3-source");
  const sourceTreeSha256 = Source.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const sourceOverlay = Resources.apply(sourceRoot, { sourceDir });
  const build = await Fonts.buildProject({ sourceRoot, outputRoot: path.join(workRoot, "system3"), prefix: stack.prefix, sdk: stack.sdk,
    tools: stack.tools, pathMappings, options: ["-DSYSTEM3_SDL_VERSION=2", "-DBUILD_SHARED_LIBS=OFF"], signal, onProgress, dependencies });
  await Source.validatePinnedSource(sourceDir, REVISION, { signal });
  if (Source.hashPinnedFiles(sourceDir, source.files) !== sourceTreeSha256 || overlayIdentity() !== overlaySha256) throw new Error("System3 source or build adapter changed during compilation.");
  const executable = path.join(stack.prefix, "bin/system3");
  return { managerId: "system3", version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, sourceOverlay,
    architecture: "arm64", minimumMacOS: "13.0", executable, executableSha256: Native.hashFile(executable), resources: path.join(stack.prefix, "share/system3"),
    ...build, dependencyClosure: stack };
}

module.exports = { VERSION, REVISION, SOURCE_SHA256, sourcePath, overlayIdentity, buildPortableSystem3 };
