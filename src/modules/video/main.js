const path = require("node:path");
const manifest = require("./manifest.json"), { detectGame } = require("./detect"), manager = require("./runtime/manager");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const Scaling = require("./scaling");
const warn = require("../shared/graphics-warning");
const Plugins = require("./plugins");
const Configuration = require("./configuration");
const Playlist = require("./playlist");
function selectionFor(entry, context = {}) {
  return manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" });
}
function thumbnailPlayer(selected, context, renderHost) {
  if (!renderHost) return selected;
  const rows = manager.getState({ userDataDir: context.userDataDir, settings: context.settings?.runtimes?.mpv }).installed || [];
  const compatible = rows.filter(row => row.ready !== false && row.executablePath && !require("./runtime/render-host").read(row.executablePath));
  const install = compatible.length === 1 ? compatible[0] : null;
  return { ready: Boolean(install), version: install?.version || null, install };
}
function resolveGraphicsInputs(entry, context = {}) { return Scaling.inputs(Scaling.filtersFor(selectionFor(entry, context))); }
function playbackArguments(entry, filters = Scaling.filtersFor(), logger, options) {
  return ["--no-config", "--load-scripts=no", "--ytdl=no", "--access-references=no", "--demuxer-lavf-o=protocol_whitelist=file",
    "--vo=gpu-next", "--hwdec=auto-safe", ...Scaling.argumentsFor(entry, filters, logger,options), "--autofit=80%x80%",
    "--keep-open=yes", "--force-window=yes", "--sub-auto=exact", "--sub-file-paths=subs:subtitles:Subs:Subtitles", "--", entry.gamePath];
}
module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [manager, Plugins.manager], normalizeRuntimeId: () => "mpv",
  settingsActions: require("./settings").settingsActions,
  mergeEntry: Scaling.mergeEntry,
  upgradeLegacyGraphics: Scaling.legacyGraphics,
  canLaunchRuntime: runtime => runtime === "mpv" && process.platform === "darwin",
  resolveGraphicsInputs,
  withGraphicsUpdate: (entry, context, options, publish) => require("./live").withGraphicsUpdate(entry, context, options, publish),
  prepareEffectsEntry: async (entry, context) => {
    const selection=selectionFor(entry,context);
    const decodedFrameProducer=Boolean(selection.install?.executablePath&&require("./runtime/render-host").read(selection.install.executablePath));
    const preparation = { ...context, effectsEntry: undefined,decodedFrameProducer };
    await require("./graphics").preparePlaybackShaders(entry, preparation);
    const prepared = preparation.effectsEntry || entry;
    return preparation.effectsSkipped.length ? {...prepared, effectsSkipped: preparation.effectsSkipped} : prepared;
  },
  ensureRuntime: (entry, context) => {
    const selected = manager.resolveForPlay(entry, context);
    return selected.ready ? null : { managerId: "mpv", version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}), installOptions: {} };
  },
  getRuntimeRequirements: async (entry, context) => {
    const selected = selectionFor(entry, context);
    const host = selected.install?.executablePath && require("./runtime/render-host").read(selected.install.executablePath)?.value;
    const requirements = Configuration.required(context.runtimeSettings, context.userDataDir).flatMap(pkg => {
      const install = Plugins.status(context.userDataDir, pkg.id);
      if (install) {
        context.recordRuntimeUse?.({ managerId: Plugins.manager.id, sectionId: pkg.id, version: pkg.version, sourcePath: install.installDir });
        return [];
      }
      return [];
    });
    if (host && Configuration.available(context.runtimeSettings, context.userDataDir).thumbfast) {
      const worker = thumbnailPlayer(selected, context, host);
      if (worker.ready) await context.useRuntime?.({ managerId: manager.id, version: worker.version, sourcePath: worker.install.installDir || worker.install.executablePath });
    }
    return requirements;
  },
  launchRuntime: async (runtime, entry, context) => {
    if (runtime !== "mpv") return null;
    const playback = Playlist.prepare(entry, context);
    const playbackEntry = { ...entry, gamePath: playback.file };
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const renderHost=require("./runtime/render-host").verify(selected.install.executablePath);
    const uosc = context.runtimeSettings?.uosc !== false && Plugins.playbackStatus(context.userDataDir, "uosc");
    if (uosc?.helperPath) await require("../shared/runtime/rosetta").ensureForExecutable(uosc.helperPath, context);
    const worker = Configuration.available(context.runtimeSettings, context.userDataDir).thumbfast ? thumbnailPlayer(selected, context, renderHost) : null;
    if (renderHost && worker?.ready) await context.useRuntime?.({ managerId: manager.id, version: worker.version, sourcePath: worker.install.installDir || worker.install.executablePath });
    const playbackContext = worker && !worker.ready ? { ...context, runtimeSettings: { ...context.runtimeSettings, timelinePreviews: false } } : context;
    const player = Configuration.prepare(playbackContext, { executablePath: selected.install.executablePath, renderHost, thumbnailExecutablePath: worker?.install?.executablePath });
    let args, nativeProperties;
    context.refreshGraphicsPreparation=async({signal=context.signal}={})=>{
      args=playbackArguments(playbackEntry,Scaling.filtersFor(selected),context.logger,{decodedFrameProducer:Boolean(renderHost)});
      args.splice(0, 2);
      args.splice(args.indexOf("--"), 0, ...player.args);
      const native=await require('./graphics').playbackConfiguration(entry,{...context,signal,snapshotNativeShaders:true,decodedFrameProducer:Boolean(renderHost)});
      nativeProperties = native.properties;
      context.effectsEntry=native.entry;args.splice(args.indexOf('--'),0,...native.args);
    };
    let env;
    try {
      await context.refreshGraphicsPreparation();
      env = await context.applyGameEnvironment(process.env);
    } catch (error) { player.cleanup();throw error; }
    if(renderHost)env.RESHADE_EXPLICIT_HOST="1";
    let controls, playbackCleanup;
    const cleanup = () => {try {playbackCleanup?.();controls?.cleanup();} catch {} player.cleanup();};
    const cancellation = error => {
      if (context.signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        cleanup();context.signal?.throwIfAborted();throw error;
      }
    };
    if (context.signal?.aborted) { cleanup();context.signal.throwIfAborted(); }
    try {controls = require("./live").create(entry, context);}
    catch (error) {
      cancellation(error);
      warn(context.logger, "Live video graphics controls are unavailable for this playback.", error.message);
    }
    if (controls) args.splice(args.indexOf("--"), 0, `--input-ipc-server=${controls.socket}`);
    if (context.gameArguments?.length) args.splice(args.indexOf("--"), 0, ...context.gameArguments);
    try {
      const child = await spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath, args,
        options: { cwd: path.dirname(playback.file), env } });
      child.once?.("close", cleanup);
      if (controls) try {
        controls.bind(child, Scaling.filtersFor(selected),{decodedFrameProducer:Boolean(renderHost), nativeProperties, source: playback.file, separateOSD: renderHost?.osdLayerAPI === 1});
        if (child.pid > 0) playbackCleanup = await Playlist.watch(child, controls.socket, playback, entry, context);
      } catch (error) {
        if (context.signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") child.kill?.();
        cancellation(error);
        if (child.pid > 0 && (child.exitCode != null || child.signalCode != null)) throw error;
        try { controls.cleanup(); } catch {}
        controls = null;
        warn(context.logger, "Live video controls and watch progress are unavailable for this playback.", error.message);
      }
      return child;
    } catch (error) {cleanup();throw error;}
  },
  actions: { ...require("./settings").actions,
    playlistOptions: Playlist.options,
    selectPlaylistVideo: Playlist.select,
    inspectMedia: (entry, payload, context) => require("./inspect").inspectMedia(entry, payload, context),
    previewVideo: (entry, payload, context) => require("./tools").previewVideo(entry, payload, context),
    exportVideo: (entry, payload, context) => require("./tools").exportVideo(entry, payload, context),
    processVideo: (entry, payload, context) => require("./tools").processVideo(entry, payload, context),
    runtimeStatus: (entry, _payload, context) => {
      const selected = selectionFor(entry, context);
      return { ...selected, graphicsInputs: Scaling.inputs(Scaling.filtersFor(selected)) };
    } },
  __test: { playbackArguments }
};
