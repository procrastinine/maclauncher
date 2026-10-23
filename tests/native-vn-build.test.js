const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Build = require("../src/modules/shared/runtime/pinned-native-build");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");

function git(root, args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-source-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.14)\nproject(fixture C)\n");
  fs.writeFileSync(path.join(source, ".gitignore"), "ignored.txt\n");
  git(source, ["add", "."]); git(source, ["commit", "-qm", "fixture"]);
  const revision = git(source, ["rev-parse", "HEAD"]);
  return { root, source, revision };
}

test("pinned source verification rejects wrong/dirty revisions and stages tracked files only", async t => {
  const { root, source, revision } = fixture(t);
  const verified = await Build.validatePinnedSource(source, revision);
  fs.writeFileSync(path.join(source, "ignored.txt"), "untracked build input must stay out");
  const stage = path.join(root, "stage");
  const digest = Build.stagePinnedFiles(source, verified.files, stage);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(Build.hashPinnedFiles(source, [...verified.files].reverse()), digest);
  assert.equal(fs.readFileSync(path.join(stage, "CMakeLists.txt"), "utf8"), fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"));
  assert.equal(fs.existsSync(path.join(stage, ".git")), false);
  assert.equal(fs.existsSync(path.join(stage, "ignored.txt")), false);
  await assert.rejects(() => Build.validatePinnedSource(source, "f".repeat(40)), /mismatch/);
  fs.appendFileSync(path.join(source, "CMakeLists.txt"), "# dirty\n");
  await assert.rejects(() => Build.validatePinnedSource(source, revision), /tracked changes/);
  assert.throws(() => Build.stagePinnedFiles(source, ["../outside"], path.join(root, "unsafe")), /Unsafe/);
  assert.throws(() => Build.hashPinnedFiles(source, ["../outside"]), /Unsafe/);
});

test("source staging rejects escaping symlinks", async t => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(root, "outside.h"), "fixture data");
  fs.symlinkSync("../outside.h", path.join(source, "header.h"));
  git(source, ["add", "header.h"]); git(source, ["commit", "-qm", "symlink"]);
  const verified = await Build.validatePinnedSource(source, git(source, ["rev-parse", "HEAD"]));
  assert.throws(() => Build.stagePinnedFiles(source, verified.files, path.join(root, "stage")), /symlink escapes/);
  assert.throws(() => Build.hashPinnedFiles(source, verified.files), /symlink escapes/);
});

test("source build isolates generator and module preparation writes, records both overlays and registers explicit version", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t);
  const manager = createPinnedNativeManager({ id: "fixture-vn", label: "Fixture", catalog: [{ version: "1.0.0", upstreamRevision: revision }] });
  // Resource availability must not prevent an explicit developer build from
  // registering its own exact-version artifact.
  const includedResolution = t.mock.method(manager.core, "resolveInstalled", () => ({ source: "bundled", readOnly: true, removable: false }));
  const userDataDir = path.join(root, "userdata"); const overlay = path.join(root, "overlay.h"); fs.writeFileSync(overlay, "typedef unsigned char Byte;\n");
  const calls = [];
  const dependencies = { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "-S") {
      assert.equal(fs.existsSync(path.join(args[1], ".git")), false);
      assert.match(fs.readFileSync(path.join(args[1], "CMakeLists.txt"), "utf8"), /module-owned source overlay/);
      fs.writeFileSync(path.join(args[1], "generated-file.h"), "only the staged source can change");
      assert.ok(args.includes("-DFETCHCONTENT_FULLY_DISCONNECTED=ON"));
      assert.ok(args.includes("-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"));
      const cFlags = args.filter(arg => arg.startsWith("-DCMAKE_C_FLAGS="));
      assert.equal(cFlags.length, 1);
      assert.match(cFlags[0], /^-DCMAKE_C_FLAGS=-DFIXTURE_COMPILER=1 -ffile-prefix-map=/);
      assert.match(cFlags[0], / -include '/);
    } else {
      fs.mkdirSync(args[1], { recursive: true });
      const binary = Buffer.alloc(32); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(process.arch === "x64" ? 0x01000007 : 0x0100000c, 4); binary.writeUInt32LE(2, 12);
      fs.writeFileSync(path.join(args[1], "runtime"), binary, { mode: 0o755 });
    }
  } };
  const installed = await Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    cmakeOptions: ["-DFIXTURE=ON", "-DCMAKE_C_FLAGS=-DFIXTURE_COMPILER=1 -ffile-prefix-map=/fixture=source"], overlay, prepareSource: ({ sourceRoot, revision: actual, version }) => {
      assert.equal(actual, revision); assert.equal(version, "1.0.0"); assert.notEqual(sourceRoot, source);
      fs.appendFileSync(path.join(sourceRoot, "CMakeLists.txt"), "# module-owned source overlay\n");
      return { revision: "fixture-overlay-v1", operations: ["source compatibility"] };
    }, resolveExecutable: dir => path.join(dir, "runtime"), dependencies });
  assert.equal(calls.length, 2); assert.equal(installed.version, "1.0.0"); assert.equal(installed.provenanceVerified, true);
  assert.equal(installed.verifiedBuild.sourceRevision, revision); assert.match(installed.verifiedBuild.overlaySha256, /^[a-f0-9]{64}$/);
  assert.equal(installed.verifiedBuild.sourceOverlay.revision, "fixture-overlay-v1");
  assert.doesNotMatch(fs.readFileSync(path.join(source, "CMakeLists.txt"), "utf8"), /module-owned source overlay/);
  assert.equal(fs.existsSync(path.join(source, "generated-file.h")), false);
  assert.equal(git(source, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(installed.installDir, "build.lock")), false);
  assert.equal(includedResolution.mock.callCount(), 0); includedResolution.mock.restore();
  assert.equal(manager.core.resolveInstalled({ userDataDir, version: "1.0.0" }).provenanceVerified, true);
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir, resolveExecutable: dir => path.join(dir, "runtime"), dependencies }), /already registered/);
});

