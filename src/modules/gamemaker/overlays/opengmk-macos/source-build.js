#!/usr/bin/env node
// Developer-only corresponding-source build. Reviewed immutable runtimes run
// directly from app resources; users need no compiler or source checkout.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { applyRamenOverlay } = require("./apply-ramen");
const { applyAudioOverlay } = require("./apply-audio");
const { applyEmulatorOverlay } = require("./apply-emulator");
const { REVISION } = require("./apply-emulator");
const TARGETS = Object.freeze({ gm8emulator: "13.0", gm8decompiler: "11.0" });
const DECOMPILER_SOURCE_HASHES = Object.freeze({
  "Cargo.toml": "dfc0b51bec4aff12670d09bbb1f921f87ba1c04eca3696c6eedf36914389eabc",
  "gm8decompiler/Cargo.toml": "3ca5cd75456d962137a464cf48c7a92ac8b01b1bbb24cf3052514dd7b7a0d147",
  "gm8decompiler/build.rs": "c15896a7bd1e95ff75fcb7feb2e417598680f13b42f18309829dc0b6fb1cad03"
});
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function copySourceTree(source, destination) {
  fs.cpSync(source, destination, { recursive: true, filter: file => {
    if ([".git", "target"].includes(path.basename(file))) return false;
    if (fs.lstatSync(file).isSymbolicLink()) throw Error("Corresponding build source must contain regular files and directories, not writable aliases.");
    return true;
  } });
}
function prepareDecompiler({ sourceDir, output }) {
  if (!path.isAbsolute(sourceDir || "") || !path.isAbsolute(output || "")) throw Error("Decompiler overlay paths must be absolute.");
  const source = fs.realpathSync(sourceDir), owned = fs.realpathSync(output);
  const externalPath = path.resolve(__dirname, "../../../../external");
  const external = fs.existsSync(externalPath) ? fs.realpathSync(externalPath) : externalPath;
  if (!source.startsWith(owned + path.sep) || source === external || source.startsWith(external + path.sep))
    throw Error("Apply the decompiler workspace overlay to a new owned source copy, outside vendored sources.");
  for (const [file, expected] of Object.entries(DECOMPILER_SOURCE_HASHES)) {
    const input = path.join(source, file), stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(fs.readFileSync(input)) !== expected)
      throw Error(`OpenGMK ${REVISION} decompiler source identity differs at ${file}; no source was patched.`);
  }
  const patch = path.join(__dirname, "decompiler-workspace.patch");
  for (const args of [["apply", "--no-index", "--check", patch], ["apply", "--no-index", patch]]) {
    const applied = spawnSync("git", args, { cwd: sourceDir, encoding: "utf8", timeout: 20000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(sourceDir) } });
    if (applied.error) throw applied.error;
    if (applied.status !== 0) throw Error(`The pinned decompiler workspace patch failed: ${applied.stderr || applied.stdout}`);
  }
  if (fs.readFileSync(path.join(sourceDir, "Cargo.toml"), "utf8").includes('    "gm8emulator",') ||
      fs.readFileSync(path.join(sourceDir, "gm8decompiler/Cargo.toml"), "utf8").includes('winres = "0.1"'))
    throw Error("The decompiler workspace patch did not change the owned source copy.");
  // Preserve upstream build.rs while supplying its exact upstream identity.
  // Otherwise `git rev-parse` can accidentally identify MacLauncher's parent
  // repository when compiling an archive that intentionally has no .git.
  const tools = path.join(output, "tools"); fs.mkdirSync(tools);
  const shim = "#!/usr/bin/env node\n" +
    `const { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\n` +
    `if (JSON.stringify(args) === '["rev-parse","--short","HEAD"]') process.stdout.write(${JSON.stringify(REVISION.slice(0, 7) + "\n")});\n` +
    `else { const result = spawnSync("/usr/bin/git", args, { stdio: "inherit" }); if (result.error) throw result.error; process.exitCode = result.status == null ? 1 : result.status; }\n`;
  fs.writeFileSync(path.join(tools, "git"), shim, { mode: 0o755 });
  fs.writeFileSync(path.join(sourceDir, "maclauncher-overlay.json"), JSON.stringify({ schemaVersion: 1,
    upstreamRevision: REVISION, target: "gm8decompiler", sourceHashes: DECOMPILER_SOURCE_HASHES,
    workspaceOverlaySha256: digest(fs.readFileSync(patch)), gitMetadataShimSha256: digest(Buffer.from(shim)),
    upstreamRustUnmodified: true, buildDate: "upstream-current-UTC-date" }, null, 2) + "\n");
  return tools;
}

