const { createStaticServer } = require("../../../../core/static-server");
const { launchHostedProcess } = require("../../../../core/hosted-process");
const { spawnDetachedChecked } = require("../../../../core/processes");
const { contentPaths } = require("./electron-host");

const ASSET_ORIGIN_ENV = "MACLAUNCHER_GAME_ASSET_ORIGIN";

// Chromium's trusted broker and services install their own process profiles.
// Publisher Node code is confined in the game renderer by its first preload;
// applying an outer profile here would prevent Chromium sandbox initialization.
async function launchIsolatedHost(launch, entry, context, dependencies = {}) {
  const start = dependencies.launch || launchHostedProcess;
  launch = {...launch, env: await require("./browser-graphics").prepareBrowserGraphicsEnvironment(context, launch.env)};
  const isolated = typeof context?.networkAllowed === "boolean" ? !context.networkAllowed
    : context?.runtimeSettings?.networkIsolation === true;
  if (!isolated) return start(launch);
  const { rootDir } = contentPaths(entry);
  const module = (dependencies.registry || require("../../../registry")).getModule(entry.moduleId || entry.engine || "unknown");
  const readRoots = module?.getContentReadRoots?.(entry, context) || [];
  const server = await (dependencies.createServer || createStaticServer)(rootDir, { readRoots });
  const close = () => { void server.close().catch(error => context.logger?.warn?.("[network] asset server close failed", error)); };
  try {
    const spawn = launch.spawn || spawnDetachedChecked;
    const child = await start({ ...launch,
      env: { ...launch.env, [ASSET_ORIGIN_ENV]: `http://127.0.0.1:${server.port}` },
      spawn: (command, args, options) => spawn(command, args, { ...options,
        networkIsolation: false }) });
    child.once("exit", close);
    child.once("error", close);
    if (child.exitCode != null || child.signalCode != null) close();
    return child;
  } catch (error) { close(); throw error; }
}

module.exports = { launchIsolatedHost, ASSET_ORIGIN_ENV };
