// The steps that end every Wine source's launch preparation: the Steam client
// bridge, the DXGI adapter description, the game's Windows paths, the shader
// cache, the launch folder's watch and the game's runtime record.
const path = require("node:path");
const Translators = require("../../shared/runtime/wine-translators");

// The bridge helper starts the game through the Steam client when the game
// declares a Steam application.
async function steamBridge(entry, context, { install, prefixPath, architecture, environment, executablePath }) {
  const bridge = await require("../runtime/steam-bridge").prepare(entry, context, { installation: install, prefixPath, architecture, environment });
  const launch = bridge ? require("../runtime/steam-bridge-launch").resolve(executablePath, architecture) : null;
  return { bridge, launch, environment: bridge ? bridge.environment : environment, executablePath: launch ? launch.executablePath : executablePath };
}
function adapterDescription(environment, { translatorPlan, host, signal, existingEnvironment }) {
  return require("../../shared/runtime/dxgi-adapter-description").prepare({ ...existingEnvironment?.environment, ...environment }, { translatorPlan, host, signal });
}
// The drive covers the imported game folder, so paths above the executable's
// folder resolve. Drive links are allocated in the prefix that runs the game.
function gamePaths(entry, prefixPath, { originalRoot, gameRoot, executable, executablePath }) {
  const workingDirectory = path.dirname(executable), driveRoot = require("../game-drive").gameDriveRoot(entry, originalRoot, executable);
  const paths = require("../../shared/runtime/wine-game-paths").prepareGamePaths(prefixPath,
    { gameRoot: gameRoot === originalRoot ? driveRoot : gameRoot, executablePath, workingRoot: driveRoot, workingDirectory });
  return { workingDirectory, ...paths };
}
function shaderCache(directory, prefixPath) {
  return require("../runtime/shader-cache").prepare(directory, prefixPath);
}
// A launch folder is remembered for the source and watched for game writes.
function keepLaunchFolder(entry, context, { runtimeId, directory, view }) {
  if (!view) return;
  const GameView = require("../temporal/game-view");
  GameView.remember(entry, context, runtimeId, view);
  GameView.watch(entry, context, directory, runtimeId, view);
}
function recordRuntime(entry, context, { runtimeId, match, gameRoot, existingEnvironment, steamBridge, translatorPlan, requestedSettings, install, values }) {
  entry.runtimeData = { ...entry.runtimeData, [runtimeId]: { ...entry.runtimeData?.[runtimeId], ...values,
    sourceRoot: match.sourceRoot, gameRoot,
    ...(existingEnvironment ? { environmentReference: existingEnvironment.reference } : {}),
    steamBridge: steamBridge ? { version: steamBridge.packageVersion } : null,
    translatorRows: Translators.inspectorRows(translatorPlan),
    translatorPlanInputs: Translators.planInputs(requestedSettings, context.wineEnvironment?.install || install),
    cameraAdapterNotice: context.cameraAdapterNotice || null, graphicsInputs: context.graphicsInputs } };
  context.onEntryChange?.(entry);
}

module.exports = { steamBridge, adapterDescription, gamePaths, shaderCache, keepLaunchFolder, recordRuntime };
