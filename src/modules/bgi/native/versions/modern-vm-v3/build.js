#!/usr/bin/env node
// Developer-only native diagnosis. Runtime users never need a compiler or SDL.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stageSource, VERSION } = require("./source-overlay");

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`OpenBGI developer build failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function build({ sourceRoot, destination, compiler = "clang", sdlConfig = "sdl2-config", architecture = process.arch === "arm64" ? "arm64" : "x86_64", sanitize = true } = {}) {
  if (process.platform !== "darwin" || !["arm64", "x86_64"].includes(architecture)) throw new Error("OpenBGI startup checks support macOS arm64 and x86_64.");
  if ([compiler, sdlConfig].some(value => typeof value !== "string" || !value || /[\r\n]/.test(value))) throw new Error("Explicit compiler and SDL configuration commands are required.");
  const source = path.join(destination || "", "source");
  if (!path.isAbsolute(destination || "") || fs.existsSync(destination)) throw new Error("Choose a new absolute developer build directory.");
  const prefix = run(sdlConfig, ["--prefix"]);
  const sdlVersion = run(sdlConfig, ["--version"]);
  if (!/^\d+\.\d+\.\d+$/.test(sdlVersion)) throw new Error("An explicit SDL developer version is required.");
  const flags = run(sdlConfig, ["--cflags"]).split(/\s+/).filter(Boolean), libraries = run(sdlConfig, ["--libs"]).split(/\s+/).filter(Boolean);
  if (!path.isAbsolute(prefix) || flags.some(flag => !/^(-I\S+|-D\S+)$/.test(flag)) || libraries.some(flag => !/^(-L\S+|-l\S+|-Wl,\S+|-framework)$/.test(flag)))
    throw new Error("The SDL developer configuration contains unsupported compiler arguments.");
  const receipt = stageSource({ sourceRoot, destination: source });
  const binary = path.join(destination, "openbgi-probe");
  const files = receipt.files.filter(file => /^src\/[^/]+\.c$/.test(file.path)).map(file => path.join(source, file.path));
  const args = ["-std=c11", "-g", "-O1", "-arch", architecture, "-mmacosx-version-min=13.0", "-DSPNG_USE_MINIZ",
    "-I", path.join(source, "src"), "-I", path.join(prefix, "include"), ...flags,
    `-ffile-prefix-map=${destination}=/maclauncher-openbgi`, `-fdebug-prefix-map=${destination}=/maclauncher-openbgi`,
    ...(sanitize ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"] : []), ...files, ...libraries,
    "-framework", "CoreFoundation", "-framework", "CoreGraphics", "-framework", "CoreText", "-liconv", "-lm", "-o", binary];
  run(compiler, args, { cwd: destination });
  const result = { ...receipt, binary, version: VERSION, architecture, sanitized: sanitize,
    sdl: { version: sdlVersion, prefix },
    /* SDL2-compat loads SDL3 before main(). Keep its developer-library
       lookup explicit when a system shell removes inherited DYLD values.
       These paths are a build receipt, never bundled runtime settings. */
    runtimeEnvironment: { DYLD_FALLBACK_LIBRARY_PATH: path.join(prefix, "lib") },
    compilerArguments: args.map(value => value.replaceAll(destination, "${BUILD_DIRECTORY}")),
    mode: "bounded headless startup check" };
  fs.writeFileSync(path.join(destination, "build-receipt.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
if (require.main === module) {
  const [sourceRoot, destination] = process.argv.slice(2);
  try { console.log(JSON.stringify(build({ sourceRoot, destination }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
