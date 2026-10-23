const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Patches = require("../src/modules/mages/native/source-patches");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");

test("dependency patches inside a surrounding Git checkout change the copied source and preserve the outer checkout", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-dependency-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const source = path.join(root, ".local", "build", "ffmpeg");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(root, "codec.txt"), "outer checkout remains intact\n");
  fs.writeFileSync(path.join(source, "codec.txt"), "unpatched decoder\n");
  const patch = "--- a/codec.txt\n+++ b/codec.txt\n@@ -1 +1 @@\n-unpatched decoder\n+patched decoder\n";
  const patchFile = path.join(root, "decoder.patch"); fs.writeFileSync(patchFile, patch);
  const pin = { patchSha256: hash(patch), files: [{ path: "codec.txt", originalSha256: hash("unpatched decoder\n"), adaptedSha256: hash("patched decoder\n") }] };
  const before = execFileSync("git", ["-C", source, "apply", "--check", "--verbose", patchFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(before, ""); // Git exits successfully even though no hunk is applied in this surrounding checkout.
  const result = await Patches.applyPinnedPatch(source, patchFile, pin, { logPath: path.join(root, "build.log") });
  assert.equal(fs.readFileSync(path.join(source, "codec.txt"), "utf8"), "patched decoder\n");
  assert.equal(fs.readFileSync(path.join(root, "codec.txt"), "utf8"), "outer checkout remains intact\n");
  assert.equal(result.patchSha256, pin.patchSha256);
  await assert.rejects(Patches.applyPinnedPatch(source, patchFile, pin, { logPath: path.join(root, "build.log") }), /Pinned dependency source differs/);
});

test("dependency patch execution cannot inherit a caller's Git directory or worktree", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-patch-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Patches.patchEnvironment(root, { PATH: process.env.PATH, GIT_DIR: "/unrelated/repo/.git", GIT_WORK_TREE: "/unrelated/repo", GIT_INDEX_FILE: "/unrelated/index" });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_INDEX_FILE, undefined);
  assert.equal(env.GIT_CEILING_DIRECTORIES, path.dirname(fs.realpathSync(root)));
});
