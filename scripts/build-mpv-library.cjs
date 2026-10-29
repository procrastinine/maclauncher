// Build the managed libmpv adapter from an exact upstream export and owned overlays.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const REVISION = "41f6a645068483470267271e1d09966ca3b9f413";
const BACKPORTS = ["75b2ccfeb1ce4ed5a40ac9860fa74f3d1265e13f", "c5d391adba7bd024954d0df1e0405f5749f4d4ca"];
const PATCHES = ["mpv-frame-metadata.patch", "mpv-render-layers.patch"];
const OPTIONS = ["--buildtype=release", "--wrap-mode=nofallback", "-Dlibmpv=true", "-Dcplayer=false",
  "-Dbuild-date=false", "-Dtests=false", "-Dmanpage-build=disabled", "-Dhtml-build=disabled", "-Dpdf-build=disabled",
  "-Dgl=enabled", "-Dplain-gl=enabled", "-Dvideotoolbox-gl=enabled", "-Dlua=luajit", "-Djavascript=enabled",
  "-Dswift-build=enabled", "-Dcocoa=enabled", "-Dgl-cocoa=enabled", "-Dmacos-cocoa-cb=disabled", "-Dvulkan=disabled"];
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function build({ sourceCheckout, workDirectory, pkgConfigPath, toolsDirectory, minimumMacOS = "27.0", jobs = 6, dependencyInputs = [], reuse = false }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The managed video library requires an Apple Silicon Mac.");
  if (![sourceCheckout, workDirectory, toolsDirectory].every(value => typeof value === "string" && path.isAbsolute(value)) || !/^\d+\.\d+$/.test(minimumMacOS))
    throw new Error("Choose absolute source, build and isolated build-tool folders, and a macOS deployment target.");
  const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (run("git", ["-C", sourceCheckout, "rev-parse", "HEAD"]).trim() !== REVISION || run("git", ["-C", sourceCheckout, "status", "--porcelain", "--untracked-files=no"]).trim())
    throw new Error("Initialize the exact clean mpv source checkout.");
  const root = path.resolve(__dirname, ".."), patches = PATCHES.map(file => ({ file: path.join(root, "src/modules/video/native", file), name: file }));
  const source = path.join(workDirectory, "source"), output = path.join(workDirectory, "build");
  const sourceInputs = { revision: REVISION, backports: BACKPORTS, patches: patches.map(patch => ({ path: patch.name, sha256: hash(patch.file) })) };
  const sourceRecord = path.join(workDirectory, "source-inputs.json");
  const exists = fs.existsSync(workDirectory);
  if (exists && !reuse) throw new Error("Choose a new library build folder or explicitly reuse its source cache.");
  const previous = exists ? JSON.parse(fs.readFileSync(sourceRecord, "utf8")) : null;
  if (!exists || JSON.stringify(previous) !== JSON.stringify(sourceInputs)) {
    if (exists) fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    run("/usr/bin/tar", ["-xf", "-", "-C", source], { input: execFileSync("git", ["-C", sourceCheckout, "archive", REVISION], { maxBuffer: 64 * 1024 * 1024 }) });
    const applyEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: workDirectory };
    const apply = input => {
      const result = spawnSync("git", ["apply", "--verbose", "-"], { cwd: source, env: applyEnvironment, input, encoding: "utf8" });
      if (result.error || result.status !== 0 || /Skipped patch/i.test(result.stderr))
        throw result.error || new Error("The media source overlay was not applied: " + result.stderr.trim());
    };
    for (const revision of BACKPORTS) apply(run("git", ["-C", sourceCheckout, "format-patch", "-1", "--stdout", revision], { env: applyEnvironment }));
    for (const patch of patches) apply(fs.readFileSync(patch.file));
    fs.writeFileSync(sourceRecord, JSON.stringify(sourceInputs, null, 2) + "\n");
  }
  const env = { ...process.env, PATH: toolsDirectory + path.delimiter + process.env.PATH,
    MACOSX_DEPLOYMENT_TARGET: minimumMacOS, CLANG_MODULE_CACHE_PATH: path.join(workDirectory, "module-cache"),
    ...(pkgConfigPath ? { PKG_CONFIG_PATH: pkgConfigPath } : {}) };
  const cflags = [`-mmacosx-version-min=${minimumMacOS}`, `-ffile-prefix-map=${source}=.`, `-ffile-prefix-map=${output}=.`];
  const meson = path.join(toolsDirectory, "meson"), ninja = path.join(toolsDirectory, "ninja");
  run(meson, ["setup", ...(fs.existsSync(path.join(output, "meson-private/coredata.dat")) ? ["--reconfigure"] : []), output, source, ...OPTIONS,
    "-Dc_args=" + JSON.stringify(cflags), "-Dobjc_args=" + JSON.stringify(cflags), "-Dc_link_args=-mmacosx-version-min=" + minimumMacOS,
    "-Dswift-flags=-file-prefix-map " + source + "=. -file-prefix-map " + output + "=."] , { env, stdio: "inherit" });
  run(ninja, ["-C", output, "-j", String(Math.max(1, Math.min(32, Number(jobs) || 6))), "libmpv.2.dylib"], { env, stdio: "inherit" });
  const library = path.join(output, "libmpv.2.dylib");
  if (!fs.statSync(library).isFile()) throw new Error("The managed media library was not produced.");
  // Remove compiler debug records, including Swift module locations. Loader
  // paths are normalized later by the existing runtime staging recipe.
  run("/usr/bin/strip", ["-S", library]);
  const metadata = { schema: 1, repository: "https://github.com/mpv-player/mpv.git", revision: REVISION, backports: BACKPORTS,
    patches: patches.map(patch => ({ path: "src/modules/video/native/" + patch.name, sha256: hash(patch.file) })),
    options: OPTIONS, minimumMacOS, architecture: "arm64", meson: run(meson, ["--version"], { env }).trim(), ninja: run(ninja, ["--version"], { env }).trim(),
    dependencies: ["libass", "libplacebo", "libavcodec", "libavformat", "libavfilter", "libavutil", "libswscale", "libswresample", "luajit", "mujs"].map(name => ({ name, version: run("pkg-config", ["--modversion", name], { env }).trim() })),
    dependencyInputs: Array.isArray(dependencyInputs) ? dependencyInputs : dependencyInputs.dependencies || [], librarySha256: hash(library) };
  fs.writeFileSync(path.join(workDirectory, "libmpv-build.json"), JSON.stringify(metadata, null, 2) + "\n");
  return { library, metadata };
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") throw new Error("Use --config /absolute/library-build.json.");
  try { console.log(JSON.stringify(build(JSON.parse(fs.readFileSync(args[1], "utf8"))))); }
  catch (error) { console.error(error.message);process.exitCode = 1; }
}
module.exports = { build, REVISION, BACKPORTS, PATCHES, OPTIONS };
