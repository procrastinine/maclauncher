const fs = require("node:fs");
const path = require("node:path");
const Native = require("../shared/runtime/local-native");
const Build = require("../shared/runtime/pinned-native-build");
const { throwIfAborted } = require("../shared/runtime/download-utils");

const VERSION = "snapshot-04333ad-macos-v1";
const REVISION = "04333ad689d7e517a93d58141bb214c19ba16129";
const sourcePath = path.resolve(__dirname, "../../external/xsystem4");
const building = new Set();

function replaceSource(file, before, after) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(before)) throw new Error(`Pinned xsystem4 overlay does not match ${path.basename(file)}.`);
  fs.writeFileSync(file, text.replace(before, after));
}

function adaptSource(root, version) {
  // Apple exposes desktop OpenGL through a framework and requires a 3.2 core
  // context. Changes are applied only to the isolated tracked-source copy.
  replaceSource(path.join(root, "meson.build"), "gl = dependency('GL')", "gl = dependency('appleframeworks', modules : ['OpenGL'])");
  for (const name of ["libavcodec", "libavformat", "libavutil", "libswscale"]) {
    const file = path.join(root, "meson.build");
    const text = fs.readFileSync(file, "utf8");
    const pattern = new RegExp(`(dependency\\('${name}'[^\\n]*required:) false`);
    if (!pattern.test(text)) throw new Error("Pinned xsystem4 FFmpeg dependency overlay does not match.");
    fs.writeFileSync(file, text.replace(pattern, "$1 get_option('ffmpeg')"));
  }
  fs.appendFileSync(path.join(root, "meson_options.txt"), "\noption('ffmpeg', type : 'feature', value : 'disabled', description : 'Optional FFmpeg movie formats')\n");
  replaceSource(path.join(root, "src/meson.build"), "fallback : 'unknown version'", `fallback : '${version}'`);
  const video = path.join(root, "src/video.c");
  replaceSource(video, '"#version 140\\n"', '"#version 150\\n"');
  replaceSource(video, "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);", "SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 2);");
  replaceSource(video, "GLchar *source = SDL_LoadFile(path, NULL);", `// Prefer the runtime's own shader assets over similarly named game files.
\tchar portable_path[PATH_MAX];
\tchar *base_path = SDL_GetBasePath();
\tGLchar *source = NULL;
\tif (base_path) {
\t\tsnprintf(portable_path, PATH_MAX, "%s../share/xsystem4/%s", base_path, path);
\t\tsource = SDL_LoadFile(portable_path, NULL);
\t\tSDL_free(base_path);
\t}
\tif (!source) source = SDL_LoadFile(path, NULL);`);
}

async function buildManagedSystem4({ manager, version, sourceDir = sourcePath, userDataDir, logger, signal, onProgress, dependencies = {} }) {
  throwIfAborted(signal);
  if (process.platform !== "darwin") throw new Error("xsystem4 source builds require macOS.");
  const normalized = manager.core.normalizeVersion(version);
  if (normalized === "snapshot-04333ad-macos-v2") throw new Error("This version uses the portable source recipe. Use buildPortableSystem4 with its pinned dependency archives.");
  const pin = manager.core.catalog.find(row => row.version === normalized);
  if (pin?.upstreamRevision !== REVISION) throw new Error("This xsystem4 revision has no reviewed Mac build overlay.");
  const installDir = manager.core.getInstallDir({ userDataDir, version: normalized });
  if (building.has(installDir)) throw new Error("This xsystem4 version is already building.");
  if (fs.existsSync(path.join(installDir, "runtime.json"))) throw new Error("This runtime version is already registered. Remove it before rebuilding.");
  if (!path.isAbsolute(sourceDir) || installDir === sourceDir || installDir.startsWith(sourceDir + path.sep) || sourceDir.startsWith(installDir + path.sep)) throw new Error("Source checkout and runtime installation must be separate absolute directories.");
  building.add(installDir);
  let lock;
  try {
    const source = await Build.validatePinnedSource(sourceDir, REVISION, { signal });
    const tool = dependencies.findBuildTool || Build.findBuildTool;
    const meson = tool("meson"), ninja = tool("ninja");
    // Explicit tool discovery; no package manager or network is invoked.
    const kegTool = name => {
      for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
        const candidate = path.join(prefix, name, "bin", name);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
      }
      return tool(name);
    };
    const bison = kegTool("bison"), flex = kegTool("flex");
    fs.mkdirSync(installDir, { recursive: true });
    lock = fs.openSync(path.join(installDir, "build.lock"), "wx");
    const staged = path.join(installDir, "build-source"), output = path.join(installDir, "build-output"), payload = path.join(installDir, "payload");
    for (const target of [staged, output, payload]) fs.rmSync(target, { recursive: true, force: true });
    const sourceTreeSha256 = Build.stagePinnedFiles(sourceDir, source.files, staged);
    adaptSource(staged, normalized);
    const overlaySha256 = Native.hashFile(__filename);
    const options = ["--wrap-mode=nodownload", "--buildtype=release", "-Dopengles=disabled", "-Ddebugger=disabled", "-Dffmpeg=disabled", `--prefix=${payload}`];
    const logPath = path.join(installDir, "build.log");
    fs.writeFileSync(logPath, `Pinned xsystem4 ${REVISION}\nSource SHA-256 ${sourceTreeSha256}\nOverlay SHA-256 ${overlaySha256}\n`);
    // Staged source has no .git; prevent vcs_tag from inheriting a surrounding
    // launcher's repository/tag instead of the explicit version fallback.
    const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0", HOMEBREW_NO_AUTO_UPDATE: "1", GIT_CEILING_DIRECTORIES: installDir,
      PATH: [...new Set([path.dirname(bison), path.dirname(flex), path.dirname(meson), path.dirname(ninja), "/opt/homebrew/opt/bison/bin", "/opt/homebrew/opt/flex/bin", "/opt/homebrew/bin", "/usr/local/bin", ...String(process.env.PATH || "").split(path.delimiter)])].join(path.delimiter) };
    const run = dependencies.runBuildCommand || Build.runBuildCommand;
    logger?.info?.(`[runtime] build xsystem4 ${normalized}; ${logPath}`);
    onProgress?.({ downloaded: 1, total: 4 });
    await run(meson, ["setup", output, staged, ...options], { cwd: installDir, logPath, env, signal });
    onProgress?.({ downloaded: 2, total: 4 });
    await run(ninja, ["-C", output, "-j6"], { cwd: installDir, logPath, env, signal });
    await run(meson, ["install", "-C", output, "--no-rebuild"], { cwd: installDir, logPath, env, signal });
    throwIfAborted(signal);
    onProgress?.({ downloaded: 3, total: 4 });
    await Build.validatePinnedSource(sourceDir, REVISION, { signal });
    const runtimePath = path.join(payload, "bin/xsystem4");
    const verifiedBuild = { sourceRevision: REVISION, sourceTreeSha256, overlaySha256, configureOptions: options,
      compilerPlatform: "darwin", hostArch: process.arch, deploymentTarget: "13.0", logPath };
    const installed = manager.core.registerLocal({ userDataDir, version: normalized, runtimePath, verifiedBuild });
    onProgress?.({ downloaded: 4, total: 4 });
    return { ...installed, logPath, verifiedBuild };
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(path.join(installDir, "build.lock"), { force: true }); }
    building.delete(installDir);
  }
}

module.exports = { VERSION, REVISION, sourcePath, adaptSource, buildManagedSystem4 };
