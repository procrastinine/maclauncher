const fs = require("node:fs"), path = require("node:path");
const manifest = require("./manifest.json"), { detectGame } = require("./detect"), manager = require("./runtime/manager");
const { spawnForegroundNativeGame } = require("../shared/runtime/native-focus");
const Scaling = require("./scaling");
const warn = require("../shared/graphics-warning");
function selectionFor(entry, context = {}) {
  return context.userDataDir ? manager.resolveSelection(entry, context.settings, context.userDataDir, { verification: "status" }) : { version: require("./runtime/catalog").DEFAULT_ENTRY.version };
}
function resolveGraphicsInputs(entry, context = {}) { return Scaling.inputs(Scaling.filtersFor(selectionFor(entry, context))); }
function playbackArguments(entry, filters = Scaling.filtersFor({ version: require("./runtime/catalog").DEFAULT_ENTRY.version }), logger) {
  return ["--no-config", "--load-scripts=no", "--ytdl=no", "--access-references=no", "--demuxer-lavf-o=protocol_whitelist=file",
    "--vo=gpu-next", "--hwdec=auto-safe", ...Scaling.argumentsFor(entry, filters, logger), "--autofit=80%x80%",
    "--keep-open=yes", "--force-window=yes", "--", entry.gamePath];
}
module.exports = {
  id: manifest.id, manifest, detectGame, runtimeManagers: [manager], normalizeRuntimeId: () => "mpv",
  mergeEntry: Scaling.mergeEntry,
  canLaunchRuntime: runtime => runtime === "mpv" && process.platform === "darwin",
  resolveGraphicsInputs,
  withGraphicsUpdate: (entry, context, options, publish) => require("./live").withGraphicsUpdate(entry, context, options, publish),
  prepareEffectsEntry: async (entry, context) => {
    const preparation = { ...context, effectsEntry: undefined };
    await require("./graphics").preparePlaybackShaders(entry, preparation);
    return Scaling.sharedEntry(preparation.effectsEntry || entry, Scaling.filtersFor(selectionFor(entry, context)));
  },
  ensureRuntime: (entry, context) => {
    const selected = manager.resolveForPlay(entry, context);
    return selected.ready ? null : { managerId: "mpv", version: selected.version, installOptions: {} };
  },
  launchRuntime: async (runtime, entry, context) => {
    if (runtime !== "mpv") return null;
    if (!path.isAbsolute(entry.gamePath || "") || !fs.statSync(entry.gamePath).isFile()) throw new Error("The video file was not found. Import it from its current location.");
    const selected = manager.resolveSelection(entry, context.settings, context.userDataDir);
    if (!selected.ready) throw new Error(selected.reason);
    const args = playbackArguments(entry, Scaling.filtersFor(selected), context.logger);
    const native = await require("./graphics").playbackConfiguration(entry, {...context, snapshotNativeShaders: true}, {fallback: true});
    const shaders = native.args;context.effectsEntry = native.entry;
    args.splice(args.indexOf("--"), 0, ...shaders);
    context.effectsEntry = Scaling.sharedEntry(context.effectsEntry || entry, Scaling.filtersFor(selected));
    const env = await context.applyGameEnvironment(process.env);
    let controls;
    const cleanup = () => {try {controls?.cleanup();} catch {}};
    const cancellation = error => {
      context.signal?.throwIfAborted();
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    };
    context.signal?.throwIfAborted();
    try {controls = require("./live").create(entry, context);}
    catch (error) {
      cancellation(error);
      warn(context.logger, "Live video graphics controls are unavailable for this playback.", error.message);
    }
    if (controls) args.splice(args.indexOf("--"), 0, `--input-ipc-server=${controls.socket}`);
    if (context.gameArguments?.length) args.splice(args.indexOf("--"), 0, ...context.gameArguments);
    try {
      const child = await spawnForegroundNativeGame({ context, executablePath: selected.install.executablePath, args,
        options: { cwd: path.dirname(entry.gamePath), env } });
      try { controls?.bind(child, Scaling.filtersFor(selected)); }
      catch (error) {
        cleanup();cancellation(error);
        warn(context.logger, "Live video graphics controls are unavailable for this playback.", error.message);
      }
      return child;
    } catch (error) {cleanup();throw error;}
  },
  actions: { previewVideo: (entry, payload, context) => require("./tools").previewVideo(entry, payload, context),
    exportVideo: (entry, payload, context) => require("./tools").exportVideo(entry, payload, context),
    processVideo: (entry, payload, context) => require("./tools").processVideo(entry, payload, context),
    runtimeStatus: (entry, _payload, context) => {
      const selected = selectionFor(entry, context);
      return { ...selected, graphicsInputs: Scaling.inputs(Scaling.filtersFor(selected)) };
    } },
  __test: { playbackArguments }
};
