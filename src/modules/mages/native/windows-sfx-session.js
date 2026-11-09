const path = require("node:path");
const Adapter = require("./adapter");
const Input = require("./windows-ui-data");
const { writeInputMetadata } = require("./windows-ui-session");
const { ABI } = require("./windows-sfx-overlay");
const Audio = require("./windows-audio-overlay");
const Checkpoint = require("./windows-checkpoint-overlay");

const PROFILE_SOURCE = path.join(__dirname, "windows-game-v9.lua");

function prepareWindowsSoundEffectSession(options) {
  const profileSource = options.profileSource || PROFILE_SOURCE;
  const { game } = Adapter.validateWindowsData(options.gamePath);
  if (!game.originalRunnerPath)
    throw new Error("The original Windows executable is required for its input layout.");
  const metadata = Input.inspectWindowsUiData(game.originalRunnerPath);
  const session = Adapter.prepareWindowsSession({ ...options, profileSource });
  return { ...session, inputMetadata: writeInputMetadata(session.sessionDir, metadata),
    audioAbi: Audio.ABI, checkpointAbi: Checkpoint.ABI, soundEffectAbi: ABI };
}

module.exports = { ABI, PROFILE_SOURCE, prepareWindowsSoundEffectSession };
