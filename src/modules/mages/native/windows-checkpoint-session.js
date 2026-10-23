const path = require("node:path");
const Adapter = require("./adapter");
const Input = require("./windows-ui-data");
const { writeInputMetadata } = require("./windows-ui-session");
const { ABI } = require("./windows-checkpoint-overlay");
const Audio = require("./windows-audio-overlay");

const PROFILE_SOURCE = path.join(__dirname, "windows-game-v7.lua");
const PROFILE_SHA256 = "b14aa9ee54e1ca7c07a8f31ccf6b5fa4842b746bfe63db5c66f92455eb61eaba";

function prepareWindowsCheckpointSession(options) {
  const profileSource = options.profileSource || PROFILE_SOURCE;
  if (Adapter.hash(profileSource) !== PROFILE_SHA256)
    throw new Error("Windows checkpoint profile checksum changed.");
  const { game } = Adapter.validateWindowsData(options.gamePath);
  if (!game.originalRunnerPath)
    throw new Error("The original Windows executable is required for its input layout.");
  const metadata = Input.inspectWindowsUiData(game.originalRunnerPath);
  const session = Adapter.prepareWindowsSession({ ...options, profileSource });
  return { ...session, inputMetadata: writeInputMetadata(session.sessionDir, metadata),
    audioAbi: Audio.ABI, checkpointAbi: ABI };
}

module.exports = { ABI, PROFILE_SOURCE, PROFILE_SHA256, prepareWindowsCheckpointSession };
