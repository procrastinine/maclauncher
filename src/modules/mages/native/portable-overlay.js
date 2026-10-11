const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");

const FILE = "src/subtitle/subtitlesystem.cpp";
const ORIGINAL_SHA256 = "8fb5ed8321336e5f44549b734d72dcb57267349c56712a85b5ff15a11d17e23a";
const ADAPTED_SHA256 = "367e94720f3781153b8ec0b0500768b2b84f7bd2f52f006f9eea2cf4929fee2e";
const BEFORE = "#ifndef IMPACTO_DISABLE_ASS\n";
const AFTER = "#ifndef IMPACTO_DISABLE_LIBASS\n";

function applyPortableOverlay(sourceRoot) {
  const externalPath = path.resolve(__dirname, "../../../external");
  const external = fs.existsSync(externalPath) ? fs.realpathSync(externalPath) : externalPath;
  if (!path.isAbsolute(sourceRoot || "") || fs.lstatSync(sourceRoot).isSymbolicLink() || !fs.lstatSync(sourceRoot).isDirectory() ||
      fs.existsSync(path.join(sourceRoot, ".git"))) throw new Error("Impacto source adapters require a separate source export.");
  const root = fs.realpathSync(sourceRoot);
  if (root === external || root.startsWith(external + path.sep)) throw new Error("Impacto source adapters cannot change external checkouts.");
  const target = path.join(root, FILE), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || Native.hashFile(target) !== ORIGINAL_SHA256) {
    throw new Error("Impacto subtitle source checksum differs from its pinned revision.");
  }
  const text = fs.readFileSync(target, "utf8");
  if (text.indexOf(BEFORE) < 0 || text.indexOf(BEFORE) !== text.lastIndexOf(BEFORE)) throw new Error("Impacto subtitle include guard differs.");
  fs.writeFileSync(target, text.replace(BEFORE, AFTER));
  if (Native.hashFile(target) !== ADAPTED_SHA256) throw new Error("Impacto subtitle adapter checksum differs.");
  return { files: [{ path: FILE, originalSha256: ORIGINAL_SHA256, adaptedSha256: Native.hashFile(target) }],
    behavior: "Use the configured libass feature guard for its optional header" };
}

module.exports = { FILE, ORIGINAL_SHA256, ADAPTED_SHA256, BEFORE, AFTER, applyPortableOverlay };
