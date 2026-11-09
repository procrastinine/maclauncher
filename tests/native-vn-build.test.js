const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Build = require("../src/modules/shared/runtime/pinned-native-build");
const { untilTestEnds } = require("./helpers/fixture-process");

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

test("pinned source verification rejects wrong/dirty revisions and hashes tracked files only", async t => {
  const { root, source, revision } = fixture(t);
  const verified = await Build.validatePinnedSource(source, revision);
  fs.writeFileSync(path.join(source, "ignored.txt"), "untracked build input must stay out");
  const digest = Build.hashPinnedFiles(source, verified.files);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(Build.hashPinnedFiles(source, [...verified.files].reverse()), digest);
  assert.deepEqual(verified.files, [".gitignore", "CMakeLists.txt"]);
  await assert.rejects(() => Build.validatePinnedSource(source, "f".repeat(40)), /mismatch/);
  fs.appendFileSync(path.join(source, "CMakeLists.txt"), "# dirty\n");
  await assert.rejects(() => Build.validatePinnedSource(source, revision), /tracked changes/);
  assert.throws(() => Build.hashPinnedFiles(source, ["../outside"]), /Unsafe/);
});

test("source hashing rejects escaping symlinks", async t => {
  const { root, source } = fixture(t);
  fs.writeFileSync(path.join(root, "outside.h"), "fixture data");
  fs.symlinkSync("../outside.h", path.join(source, "header.h"));
  git(source, ["add", "header.h"]); git(source, ["commit", "-qm", "symlink"]);
  const verified = await Build.validatePinnedSource(source, git(source, ["rev-parse", "HEAD"]));
  assert.throws(() => Build.hashPinnedFiles(source, verified.files), /symlink escapes/);
});

test("canceling a native command stops its process and reports AbortError", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(Build.runBuildCommand(process.execPath, ["-e", untilTestEnds], {
      cwd: root, logPath: path.join(root, "build.log"), signal: controller.signal
    }), error => error.name === "AbortError");
  } finally { clearTimeout(timer); }
});

test("a native build timeout cannot succeed when the terminated child exits cleanly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-build-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(Build.runBuildCommand(process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); " + untilTestEnds],
    { cwd: root, logPath: path.join(root, "build.log"), timeout: 300 }), /timed out/);
});

