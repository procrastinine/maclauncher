const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { replacement } = require("./windows-ui-overlay");

const ABI = "backlog-zero-capacity-v1";
const FILE = "src/ui/backlogmenu.cpp";
const ORIGINAL_SHA256 = "720c137b33ac99606846c85b66f6ba58fa117a03035e2c0d0c2b0e8d0f311758";
const ORIGINALS = Object.freeze({ [FILE]: ORIGINAL_SHA256 });

function applyWindowsBacklogOverlay(sourceRoot) {
  const externalPath = path.resolve(__dirname, "../../../external");
  const external = fs.existsSync(externalPath) ? fs.realpathSync(externalPath) : externalPath;
  if (!path.isAbsolute(sourceRoot || "") || fs.lstatSync(sourceRoot).isSymbolicLink() ||
      !fs.lstatSync(sourceRoot).isDirectory() || fs.existsSync(path.join(sourceRoot, ".git")))
    throw new Error("Impacto source adapters require a separate source export.");
  const root = fs.realpathSync(sourceRoot);
  if (root === external || root.startsWith(external + path.sep))
    throw new Error("Impacto source adapters cannot change external checkouts.");
  const target = path.join(root, FILE), stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(target) !== target ||
      Native.hashFile(target) !== ORIGINAL_SHA256)
    throw new Error("Impacto backlog source checksum changed.");
  const text = replacement(fs.readFileSync(target, "utf8"),
    "  if (GetFlag(SF_REVADDDISABLE)) return;\n",
    "  if (Entries.capacity() == 0 || GetFlag(SF_REVADDDISABLE)) return;\n");
  fs.writeFileSync(target, text);
  return { abi: ABI, disabledCapacity: 0, files: [{ path: FILE, originalSha256: ORIGINAL_SHA256,
    adaptedSha256: Native.hashFile(target) }] };
}

module.exports = { ABI, FILE, ORIGINAL_SHA256, ORIGINALS, applyWindowsBacklogOverlay };
