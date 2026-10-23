const fs = require("node:fs");
const path = require("node:path");
const Script = require("../shared/runtime/launch-script");
const SteamClient = require("../shared/runtime/steamworks/installed-client");
const { foregroundEnvironment, spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const { trackScriptProcess } = require("./process-session");

async function launchNativeRuntime(entry, context) {
  const kind = entry.moduleData?.launchKind;
  if (!["script", "executable"].includes(kind)) return null;
  const executable = entry.gamePath;
  if (!path.isAbsolute(executable || "") || !fs.statSync(executable).isFile())
    throw new Error("Native game file not found. Import the game again from its current location.");
  const steam = await SteamClient.prepareNativeLaunch(executable, { signal: context.signal });
  const options = { cwd: path.dirname(executable), env: foregroundEnvironment(steam.environment) };
  const args = context.gameArguments || [];
  if (kind === "executable") return spawnForegroundNativeGame({ context, executablePath: executable, args, options });

  // Publish the same session to the launcher at spawn time and as the launch
  // result. A script can exit before the game process it starts.
  let session;
  const onProcessSpawn = context.onProcessSpawn;
  context.onProcessSpawn = child => {
    session = trackScriptProcess(child);
    return onProcessSpawn?.(session);
  };
  try {
    const child = await Script.launchScript(executable, args, options, false, context, { allowUnexecutable: true });
    return session || trackScriptProcess(child);
  } catch (error) {
    if (error.code === "EACCES") {
      throw new Error("The script is not executable. Use Make executable in the game inspector, then play again.", { cause: error });
    }
    if (error.code === "ENOENT") {
      throw new Error("The script or its interpreter was not found. Check the script path and install its required interpreter.", { cause: error });
    }
    throw error;
  } finally { context.onProcessSpawn = onProcessSpawn; }
}

module.exports = { launchNativeRuntime };
