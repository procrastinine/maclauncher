const fs = require("node:fs"), path = require("node:path");
const { getUiServices } = require("../shared/ui-services");
const { throwIfAborted } = require("../shared/runtime/download-utils");
async function previewVideo(entry, payload = {}, context = {}) {
  throwIfAborted(context.signal);
  if (typeof context.launchForTools !== "function") throw new Error("Video preview is unavailable in this window.");
  const result = await context.launchForTools({ runtimeId: "mpv", settings: context.settings, signal: context.signal });
  return result?.canceled || result?.kind === "cancelled" ? { canceled: true } : { message: "Video preview opened with the saved graphics settings." };
}
async function exportVideo(entry, payload = {}, context = {}, dependencies = {}) {
  if (entry.moduleData?.playlist) entry = require("./playlist").playableEntry(entry, context);
  const input = entry.gamePath;
  if (!path.isAbsolute(input || "") || !fs.statSync(input, {throwIfNoEntry: false})?.isFile()) throw new Error("The source video was not found.");
  throwIfAborted(context.signal);
  const dialog = getUiServices(context).dialog;
  let { output, width, height, scale, maxHeight } = payload;
  if (width === undefined && height === undefined && scale === undefined && maxHeight === undefined) {
    const hasUpscaling = entry.effects?.mode === "advanced"
      ? entry.effects.enabled !== false && entry.effects.video.some(node => node.enabled && (node.kind === "upscale" || node.kind === "spatial" && node.method !== "downsample"))
      : entry.graphics?.spatialMethod && entry.graphics.spatialMethod !== "off" || Boolean(entry.graphics?.spatialShader);
    const selected = await dialog.showMessageBox({ type: "question", title: "Export video", message: "Output resolution",
      detail: "Apply the saved graphics settings to each frame. The source file is preserved.",
      buttons: ["Original", "2×", "4K", "Cancel"], defaultId: hasUpscaling ? 1 : 0, cancelId: 3, noLink: true });
    if (selected.response === 3) return { canceled: true };
    if (selected.response === 2) maxHeight = 2160; else scale = selected.response === 1 ? 2 : 1;
  }
  if (!output) {
    if (!dialog.showSaveDialog) throw new Error("Choose an output video file.");
    const selected = await dialog.showSaveDialog({ title: "Export video", defaultPath: path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-processed.mp4`),
      filters: [{ name: "MPEG-4 video", extensions: ["mp4"] }] });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    output = selected.filePath;
  }
  throwIfAborted(context.signal);
  return (dependencies.exportVideo || require("./export").exportVideo)({ entry, input, output, width, height, scale, maxHeight, context });
}
async function processVideo(entry, payload = {}, context = {}, dependencies = {}) {
  if (entry.moduleData?.playlist) entry = require("./playlist").playableEntry(entry, context);
  const input = entry.gamePath;
  if (!path.isAbsolute(input || "") || !fs.statSync(input).isFile()) throw new Error("The source video was not found.");
  const dialog = getUiServices(context).dialog;
  const selected = entry.effects?.mode === "advanced"
    ? entry.effects.video.find(node => node.kind === "neural" && node.settings?.modelPath)?.settings
    : entry.graphics?.neuralMethod === "mlx-dlss" && entry.graphics.neuralModelPath
      ? { modelPath: entry.graphics.neuralModelPath, intensity: entry.graphics.neuralIntensity ?? 1, temporal: entry.graphics.neuralTemporal === true } : undefined;
  let modelPath = payload.modelPath || selected?.modelPath;
  if (!modelPath) {
    const picked = await dialog.showOpenDialog({ title: "Choose neural rendering model", properties: ["openFile", "openDirectory"], filters: [{ name: "Neural rendering model source", extensions: ["dlssmodel", "app", "zip"] }] });
    if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
    modelPath = picked.filePaths[0];
  }
  throwIfAborted(context.signal);
  let output = payload.output;
  if (!output) {
    if (!dialog.showSaveDialog) throw new Error("Choose an output file through the video inspector or provide an output path.");
    const picked = await dialog.showSaveDialog({ title: "Save processed video", defaultPath: path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-processed.mp4`),
      filters: [{ name: "MPEG-4 video", extensions: ["mp4"] }] });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    output = picked.filePath;
  }
  if (!path.isAbsolute(output) || output.includes("\0") || path.resolve(output) === path.resolve(input)) throw new Error("Choose a separate absolute output file path.");
  if (fs.existsSync(output)) throw new Error("The output file already exists. Choose a new filename.");
  throwIfAborted(context.signal);
  if (/\.(app|zip)$/i.test(modelPath)) {
    const imported = await require("../shared/reshade/neural/models").importModel({userDataDir: context.userDataDir, runtimePath: modelPath,
      signal: context.signal, onProgress: context.onProgress, onRuntimeStateChange: context.onRuntimeStateChange});
    modelPath = imported.modelPath;
  }
  return (dependencies.processVideo || (options => require("../shared/reshade/neural/offline").processVideo(options)))({ input, output, modelPath,
    ...(!payload.modelPath && selected ? { intensity: selected.intensity, temporal: selected.temporal } : {}),
    signal: context.signal, onProgress: context.onProgress, logger: context.logger, root: context.graphicsRuntimeRoot, userDataDir: context.userDataDir,
    onToolProcessSpawn: context.onToolProcessSpawn });
}
module.exports = { processVideo, previewVideo, exportVideo };
