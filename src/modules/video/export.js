const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ReShade = require("../shared/reshade"), Plans = require("../shared/effects/plan"), Effects = require("../shared/effects/runtime");
const Native = require("../shared/runtime/bundled-native");
const { throwIfAborted } = require("../shared/runtime/download-utils");

function outputFile(input, output) {
  if (typeof output !== "string" || !path.isAbsolute(output) || /[\0\r\n]/.test(output) || !/\.mp4$/i.test(output))
    throw new Error("Choose a new MP4 output file.");
  const target = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (fs.realpathSync(input) === target) throw new Error("Choose a separate output file to preserve the source video.");
  if (fs.lstatSync(target, {throwIfNoEntry: false})) throw new Error("The output file already exists. Choose a new filename.");
  return target;
}
function dimensions({width, height, scale, maxHeight}) {
  if (width !== undefined || height !== undefined) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 8192 && value % 2 === 0))
      throw new Error("Choose even output dimensions from 2 to 8192 pixels.");
    if (scale !== undefined || maxHeight !== undefined) throw new Error("Choose output dimensions or a scale.");
    return ["--width", String(width), "--height", String(height)];
  }
  if (maxHeight !== undefined) {
    if (scale !== undefined || !Number.isSafeInteger(maxHeight) || maxHeight < 2 || maxHeight > 8192 || maxHeight % 2)
      throw new Error("Choose a supported output height.");
    return ["--target-height", String(maxHeight)];
  }
  if (typeof (scale ?? 1) !== "number" || !Number.isFinite(scale ?? 1) || (scale ?? 1) < 1 || (scale ?? 1) > 4)
    throw new Error("Choose an output scale from 1× to 4×.");
  return ["--scale", String(scale ?? 1)];
}
function exportPlan(entry, options) {
  const videoEntry = {...entry, graphics: {...entry.graphics, neuralInputScale: entry.graphics?.neuralInputScale === undefined ? 1 : entry.graphics.neuralInputScale}};
  const plan = Plans.normalize(entry.effects) || ReShade.automaticPlan(videoEntry, {...options, draftPlan: true}) || Plans.fromLegacy(videoEntry);
  // Renderer source allocation and file output size are separate contracts.
  delete plan.renderResolution;
  const aliases = {jinc: "ewa_jinc", ewa_hanning: "ewa_hann"};
  for (const row of plan.video) {
    if (!row.enabled) continue;
    if (["temporal", "frame-generation"].includes(row.kind))
      throw new Error("Video export supports image effects and spatial scaling. Disable scene temporal scaling and frame generation before exporting.");
    if (row.kind === "spatial" && row.method.startsWith("libplacebo:")) {
      const name = row.method.slice(11);if (aliases[name]) row.method = "libplacebo:" + aliases[name];
    }
    if (row.kind === "shader") {
      const selected = ReShade.resolveShaderSelection({...entry, effects: undefined, reshade: row.shader}, {...options, nativeVideo: true});
      if (selected?.runtimeIdentity) options.runtimeIdentities?.push(selected.runtimeIdentity);
      if (selected?.traits?.requiresVideoPlanes)
        throw new Error("This shader requires native video luma and chroma planes. Preview supports it; choose an RGB shader for export.");
    }
  }
  return Plans.validate(plan);
}
async function exportVideo({entry, input, output, width, height, scale, maxHeight, context = {}}, dependencies = {}) {
  const {signal, userDataDir} = context;throwIfAborted(signal);
  const root = context.graphicsRuntimeRoot || ReShade.runtimeRoot();
  if ((context.platform || process.platform) !== "darwin" || !Native.versionAtLeast(context.macOSVersion || Native.systemVersionSync(), "14.0"))
    throw new Error("Graphics video export requires macOS 14 or later.");
  if (!userDataDir || !path.isAbsolute(userDataDir)) throw new Error("The video export settings directory is unavailable.");
  input = fs.realpathSync(input);if (!fs.statSync(input).isFile()) throw new Error("The source video was not found.");
  output = outputFile(input, output);const sizeArgs = dimensions({width, height, scale, maxHeight});
  const identities = [], options = {...context, root, runtimeIdentities: identities, graphicsHost: "explicit", graphicsArchitecture: process.arch,
    graphicsInputs: {source: "offline-video", nativeVideo: false, sourceResolution: false, depth: false, motionVectors: false, methods: []}};
  const plan = exportPlan(entry, options), jobId = "video-export-" + crypto.randomUUID(), job = {...entry, gameId: jobId, effects: plan};
  const jobDirectory = path.join(userDataDir, "games", jobId);
  for (const node of plan.video) if (node.enabled) {
    if (node.kind === "neural") {
      const identity = require("../shared/reshade/neural").modelIdentity(userDataDir, node.settings.modelPath);
      if (identity) identities.push(identity);
    } else if (node.kind === "spatial" && node.method === "ls1") {
      if (!node.settings.modelVersion) {
        const models = require("../shared/reshade/models").listInstalled(userDataDir), capability = node.settings.ls1Mode === "performance" ? "ls1Performance" : "ls1Quality";
        const preferred = context.settings?.runtimes?.["graphics-models"]?.defaultVersion;
        node.settings.modelVersion = models.find(model => model.version === preferred && model.inspection.capabilities[capability]?.compatible)?.version ||
          models.find(model => model.inspection.capabilities[capability]?.compatible)?.version;
      }
      if (node.settings.modelVersion) identities.push({managerId: "graphics-models", version: node.settings.modelVersion});
    }
  }
  const run = async lease => {
  try {
    const manifest = dependencies.manifest || require("../shared/reshade/publication").forRoot(root);
    const row = manifest.files.find(row => row.path === "maclauncher-graphics-video");
    if (!row) throw new Error("Graphics video export is unavailable in this application build.");
    (dependencies.verifyFile || require("../shared/reshade/payload-verification").verifyFile)(root, row);
    const autoEntry = {...entry, graphics: {...entry.graphics, neuralInputScale: entry.graphics?.neuralInputScale === undefined ? 1 : entry.graphics.neuralInputScale}};
    const prepared = await (dependencies.prepare || Effects.prepare)(job, {...options, ...ReShade.automaticResolutionOptions(autoEntry, options), fallback: false, launchPreparation: true});
    throwIfAborted(signal);
    const environment = {...process.env};
    for (const key of Object.keys(environment)) if (/^(DYLD_|RESHADE_|FSR4_)/.test(key)) delete environment[key];
    Object.assign(environment, prepared.environment, {RESHADE_EXPLICIT_HOST: "1", RESHADE_EFFECT_PLAN: prepared.file,
      RESHADE_EFFECT_PLAN_ROOT: path.join(path.dirname(prepared.file), "plan-nodes")});
    return await (dependencies.run || require("./export-process").run)({executable: path.join(root, row.path),
      args: ["--input", input, "--output", output, "--library", path.join(root, "libreshade-macos.dylib"), ...sizeArgs],
      env: environment, output, signal, onProgress: context.onProgress, logger: context.logger, onToolProcessSpawn: async (child, options) => {
        await lease?.retainUntilClosed(child);await context.onToolProcessSpawn?.(child, options);
      }});
  } finally { await fs.promises.rm(jobDirectory, {recursive: true, force: true}); }
  };
  const unique = [...new Map(identities.map(identity => [JSON.stringify(identity), identity])).values()];
  return unique.length ? (dependencies.withRuntimeUse || require("../../core/coordinated-runtime-managers").withRuntimeUse)(unique, run, {userDataDir}) : run();
}
module.exports = {exportVideo, exportPlan, outputFile, dimensions};
