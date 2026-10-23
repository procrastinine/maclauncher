const fs = require("node:fs"), path = require("node:path");
const Live = require("./live-controls"), Writable = require("../writable-input");
const Resources = require("./live-resources");
const validPid = value => Number.isSafeInteger(value) && value > 0;
function matches(launch, runningPids) {
  return runningPids === undefined || Boolean(launch && validPid(launch.pid) && Array.isArray(runningPids) && runningPids.includes(launch.pid));
}
function read(entry, {userDataDir, runningPids} = {}) {
  if (Array.isArray(runningPids) && !runningPids.length) return null;
  try {
    const launch = JSON.parse(fs.readFileSync(path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json"), "utf8"));
    return matches(launch, runningPids) ? launch : null;
  } catch { return null; }
}
// Revalidate after asynchronous preparation. Callers perform the synchronous
// publication immediately afterward, without yielding to another lifecycle edit.
function isCurrent(entry, launch, options = {}) {
  if (options.isCurrent !== undefined && (typeof options.isCurrent !== "function" || options.isCurrent() !== true)) return false;
  const current = read(entry, {userDataDir: options.userDataDir});
  return !launch ? !current : Boolean(current && current.launchId === launch.launchId && current.pid === launch.pid && current.phase === launch.phase);
}
function modelForNode(launch, node) {
  const settings = node.settings || {}, capability = node.method === "ls1" ? settings.ls1Mode === "performance" ? "ls1Performance" : "ls1Quality" :
    node.method === "lsfg" ? "lsfg" + (settings.lsfgFp16 === false ? "Fp32" : "Fp16") + (settings.lsfgMode === "performance" ? "Performance" : "Quality") : null;
  if (!capability) return null;
  const requested = settings.modelVersion;
  const matches = Object.entries(launch?.effectPlanBindings || {}).filter(([version, binding]) =>
    (!requested || requested === version) && launch.effectPlanModels?.includes(binding?.path) && binding.capabilities?.includes(capability));
  const previous = !requested && matches.find(([version]) => version === launch?.liveModelVersion);
  return previous ? previous[0] : matches.length === 1 ? matches[0][0] : null;
}
function allowsModel(launch, file, kind) {
  return (kind === "neural" ? launch?.effectPlanNeuralModels : launch?.effectPlanModels)?.includes(file) === true ||
    Resources.allowsModel(launch?.effectPlanLiveResources, file, kind);
}
function allowsNeural(launch, file, library) {
  const bound = launch?.effectPlanLiveResources?.neuralLibrary || launch?.effectPlanNeuralLibrary;
  if (!bound || !allowsModel(launch, file, "neural")) return false;
  if (library === undefined || bound === library) return true;
  // Dormant activation reserves a fixed path without provider discovery. Only
  // an actual neural selection resolves aliases, after provider validation.
  if (typeof library !== "string" || !path.isAbsolute(library)) return false;
  try { return fs.realpathSync(bound) === fs.realpathSync(library); } catch { return false; }
}
function managedModel(launch, node) {
  const root = launch?.effectPlanLiveResources?.modelRoots?.lossless, version = node.settings?.modelVersion;
  // An omitted version is selected and validated from the installed catalog
  // during preparation. This admission check does not validate model contents.
  if (!version) return Boolean(root && launch.effectPlanLiveResources.schema === 1);
  return /^sha256-[a-f0-9]{64}$/.test(version) && typeof root === "string" &&
    Resources.allowsModel(launch.effectPlanLiveResources, path.join(root, version, "Lossless.dll"), "lossless");
}
async function resolveModel(launch, userDataDir, version, capability, options) {
  const binding = launch?.effectPlanBindings?.[version];
  if (binding && launch.effectPlanModels?.includes(binding.path)) {
    if (!binding.capabilities?.includes(capability)) throw new Error("The bound Lossless Scaling models do not support that mode. Choose a compatible mode or restart the game.");
    return {modelPath: binding.path};
  }
  const model = await require("./models").resolveModel(userDataDir, version, capability, options);
  if (!Resources.allowsModel(launch?.effectPlanLiveResources, model.modelPath, "lossless"))
    throw new Error("Restart the game to use models outside its authorized graphics storage.");
  return model;
}
function nodeUnavailableReason(launch, node, neuralLibrary) {
  if (launch?.effectPlanAPI !== 1) return "The running game has no ordered graphics connection.";
  if (!node.enabled) return null;
  if (node.kind === "neural" && !allowsNeural(launch, node.settings.modelPath, neuralLibrary))
    return "The neural provider or selected model is unavailable to this running game. An installed compatible model can be selected during play.";
  if (node.kind === "temporal" && !(launch.effectPlanTemporalMethods || launch.liveTemporalMethods || []).includes(node.method))
    return "The running renderer has no matching scene-input binding for this temporal method.";
  if (["ls1", "lsfg"].includes(node.method) && !modelForNode(launch, node) && !managedModel(launch, node))
    return "The selected Lossless Scaling model or mode is unavailable to this running game. Import or select a compatible model.";
  return null;
}
function supportsPlan(launch, plan, neuralLibrary) {
  return launch?.effectPlanAPI === 1 && (!plan || plan.video.every(node => !nodeUnavailableReason(launch, node, neuralLibrary)));
}
// Called only after optional preparation produced the child's environment.
// Reading an old record never makes it a binding for an unfiltered launch.
function bind(entry, pid, {userDataDir} = {}) {
  if (!validPid(pid)) return false;
  const launch = read(entry, {userDataDir});
  if (launch?.schema !== 1 || launch.phase !== "prepared" || typeof launch.launchId !== "string") return false;
  const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json");
  Writable.atomicWrite(file, JSON.stringify({...launch, pid, phase: "spawned", boundAt: new Date().toISOString()}), {root: userDataDir});
  return true;
}
module.exports = {matches, read, bind, isCurrent, supportsPlan, nodeUnavailableReason, modelForNode, allowsModel, allowsNeural, resolveModel};
