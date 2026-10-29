const GraphicsSettings = require("./graphics-settings"), Neural = require("./neural");
const NeuralModels = require("./neural/models"), LosslessModels = require("./models"), Sources = require("./model-sources");
const { isAbortError, throwIfAborted, createAbortError } = require("../runtime/download-utils");

function requiredCapabilities(graphics) {
  const required = [];
  if (graphics.spatialMethod === "ls1") required.push(graphics.ls1Mode === "quality" ? "ls1Quality" : "ls1Performance");
  if (graphics.frameGeneration === "lsfg") required.push("lsfg" + (graphics.lsfgFp16 ? "Fp16" : "Fp32") +
    (graphics.lsfgMode === "quality" ? "Quality" : "Performance"));
  return required;
}
function ordered(rows, preferred) {
  const ranks = new Map();
  preferred.forEach((version, index) => { if (version && !ranks.has(version)) ranks.set(version, index); });
  return [...rows].sort((a, b) => (ranks.get(a.version) ?? preferred.length) - (ranks.get(b.version) ?? preferred.length));
}
async function ensureGraphicsModel(options = {}, dependencies = {}) {
  const { entry, kind, patch = {}, settings = {}, userDataDir, runRuntimeAction, chooseLosslessSource, signal } = options;
  if (!["neural", "lossless"].includes(kind)) throw new Error("Choose a supported graphics model type.");
  const graphics = GraphicsSettings.updateSettings(entry?.graphics, patch);
  const neural = dependencies.neural || Neural, neuralModels = dependencies.neuralModels || NeuralModels;
  const lossless = dependencies.losslessModels || LosslessModels, sources = dependencies.sources || Sources;
  // Acquisition is an independently visible manager task. Off stops waiting
  // for it immediately; a late installation cannot choose or enable a model.
  // Do not cancel a shared manager download another game may already use.
  function current(work) {
    throwIfAborted(signal);
    if (!signal) return work();
    return new Promise((resolve, reject) => {
      const abort = () => {cleanup();reject(signal.reason || createAbortError());};
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, {once: true});
      Promise.resolve().then(() => {throwIfAborted(signal);return work();}).then(value => {
        cleanup();if (signal.aborted) abort();else resolve(value);
      }, error => {cleanup();reject(error);});
    });
  }
  async function action(manager, verb, payload) {
    throwIfAborted(signal);
    if (typeof runRuntimeAction !== "function") throw new Error("Graphics model setup is unavailable.");
    const result = await current(() => runRuntimeAction(manager, verb, payload));
    throwIfAborted(signal);
    return result;
  }
  try {
    throwIfAborted(signal);
    if (kind === "neural") {
      if (graphics.neuralModelPath) {
        try { return { modelPath: neural.model(graphics.neuralModelPath) }; }
        catch (error) { if (isAbortError(error)) throw error; }
      }
      const selected = settings.runtimes?.[NeuralModels.ID]?.defaultVersions?.['mlx-dlss']||require('../runtime/custom-runtime').defaultVersion(settings,NeuralModels.ID);
      async function installedNeural(preferred) {
        for (const row of ordered(neuralModels.listInstalled(userDataDir).filter(row=>require('../effects/neural-selection.mjs').compatibleNeuralModel(row,'mlx-dlss')), preferred)) {
          try {
            const model = await current(() => neuralModels.resolveModel(userDataDir, row.version, { signal }));
            return { modelPath: model.modelPath };
          } catch (error) { if (isAbortError(error)) throw error; }
        }
        return null;
      }
      const existing = await installedNeural([selected]);
      if (existing) return existing;
      const result = await action(NeuralModels.ID, "setup", { setupActionId: "downloadDlssMac" });
      const installed = await installedNeural([result?.version, selected]);
      if (installed) return installed;
      // A managed action can return its verified installation directly. Boolean
      // service results after declined consent contain no model selection.
      if (typeof result?.modelPath === "string") return { modelPath: neural.model(result.modelPath) };
      return null;
    }

    const required = requiredCapabilities(graphics);
    if (!required.length) return null;
    const preferred = [graphics.modelVersion, require("../runtime/custom-runtime").defaultVersion(settings, "graphics-models")];
    const compatible = row => row?.ready !== false && required.every(capability => row?.inspection?.capabilities?.[capability]?.compatible === true);
    async function installedLossless(result) {
      for (const row of ordered(lossless.listInstalled(userDataDir), [result?.version, ...preferred])) {
        if (!compatible(row)) continue;
        try {
          for (const capability of required) await current(() => lossless.resolveModel(userDataDir, row.version, capability, { signal }));
          return { modelVersion: row.version };
        } catch (error) { if (isAbortError(error)) throw error; }
      }
      // Import/setup results already passed their manager's checksum and resource
      // inspection. This also supports callers that supply the managed action API.
      return /^sha256-[a-f0-9]{64}$/.test(result?.version || "") && compatible(result) ? { modelVersion: result.version } : null;
    }
    const existing = await installedLossless();
    if (existing) return existing;
    let reason = "Compatible Lossless Scaling models are required for the selected settings.";
    try {
      const found = await current(() => sources.findModels(options));
      throwIfAborted(signal);
      if (found.length) {
        const result = await action("graphics-models", "setup", { setupActionId: "findInstalled" });
        if (result === false || result == null) return null;
        const imported = await installedLossless(result);
        if (imported) return imported;
        reason = "The installed copies do not support all selected Lossless Scaling settings.";
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      reason = String(error.message || reason).slice(0, 1024);
    }
    if (typeof chooseLosslessSource !== "function") return null;
    const choice = await current(() => chooseLosslessSource({ reason, requiredCapabilities: [...required] }));
    throwIfAborted(signal);
    if (choice == null) return null;
    if (!["download", "import"].includes(choice)) throw new Error("Choose a supported Lossless Scaling model source.");
    const result = choice === "download"
      ? await action("graphics-models", "setup", { setupActionId: "downloadSteam" })
      : await action("graphics-models", "import", {});
    if (result === false || result == null) return null;
    const selected = await installedLossless(result);
    if (selected) return selected;
    if (typeof result !== "object") return null;
    throw new Error("The imported models do not support all selected Lossless Scaling settings. Choose a compatible DLL or different settings.");
  } catch (error) { if (isAbortError(error)) return null; throw error; }
}
module.exports = { ensureGraphicsModel, requiredCapabilities };
