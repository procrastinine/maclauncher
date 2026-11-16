const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../game-data");
const Environments = require("../runtime/wine-environment");
const Wine = require("../../crossover/sources/wine-launch");
const CrossOver = require("../../crossover/runtime/launch");
const { environment: basicEnvironment } = require("../runtime/macos-sandbox");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { runHelper } = require("./process");
const { installerError } = require("./inno-header");
async function withPrivateWine(context, directory, helpers, callback, dependencies = {}) {
  const host = dependencies.host;
  if (!host?.source || !path.isAbsolute(host.install?.executablePath || "") || !path.isAbsolute(host.install?.serverPath || ""))
    throw installerError("The selected Wine runtime lacks a decoder loader or server.", "INSTALLER_TOOL_MISSING");
  // Use the existing private Wine ownership boundary. Only this fresh child
  // prefix is disposable; existing game prefixes and external bottles survive.
  const runtimeDirectory = path.join(GameData.resolveGameDir(context.userDataDir, context.gameId || context.entry?.gameId), "runtimes", host.source.id);
  await fs.promises.mkdir(runtimeDirectory, { recursive: true });
  const owned = Environments.privateEnvironment(context.userDataDir, runtimeDirectory, ".installer-" + crypto.randomUUID());
  const prefix = Environments.assertPrivateEnvironment(owned, runtimeDirectory);
  const settings = { windowsVersion: "win10", synchronization: "off", graphicsBackend: "auto" };
  const use = dependencies.withRuntimeUse || withRuntimeUse;
  return use([{ managerId: host.manager.id, version: host.version, sourcePath: host.install.installDir }], async lease => {
    const current = host.manager.resolveSelection(context.entry || {}, context.settings, context.userDataDir, { version: host.version });
    if (!current.ready || current.install.executablePath !== host.install.executablePath) throw installerError("The selected Wine runtime changed before extraction.");
    const onSpawn = async child => { await lease.bind(child.pid); await context.onSpawn?.(child); };
    const scoped = { ...context, onToolProcessSpawn: onSpawn };
    const launch = host.source.id === "crossover" ? null : (dependencies.forSource || Wine.forSource)(host.source.id);
    const runtime = launch?.prefixRuntime(host.install, runtimeDirectory);
    const initial = launch ? launch.buildEnvironment(settings, host.install, runtimeDirectory, prefix, runtime, { baseEnvironment: basicEnvironment() })
      : CrossOver.buildEnvironment(settings, host.install, runtimeDirectory, prefix, { baseEnvironment: basicEnvironment() });
    const environment = { ...initial.environment, HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"),
      WINEPREFIX: prefix, WINEDEBUG: "-all", WINEDLLOVERRIDES: "winemenubuilder.exe=d;unarc,unarc64=d" };
    const supervise = dependencies.runSupervised || Wine.runSupervised;
    const run = (command, server, args, options) => supervise(command, server, args, { ...options, env: environment });
    try {
      for (const name of ["home", "tmp"]) await fs.promises.mkdir(path.join(directory, name), { recursive: true });
      if (launch) await launch.ensurePrefix(host.install, owned, runtimeDirectory, settings, runtime, scoped, { run });
      else await (dependencies.ensureBottle || CrossOver.ensureBottle)(host.install, owned, runtimeDirectory, settings, scoped,
        { run: (command, args, options) => run(command, host.install.serverPath, args, options) });
      require("../../crossover/sources/launch-steps").detachProfileAliases(prefix);
      const copied = path.join(prefix, "drive_c", "decoders");
      await fs.promises.cp(helpers, copied, { recursive: true, errorOnExist: true, force: false, dereference: false,
        filter: file => !/^unarc(?:64)?\.dll$/i.test(path.basename(file)) });
      return await callback({ executable: host.install.executablePath, environment, helpers: copied, onSpawn });
    } finally {
      // Stop only this branded, disposable prefix before deleting it. The
      // original bottle/wrapper reference is never consulted or modified.
      const env = { ...environment, WINEPREFIX: prefix };
      if (host.install.serverPath) {
        const runner = dependencies.runHelper || runHelper;
        for (const args of [["-k"], ["-w"]]) await runner(host.install.serverPath, args, { env, environmentOnly: true, timeout: 15000, onSpawn });
      }
      Environments.assertPrivateEnvironment(owned, runtimeDirectory);
      await fs.promises.rm(prefix, { recursive: true, force: true });
    }
  }, { userDataDir: context.userDataDir });
}
module.exports = { withPrivateWine };
