const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Build = require("../../shared/runtime/pinned-native-build");

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function patchEnvironment(sourceDir, inherited = process.env) {
  const env = { ...inherited, GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: path.dirname(fs.realpathSync(sourceDir)) };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[name];
  return env;
}

async function applyPinnedPatch(sourceDir, patchFile, pin, { logPath, signal, env } = {}) {
  if (fs.existsSync(path.join(sourceDir, ".git"))) throw new Error("Apply native dependency patches only to an owned source copy.");
  if (hash(patchFile) !== pin.patchSha256) throw new Error("Native dependency patch differs from its pinned SHA-256.");
  for (const file of pin.files) {
    if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === ".." || part === ".git")) throw new Error("Unsafe native dependency patch path.");
    const target = path.join(sourceDir, file.path);
    if (file.originalSha256 === null ? fs.existsSync(target) : hash(target) !== file.originalSha256) {
      throw new Error(`Pinned dependency source differs: ${file.path}.`);
    }
  }
  // A copied source tree can sit inside the launcher's Git checkout. Without
  // this boundary git apply can silently skip every hunk and still exit zero.
  const options = { cwd: sourceDir, logPath, signal, env: patchEnvironment(sourceDir, env) };
  const git = Build.findBuildTool("git");
  await Build.runBuildCommand(git, ["apply", "--check", patchFile], options);
  await Build.runBuildCommand(git, ["apply", patchFile], options);
  for (const file of pin.files) {
    if (hash(path.join(sourceDir, file.path)) !== file.adaptedSha256) throw new Error(`Native dependency patch was not applied: ${file.path}.`);
  }
  return { patchSha256: pin.patchSha256, files: pin.files };
}

module.exports = { patchEnvironment, applyPinnedPatch };
