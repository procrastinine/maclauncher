const path = require("node:path");
const ReShade = require("../shared/reshade");
const warn = require("../shared/graphics-warning"), Items = require("../shared/item-results");

// A row that cannot run natively is bypassed with its reason
// (`context.effectsSkipped`); the other rows keep their native prefix or the
// shared chain. Only cancellation ends the preparation.
async function preparePlaybackShaders(entry, context, { resolveShaderSelection = ReShade.resolveShaderSelection } = {}) {
  context.effectsSkipped = [];
  if (entry.effects?.enabled === false) {context.effectsEntry = entry;return [];}
  const args = [], options = { userDataDir: context.userDataDir, root: context.graphicsRuntimeRoot,
    graphicsHost: "window", graphicsArchitecture: "arm64", nativeVideo: true, settings: context.settings };
  const resolve = settings => resolveShaderSelection({ ...entry, effects: undefined, reshade: settings }, options);
  const native = selected => selected?.format === "libplacebo" && selected.traits?.sharedOnly !== true &&
    !selected.traits?.inputPolicy&&!Object.keys(selected.traits?.sceneBindings||{}).length;
  const unavailable = (error, id) => {
    if (Items.fatal(error, context.signal)) throw error;
    const reason = Items.reason(error);context.effectsSkipped.push({id, reason});
    warn(context.logger, `[Graphics] Video shader ${id} is unavailable: ${reason} Other compatible effects remain enabled.`);
  };
  const append = async (selected, settings, id) => {
    context.signal?.throwIfAborted();
    const file = context.snapshotNativeShaders === true
      ? require("./native-shaders").snapshot(selected.file, context.userDataDir, id) : selected.file;
    const row = [`--glsl-shader=${file}`], name = path.basename(file, path.extname(file));
    for (const [key, values] of Object.entries(settings.parameters || {})) {
      if (!Array.isArray(values) || values.length !== 1 || !Number.isFinite(values[0]))
        throw new Error("Native video shader parameters require one numeric value per setting.");
      row.push(`--glsl-shader-opts-append=${name}/${key}=${values[0]}`);
    }
    if (selected.runtimeIdentity) await context.useRuntime?.(selected.runtimeIdentity);
    context.signal?.throwIfAborted();
    args.push(...row);
  };
  if (entry.effects?.mode === "advanced") {
    let rgbSeen = false, nativeEnd = -1;const removed = new Set();
    for (const node of entry.effects.video) {
      if (!node.enabled) continue;
      if (node.kind !== "shader") { rgbSeen = true;continue; }
      if (node.shader.enabled === false) continue;
      try {
        context.signal?.throwIfAborted();
        const selected = await resolve(node.shader);
        if (!native(selected)) { rgbSeen = true;continue; }
        // Native hook phases cannot express a row's explicit target extent or
        // reverse the selected row order. Keep those rows in the shared chain.
        const phases=require("../shared/reshade/plane-groups").stageRange(selected.traits?.stages);
        if(node.extent||nativeEnd>=0&&(!phases||phases.first<nativeEnd)){
          if(selected.traits?.requiresVideoPlanes)throw new Error("This video-plane shader cannot follow the selected native hook phases or use a shared output extent.");
          rgbSeen=true;continue;
        }
        // A decoded producer keeps RGB/derived-plane hooks in the shared GPU
        // chain, including each row's own extent and position. Only hooks that
        // need original decoder planes remain inside libmpv's source phases.
        if (context.decodedFrameProducer && !selected.traits?.requiresVideoPlanes) {rgbSeen=true;continue;}
        // Original mpv hooks see their declared source/scale phases. Keep a
        // compatible prefix inside that renderer, before the shared RGB chain.
        if (rgbSeen && !selected.traits?.requiresVideoPlanes) continue;
        if (rgbSeen) {
          throw new Error("Move video-plane shaders before shared RGB effects in Advanced graphics.");
        }
        await append(selected, node.shader, node.id);
        nativeEnd=phases?.last??Infinity;
        removed.add(node.id);
      } catch (error) { unavailable(error, node.id);removed.add(node.id); }
    }
    if (removed.size) context.effectsEntry = { ...entry, effects: { ...entry.effects, video: entry.effects.video.filter(node => !removed.has(node.id)) } };
  }
  return args;
}
async function playbackConfiguration(entry, context, dependencies) {
  const preparation = {...context, effectsEntry: undefined};
  const args = await preparePlaybackShaders(entry, preparation, dependencies);
  const shaders = [], parameters = {};
  for (const argument of args) {
    if (argument.startsWith("--glsl-shader=")) shaders.push(argument.slice("--glsl-shader=".length));
    else if (argument.startsWith("--glsl-shader-opts-append=")) {
      const value = argument.slice("--glsl-shader-opts-append=".length), split = value.indexOf("=");
      parameters[value.slice(0, split)] = value.slice(split + 1);
    }
  }
  return {entry: preparation.effectsEntry || entry, args, skipped: preparation.effectsSkipped, properties: {"glsl-shaders": shaders, "glsl-shader-opts": parameters}};
}
module.exports = { preparePlaybackShaders, playbackConfiguration };
