const fs = require("node:fs");
const path = require("node:path");
const Adapter = require("./adapter");
const Input = require("./windows-ui-data");

const PROFILE_SOURCE = path.join(__dirname, "windows-game-v5.lua");
const PROFILE_SHA256 = "16968326aa58b2579e7472a0ef108f6469fd257e9dad19fc75e9a04fc91603c8";

function writeInputMetadata(sessionDir, metadata) {
  if (!path.isAbsolute(sessionDir || "") || fs.lstatSync(sessionDir).isSymbolicLink() ||
      !fs.lstatSync(sessionDir).isDirectory()) throw new Error("Windows input state requires an owned session directory.");
  const root = fs.realpathSync(sessionDir), patches = path.join(root, "patches");
  if (!fs.lstatSync(patches).isDirectory() || fs.lstatSync(patches).isSymbolicLink() || fs.realpathSync(patches) !== patches)
    throw new Error("Windows input state cannot use linked directories.");
  const file = path.join(patches, "windows-ui-input.lua"), contents = Input.luaInputData(metadata);
  Adapter.writeOwnedFile(file, contents);
  return { file, sha256: Adapter.hash(file), abi: metadata.abi, regions: metadata.regions.length,
    descriptorSha256: metadata.descriptorSha256 };
}

function prepareWindowsInputSession(options) {
  const profileSource = options.profileSource || PROFILE_SOURCE;
  if (Adapter.hash(profileSource) !== PROFILE_SHA256) throw new Error("Windows input profile checksum changed.");
  const { game } = Adapter.validateWindowsData(options.gamePath);
  if (!game.originalRunnerPath) throw new Error("The original Windows executable is required for its input layout.");
  const metadata = Input.inspectWindowsUiData(game.originalRunnerPath);
  const session = Adapter.prepareWindowsSession({ ...options, profileSource });
  return { ...session, inputMetadata: writeInputMetadata(session.sessionDir, metadata) };
}

module.exports = { PROFILE_SOURCE, PROFILE_SHA256, writeInputMetadata, prepareWindowsInputSession };
