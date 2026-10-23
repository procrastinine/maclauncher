const fs = require("node:fs");
const path = require("node:path");
const Build = require("../pinned-native-build");
const Native = require("../local-native");
const Bundle = require("../bundled-native");
const Overlay = require("./source-overlay");
const Dependencies = require("./dependencies.json");
const { throwIfAborted } = require("../download-utils");

function validateDependencyArchives(directory) {
  if (!path.isAbsolute(directory || "")) throw new Error("Provide an absolute directory containing the pinned dependency source archives.");
  return Dependencies.map(dependency => {
    const file = path.join(directory, `${dependency.name}.tar.gz`), bytes = Bundle.readRegular(file, dependency.bytes);
    if (bytes.size !== dependency.bytes || bytes.sha256 !== dependency.sha256) throw new Error(`Steam API dependency source changed: ${dependency.name}`);
    return { ...dependency, file };
  });
}

function diagnosticFlags(directory) {
  const paths = [...new Set([path.resolve(directory), fs.realpathSync(directory)])];
  return paths.flatMap(value => ["-ffile-prefix-map=" + value + "=/maclauncher/native/steamworks",
    "-fdebug-prefix-map=" + value + "=/maclauncher/native/steamworks"]);
}

/** Developer/release build. All inputs are local and pinned; no network calls. */
async function buildSteamApi({ workDir, sourceDir = path.resolve(__dirname, "../../../../external/goldberg-mac"),
  dependencyArchivesDir, abseilSourceDir, signal, onProgress } = {}) {
  if (process.platform !== "darwin") throw new Error("The native Steam API helper requires a macOS build host.");
  const source = await Build.validatePinnedSource(sourceDir, Overlay.SOURCE_REVISION, { signal });
  const abseil = await Build.validatePinnedSource(abseilSourceDir, Overlay.ABSEIL_REVISION, { signal });
  const archives = validateDependencyArchives(dependencyArchivesDir);
  if (!path.isAbsolute(workDir || "")) throw new Error("An absolute, empty owned build directory is required.");
  const root = path.resolve(workDir);
  for (const input of [sourceDir, abseilSourceDir, dependencyArchivesDir].map(value => path.resolve(value))) {
    if (root === input || root.startsWith(input + path.sep) || input.startsWith(root + path.sep)) throw new Error("Steam API build storage must be separate from its read-only inputs.");
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error("Steam API build storage must be empty; existing artifacts were preserved.");
  Bundle.realDirectory(root, { create: true });
  const sourceRoot = path.join(root, "source"), abseilRoot = path.join(root, "abseil-source");
  const sourceTreeSha256 = Build.stagePinnedFiles(sourceDir, source.files, sourceRoot);
  const abseilTreeSha256 = Build.stagePinnedFiles(abseilSourceDir, abseil.files, abseilRoot);
  const sourceOverlay = Overlay.applySourceOverlay(sourceRoot);
  const logPath = path.join(root, "build.log");
  const env = { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: "1", HOMEBREW_NO_AUTO_UPDATE: "1" };
  const run = (tool, args) => Build.runBuildCommand(tool.includes(path.sep) ? tool : Build.findBuildTool(tool), args,
    { cwd: root, env, logPath, signal, timeout: 60 * 60 * 1000 });
  const dependenciesRoot = path.join(sourceRoot, "build_mac/deps");
  const dependenciesSource = path.join(dependenciesRoot, "src");
  fs.mkdirSync(dependenciesSource, { recursive: true });
  for (const archive of archives) {
    throwIfAborted(signal);
    const temporary = path.join(dependenciesSource, ".extract-" + archive.name);
    fs.mkdirSync(temporary);
    // Exact source SHA-256 is checked above, before extraction in owned storage.
    await run("/usr/bin/tar", ["-xzf", archive.file, "-C", temporary]);
    const children = fs.readdirSync(temporary);
    const destination = path.join(dependenciesSource, archive.name);
    if (children.length === 1 && fs.lstatSync(path.join(temporary, children[0])).isDirectory()) {
      fs.renameSync(path.join(temporary, children[0]), destination); fs.rmdirSync(temporary);
    } else fs.renameSync(temporary, destination);
  }
  onProgress?.({ stage: "dependencies", completed: 1, total: 3 });
  const flags = diagnosticFlags(root).map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(" ");
  const cmake = Build.findBuildTool("cmake"), ninja = Build.findBuildTool("ninja");
  const common = ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${ninja}`, "-DARCHS=arm64;x86_64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0", "-DCMAKE_SKIP_RPATH=TRUE",
    `-DCMAKE_C_FLAGS=${flags}`, `-DCMAKE_CXX_FLAGS=${flags}`];
  const dependenciesOutput = path.join(dependenciesRoot, "build");
  await run(cmake, ["-S", dependenciesRoot, "-B", dependenciesOutput, ...common, `-DMACLAUNCHER_ABSEIL_SOURCE_DIR=${abseilRoot}`]);
  await run(cmake, ["--build", dependenciesOutput, "--parallel", "1"]);
  onProgress?.({ stage: "library", completed: 2, total: 3 });
  const outputRoot = path.join(sourceRoot, "build_mac/build");
  await run(cmake, ["-S", path.join(sourceRoot, "build_mac"), "-B", outputRoot, ...common,
    "-DCMAKE_BUILD_TYPE=Release", `-DDEPS_PREFIX=${path.join(dependenciesRoot, "install")}`]);
  await run(cmake, ["--build", outputRoot, "--parallel", "2"]);
  const library = path.join(outputRoot, "libsteam_api.dylib");
  if (JSON.stringify(Native.readMachOArchitectures(library, { allowLibrary: true }).sort()) !== JSON.stringify(["arm64", "x86_64"])) {
    throw new Error("Steam API build did not produce both supported Mac architectures.");
  }
  await run("/usr/bin/codesign", ["--force", "--sign", "-", library]);
  await run("/usr/bin/codesign", ["--verify", "--strict", library]);
  await Build.validatePinnedSource(sourceDir, Overlay.SOURCE_REVISION, { signal });
  await Build.validatePinnedSource(abseilSourceDir, Overlay.ABSEIL_REVISION, { signal });
  const result = { version: Overlay.VERSION, library, sourceRevision: Overlay.SOURCE_REVISION, sourceTreeSha256,
    sourceOverlay, abseilRevision: Overlay.ABSEIL_REVISION, abseilTreeSha256, dependenciesRevision: Overlay.DEPENDENCIES_REVISION,
    dependencies: Dependencies, binarySha256: Native.hashFile(library), architectures: ["arm64", "x86_64"], logPath,
    qualification: "Build only; legacy ABI and original game input tests are required before distribution." };
  fs.writeFileSync(path.join(root, "build-record.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  onProgress?.({ stage: "built", completed: 3, total: 3 });
  return result;
}

module.exports = { validateDependencyArchives, diagnosticFlags, buildSteamApi };
