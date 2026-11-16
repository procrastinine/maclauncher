const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../game-data");
const Sources = require("../../crossover/sources");
const Environments = require("../runtime/wine-environment");
const Wine = require("../../crossover/sources/wine-launch");
const CrossOver = require("../../crossover/runtime/launch");
const WindowsTools = require("../runtime/managed-windows-tool");
const { environment: basicEnvironment } = require("../runtime/macos-sandbox");
const { withRuntimeUse } = require("../../../core/coordinated-runtime-managers");
const { runHelper } = require("./process");
const { installerError } = require("./inno-header");
async function selectedWine(context) {
  const requested = context.runtimeId || context.entry?.runtimeId;
  const source = Sources.get(requested);
  const entry = context.entry || { gameId: context.gameId };
  if (source?.downloads === false && !source.manager().resolveSelection(entry, context.settings, context.userDataDir).ready)
    throw installerError("The selected Wine runtime is unavailable for this decoder.", "INSTALLER_TOOL_MISSING");
  // The shared Windows-tool helper owns installation and the existing
  // fallback policy. An explicit source is supplied to both slots so that
  // its version cannot silently fall back to another Wine installation.
  const dependencies = source ? { sikarugir: source.manager(), crossover: source.manager() } : {};
  const selected = await WindowsTools.ensureWine(entry, context, dependencies);
  if (selected.install.needsRosetta) await (context.ensureRosetta ? context.ensureRosetta() : require("../runtime/rosetta").ensure(context));
  return { ...selected, source: source || Sources.get(selected.kind) };
}
async function withPrivateWine(context, directory, helpers, callback, dependencies = {}) {
  const host = await (dependencies.selectedWine || selectedWine)(context);
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
    let environment;
    try {
      if (host.source.id === "crossover") {
        await (dependencies.ensureBottle || CrossOver.ensureBottle)(host.install, owned, runtimeDirectory, settings, scoped);
        environment = CrossOver.buildEnvironment(settings, host.install, runtimeDirectory, prefix, { baseEnvironment: basicEnvironment() }).environment;
      } else {
        const launch = (dependencies.forSource || Wine.forSource)(host.source.id), runtime = launch.prefixRuntime(host.install, runtimeDirectory);
        await launch.ensurePrefix(host.install, owned, runtimeDirectory, settings, runtime, scoped);
        environment = launch.buildEnvironment(settings, host.install, runtimeDirectory, prefix, runtime, { baseEnvironment: basicEnvironment() }).environment;
      }
      require("../../crossover/sources/launch-steps").detachProfileAliases(prefix);
      environment = { ...environment, HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"), WINEPREFIX: prefix, WINEDEBUG: "-all", WINEDLLOVERRIDES: "winemenubuilder.exe=d" };
      for (const name of ["home", "tmp"]) await fs.promises.mkdir(path.join(directory, name), { recursive: true });
      const copied = path.join(prefix, "drive_c", "decoders");
      await fs.promises.cp(helpers, copied, { recursive: true, errorOnExist: true, force: false, dereference: false });
      return await callback({ executable: host.install.executablePath, environment, helpers: copied, onSpawn });
    } finally {
      // Stop only this branded, disposable prefix before deleting it. The
      // original bottle/wrapper reference is never consulted or modified.
      const env = { ...environment, WINEPREFIX: prefix };
      if (host.install.serverPath) {
        const runner = dependencies.runHelper || runHelper;
        for (const args of [["-k"], ["-w"]]) await runner(host.install.serverPath, args, { env, timeout: 15000, onSpawn });
      }
      Environments.assertPrivateEnvironment(owned, runtimeDirectory);
      await fs.promises.rm(prefix, { recursive: true, force: true });
    }
  }, { userDataDir: context.userDataDir });
}
module.exports = { selectedWine, withPrivateWine };
