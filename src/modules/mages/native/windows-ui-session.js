const fs = require("node:fs");
const path = require("node:path");
const Adapter = require("./adapter");
const Input = require("./windows-ui-data");

const PROFILE_SOURCE = path.join(__dirname, "windows-game-v5.lua");

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
  const { game } = Adapter.validateWindowsData(options.gamePath);
  if (!game.originalRunnerPath) throw new Error("The original Windows executable is required for its input layout.");
  const metadata = Input.inspectWindowsUiData(game.originalRunnerPath);
  const session = Adapter.prepareWindowsSession({ ...options, profileSource });
  return { ...session, inputMetadata: writeInputMetadata(session.sessionDir, metadata) };
}

module.exports = { PROFILE_SOURCE, writeInputMetadata, prepareWindowsInputSession };
