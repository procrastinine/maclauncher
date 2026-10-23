const path = require("node:path");
const ReShade = require("../shared/reshade");
const warn = require("../shared/graphics-warning");

async function preparePlaybackShaders(entry, context, { resolveShaderSelection = ReShade.resolveShaderSelection, fallback = false } = {}) {
  const args = [], options = { userDataDir: context.userDataDir, root: context.graphicsRuntimeRoot,
    graphicsHost: "window", graphicsArchitecture: "arm64", nativeVideo: true, settings: context.settings };
  const resolve = settings => resolveShaderSelection({ ...entry, effects: undefined, reshade: settings }, options);
  const native = selected => selected?.format === "libplacebo";
  const unavailable = (error, id) => {
    if (!fallback || context.signal?.aborted || error.name === "AbortError") throw error;
    const reason = String(error.message || error).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
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
    let rgbSeen = false;const removed = new Set();
    for (const node of entry.effects.video) {
      if (!node.enabled) continue;
      if (node.kind !== "shader") { rgbSeen = true;continue; }
      if (node.shader.enabled === false) continue;
      try {
        context.signal?.throwIfAborted();
        const selected = await resolve(node.shader);
        if (!native(selected)) { rgbSeen = true;continue; }
        // Original mpv hooks see their declared source/scale phases. Keep a
        // compatible prefix inside that renderer, before the shared RGB chain.
        if (rgbSeen && !selected.traits?.requiresVideoPlanes) continue;
        if (rgbSeen) {
          throw new Error("Move video-plane shaders before shared RGB effects in Advanced graphics.");
        }
        await append(selected, node.shader, node.id);
        removed.add(node.id);
      } catch (error) { unavailable(error, node.id);removed.add(node.id); }
    }
    if (removed.size) context.effectsEntry = { ...entry, effects: { ...entry.effects, video: entry.effects.video.filter(node => !removed.has(node.id)) } };
  } else {
    let shared = entry;
    if (entry.reshade?.enabled) {
    try {
      context.signal?.throwIfAborted();
      const selected = await resolve(entry.reshade);
      if (native(selected)) {
        await append(selected, entry.reshade, "simple-shader");
        shared = { ...shared, reshade: { ...entry.reshade, enabled: false } };
      }
    } catch (error) {
      unavailable(error, "simple-shader");
      shared = { ...shared, reshade: { ...entry.reshade, enabled: false } };
    }
    }
    const spatial = entry.graphics?.spatialShader;
    // Native mpv hooks retain decoded-plane access and avoid a second RGB
    // compilation when they are the first spatial reconstruction stage. With
    // prior neural/temporal work, RGB hooks stay in the shared ordered stage.
    const sharedReconstruction = entry.graphics?.neuralMethod === "mlx-dlss" ||
      entry.graphics?.temporalMethod && entry.graphics.temporalMethod !== "off";
    if (spatial?.enabled && !sharedReconstruction) {
      try {
        context.signal?.throwIfAborted();
        const selected = await resolve(spatial);
        if (native(selected)) {
          await append(selected, spatial, "legacy-spatial-shader");
          shared = {...shared, graphics: {...shared.graphics, spatialShader: null}};
        }
      } catch (error) {
        unavailable(error, "legacy-spatial-shader");
        shared = {...shared, graphics: {...shared.graphics, spatialShader: null}};
      }
    }
    if (shared !== entry) context.effectsEntry = shared;
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
  return {entry: preparation.effectsEntry || entry, args, properties: {"glsl-shaders": shaders, "glsl-shader-opts": parameters}};
}
module.exports = { preparePlaybackShaders, playbackConfiguration };