test("cancellation in module source preparation runs no compiler and publishes no runtime", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t), userDataDir = path.join(root, "userdata");
  const controller = new AbortController(), manager = createPinnedNativeManager({ id: "fixture-overlay-cancel", label: "Fixture", catalog: [{ version: "1.0.0", upstreamRevision: revision }] });
  await assert.rejects(Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir, signal: controller.signal,
    prepareSource: () => { controller.abort(); return { revision: "cancelled-overlay" }; }, resolveExecutable: dir => path.join(dir, "runtime"),
    dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: () => { throw new Error("Compiler must not run"); } }
  }), error => error.name === "AbortError");
  const installDir = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(installDir, "runtime.json")), false);
  assert.equal(fs.existsSync(path.join(installDir, "build.lock")), false);
  assert.equal(git(source, ["status", "--porcelain"]), "");
});

test("canceling a native command stops its process and reports AbortError", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(Build.runBuildCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root, logPath: path.join(root, "build.log"), signal: controller.signal
    }), error => error.name === "AbortError");
  } finally { clearTimeout(timer); }
});

test("canceling source configure leaves no published runtime and releases its lock", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t), userDataDir = path.join(root, "userdata");
  const controller = new AbortController();
  const manager = createPinnedNativeManager({ id: "fixture-canceled", label: "Fixture", catalog: [{ version: "1.0.0", upstreamRevision: revision }] });
  let calls = 0;
  await assert.rejects(Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    signal: controller.signal, resolveExecutable: dir => path.join(dir, "runtime"),
    dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async () => { calls++; controller.abort(); } }
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
  const directory = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(directory, "runtime.json")), false);
  assert.equal(fs.existsSync(path.join(directory, "build.lock")), false);
  assert.equal(manager.core.resolveInstalled({ userDataDir, version: "1.0.0" }), null);
});

test("a native build timeout cannot succeed when the terminated child exits cleanly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(Build.runBuildCommand(process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    { cwd: root, logPath: path.join(root, "build.log"), timeout: 300 }), /timed out/);
});

test("failed source builds leave no runtime registration and release the build lock", { skip: process.platform !== "darwin" }, async t => {
  const { root, source, revision } = fixture(t); const userDataDir = path.join(root, "userdata");
  const manager = createPinnedNativeManager({ id: "fixture-failed", label: "Fixture", catalog: [{ version: "1.0.0", upstreamRevision: revision }] });
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: source, userDataDir,
    resolveExecutable: dir => path.join(dir, "runtime"), dependencies: { findBuildTool: name => `/fixture/${name}`, runBuildCommand: async () => { throw new Error("missing dependency"); } } }), /missing dependency/);
  const installDir = manager.core.getInstallDir({ userDataDir, version: "1.0.0" });
  assert.equal(fs.existsSync(path.join(installDir, "runtime.json")), false); assert.equal(fs.existsSync(path.join(installDir, "build.lock")), false);
  assert.equal(manager.core.resolveInstalled({ userDataDir, version: "1.0.0" }), null);
  await assert.rejects(() => Build.buildPinnedRuntime({ manager, version: "1.0.0", sourceDir: installDir, userDataDir,
    resolveExecutable: dir => path.join(dir, "runtime") }), /separate directories/);
});
