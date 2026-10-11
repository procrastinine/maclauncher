const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { prepareSourceBuild, DECOMPILER_SOURCE_HASHES } = require("../src/modules/gamemaker/overlays/opengmk-macos/source-build");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "opengmk-offline-recipe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package"), outputRoot = path.join(root, "build");
  for (const file of Object.keys(DECOMPILER_SOURCE_HASHES)) {
    const destination = path.join(packageRoot, "OpenGMK", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "../src/external/OpenGMK", file), destination);
  }
  fs.writeFileSync(path.join(packageRoot, "Cargo.lock"), "# immutable source package lock\n");
  fs.mkdirSync(path.join(packageRoot, "registry"));
  return { root, packageRoot, outputRoot };
}

test("the decompiler recipe isolates its workspace and preserves upstream Rust while reporting its actual source revision", t => {
  const f = fixture(t), originalBuild = fs.readFileSync(path.join(f.packageRoot, "OpenGMK/gm8decompiler/build.rs"));
  // Real development builds often live below the launcher's Git worktree.
  // git apply must not silently skip paths relative to that parent repository.
  const parentGit = spawnSync("git", ["init", "-q", f.root], { encoding: "utf8" });
  assert.equal(parentGit.status, 0, parentGit.stderr);
  const prepared = prepareSourceBuild({ ...f, target: "gm8decompiler" });
  assert.equal(prepared.target, "gm8decompiler");
  assert.equal(prepared.environment.MACOSX_DEPLOYMENT_TARGET, "11.0");
  assert.equal(fs.existsSync(path.join(f.outputRoot, "ramen")), false);
  assert.match(fs.readFileSync(path.join(f.packageRoot, "OpenGMK/Cargo.toml"), "utf8"), /"gm8emulator"/);
  assert.doesNotMatch(fs.readFileSync(path.join(prepared.sourceDir, "Cargo.toml"), "utf8"), /"gm8emulator"/);
  assert.doesNotMatch(fs.readFileSync(path.join(prepared.sourceDir, "gm8decompiler/Cargo.toml"), "utf8"), /winres/);
  assert.deepEqual(fs.readFileSync(path.join(prepared.sourceDir, "gm8decompiler/build.rs")), originalBuild);
  const gitMetadata = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: prepared.sourceDir,
    env: { ...process.env, ...prepared.environment }, encoding: "utf8" });
  assert.equal(gitMetadata.status, 0, gitMetadata.stderr); assert.equal(gitMetadata.stdout, "9ccc47a\n");
  assert.match(fs.readFileSync(path.join(prepared.sourceDir, ".cargo/config.toml"), "utf8"), /corresponding-source/);
  const metadata = JSON.parse(fs.readFileSync(path.join(prepared.sourceDir, "maclauncher-overlay.json")));
  assert.equal(metadata.upstreamRustUnmodified, true); assert.match(metadata.gitMetadataShimSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(f.packageRoot, "OpenGMK/maclauncher-overlay.json")), false);
});

test("unlisted targets, changed pinned source and source-relative outputs fail before preparing a build", t => {
  const f = fixture(t);
  assert.throws(() => prepareSourceBuild({ ...f, target: "unknown" }), /gm8emulator or gm8decompiler/);
  assert.equal(fs.existsSync(f.outputRoot), false);
  assert.throws(() => prepareSourceBuild({ ...f, outputRoot: path.join(f.packageRoot, "owned"), target: "gm8decompiler" }), /outside/);
  assert.equal(fs.existsSync(path.join(f.packageRoot, "owned")), false);
  fs.appendFileSync(path.join(f.packageRoot, "OpenGMK/gm8decompiler/Cargo.toml"), "# changed upstream input\n");
  assert.throws(() => prepareSourceBuild({ ...f, target: "gm8decompiler" }), /source identity differs/);
  assert.equal(fs.existsSync(f.outputRoot), false);
});