function prepareSourceBuild({ packageRoot, outputRoot, target = "gm8emulator" }) {
  if (!Object.hasOwn(TARGETS, target)) throw Error("Choose gm8emulator or gm8decompiler explicitly.");
  const source = fs.realpathSync(packageRoot), requested = path.resolve(outputRoot);
  const parent = fs.realpathSync(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (output === source || output.startsWith(source + path.sep) || fs.existsSync(output)) throw Error("Use a new owned build directory outside the corresponding-source package.");
  if (parent === source || parent.startsWith(source + path.sep)) throw Error("Build outside the source package.");
  if (target === "gm8decompiler") for (const [file, expected] of Object.entries(DECOMPILER_SOURCE_HASHES)) {
    const input = path.join(source, "OpenGMK", file);
    if (!fs.lstatSync(input).isFile() || fs.lstatSync(input).isSymbolicLink() || digest(fs.readFileSync(input)) !== expected)
      throw Error(`OpenGMK ${REVISION} decompiler source identity differs at ${file}; no build was prepared.`);
  }
  fs.mkdirSync(output);
  const sourceDir = path.join(output, "source"), ramenDir = path.join(output, "ramen"), soundioDir = path.join(output, "audio"), udonDir = path.join(output, "udon");
  copySourceTree(path.join(source, "OpenGMK"), sourceDir);
  let tools;
  if (target === "gm8decompiler") tools = prepareDecompiler({ sourceDir, output });
  else {
    applyRamenOverlay({ sourceDir: path.join(source, "dependencies/ramen"), destination: ramenDir });
    applyAudioOverlay({ sourceDir: path.join(source, "dependencies/udon/libsoundio-sys"), destination: soundioDir });
    applyEmulatorOverlay({ sourceDir, ramenDir, soundioDir });
    copySourceTree(path.join(source, "dependencies/udon"), udonDir);
    const manifest = path.join(udonDir, "Cargo.toml"), original = fs.readFileSync(manifest, "utf8");
    if (!original.includes('libsoundio-sys = { path = "./libsoundio-sys" }')) throw Error("Pinned udon build context changed.");
    fs.writeFileSync(manifest, original.replace('libsoundio-sys = { path = "./libsoundio-sys" }', `libsoundio-sys = { path = ${JSON.stringify(soundioDir)} }`));
    const workspace = path.join(sourceDir, "Cargo.toml");
    fs.appendFileSync(workspace, `udon = { path = ${JSON.stringify(udonDir)} }\n`);
  }
  fs.copyFileSync(path.join(source, "Cargo.lock"), path.join(sourceDir, "Cargo.lock"));
  fs.mkdirSync(path.join(sourceDir, ".cargo"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, ".cargo/config.toml"), `[source.crates-io]\nreplace-with = "corresponding-source"\n[source.corresponding-source]\ndirectory = ${JSON.stringify(path.join(source, "registry"))}\n`);
  const maps = [[source, "/corresponding-source"], [output, "/maclauncher-opengmk"]];
  const cFlags = maps.flatMap(([from, to]) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${from}=${to}`)).join(" ");
  return { sourceDir, target, environment: { MACOSX_DEPLOYMENT_TARGET: TARGETS[target], CARGO_TARGET_DIR: path.join(output, "target"),
    ...(tools ? { PATH: [tools, process.env.PATH || ""].join(path.delimiter) } : {}),
    RUSTFLAGS: maps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join(" "), CFLAGS: cFlags, CXXFLAGS: cFlags } };
}
if (require.main === module) {
  if (![4, 5].includes(process.argv.length)) throw Error("Usage: node maclauncher-overlay/source-build.js SOURCE_PACKAGE NEW_BUILD_DIRECTORY [gm8emulator|gm8decompiler]");
  const prepared = prepareSourceBuild({ packageRoot: process.argv[2], outputRoot: process.argv[3], target: process.argv[4] });
  const result = spawnSync(process.env.MACLAUNCHER_CARGO || "cargo", ["+stable", "build", "--offline", "--release", "-p", prepared.target],
    { cwd: prepared.sourceDir, env: { ...process.env, ...prepared.environment }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}
module.exports = { prepareSourceBuild, prepareDecompiler, TARGETS, DECOMPILER_SOURCE_HASHES };
