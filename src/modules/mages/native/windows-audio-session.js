const path = require("node:path");
const Adapter = require("./adapter");
const Input = require("./windows-ui-data");
const { writeInputMetadata } = require("./windows-ui-session");
const { ABI } = require("./windows-audio-overlay");

const PROFILE_SOURCE = path.join(__dirname, "windows-game-v6.lua");
const PROFILE_SHA256 = "3ba84e8d62868a09d8070fe57e0229c29eecd1a09468d4f2778d24057707c1e9";

function prepareWindowsAudioSession(options) {
  const profileSource = options.profileSource || PROFILE_SOURCE;
  if (Adapter.hash(profileSource) !== PROFILE_SHA256)
    throw new Error("Windows audio profile checksum changed.");
  const { game } = Adapter.validateWindowsData(options.gamePath);
  if (!game.originalRunnerPath)
    throw new Error("The original Windows executable is required for its input layout.");
  const metadata = Input.inspectWindowsUiData(game.originalRunnerPath);
  const session = Adapter.prepareWindowsSession({ ...options, profileSource });
  return { ...session, inputMetadata: writeInputMetadata(session.sessionDir, metadata), audioAbi: ABI };
}

module.exports = { ABI, PROFILE_SOURCE, PROFILE_SHA256, prepareWindowsAudioSession };
