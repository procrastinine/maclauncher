const fs = require("node:fs"), path = require("node:path");
const Live = require("./live-controls"), Writable = require("../writable-input");
const Resources = require("./live-resources");
const Publication = require("./publication"), crypto = require("node:crypto");
const payloadCache = new Map(), recoveries = new Map();
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const launchIdentity = value => typeof value === "string" && /^[\w-]{1,128}$/.test(value);
function payloadFiles(entry, userDataDir, launchId) {
  if (!launchIdentity(launchId)) throw new Error("The graphics launch identity is invalid.");
  const root = path.join(userDataDir, "graphics", "payload-bindings");
  Writable.assertOwnDirectory(userDataDir, root);
  return {root, record: path.join(root, hash(path.resolve(Live.file(entry, userDataDir)) + "\0" + launchId) + ".json")};
}
function rememberPayload(entry, launch, payload, {userDataDir} = {}) {
  const files = payloadFiles(entry, userDataDir, launch.launchId), bytes = JSON.stringify(payload), snapshot = hash(bytes);
  const snapshots = path.join(files.root, "snapshots");Writable.assertOwnDirectory(files.root, snapshots);
  const file = path.join(snapshots, snapshot + ".json");
  if (!fs.existsSync(file)) Writable.atomicWrite(file, bytes, {root: userDataDir});
  const record = {schema: 1, launchId: launch.launchId, phase: launch.phase, ...(validPid(launch.pid) ? {pid: launch.pid} : {}), snapshot};
  Writable.atomicWrite(files.record, JSON.stringify(record), {root: userDataDir});
  payloadCache.set(files.record, {record, payload});return payload;
}
// This input comes from trusted preparation, never from launch.json paths.
function preparePayload(entry, launch, root, options) {
  const payload = Publication.snapshot(root);
  return payload ? Boolean(rememberPayload(entry, launch, payload, options)) : false;
}
function payload(entry, options = {}) {
  const launch = options.launchBinding || read(entry, options);
  if (launch?.schema !== 1 || launch.phase !== "spawned" || !validPid(launch.pid) || !matches(launch, options.runningPids)) return null;
  try {
    const files = payloadFiles(entry, options.userDataDir, launch.launchId), cached = payloadCache.get(files.record);
    if (cached?.record.pid === launch.pid && cached.record.launchId === launch.launchId && cached.record.phase === "spawned") return cached.payload;
    const stat = fs.lstatSync(files.record);if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return null;
    const record = JSON.parse(fs.readFileSync(files.record, "utf8"));
    if (record.schema !== 1 || record.phase !== "spawned" || record.pid !== launch.pid || record.launchId !== launch.launchId || !/^[a-f0-9]{64}$/.test(record.snapshot || "")) return null;
    const file = path.join(files.root, "snapshots", record.snapshot + ".json"), source = fs.lstatSync(file);
    if (!source.isFile() || source.isSymbolicLink() || source.size > 4 * 1024 * 1024) return null;
    const bytes = fs.readFileSync(file, "utf8");if (hash(bytes) !== record.snapshot) return null;
    const snapshot = JSON.parse(bytes), accepted = Publication.restore(snapshot.root, snapshot.manifest);
    payloadCache.set(files.record, {record, payload: accepted});return accepted;
  } catch {return null;}
}
async function resolvePayload(entry, options = {}) {
  const launch = options.launchBinding || read(entry, options);
  if (!launch || !validPid(launch.pid) || launch.phase !== "spawned" || !matches(launch, options.runningPids)) return null;
  // Seed only application-owned resource bases before restoring a receipt.
  require("./index").runtimeRoot(options.app);
  const previous = payload(entry, {...options, launchBinding: launch});if (previous) return previous;
  const key = path.resolve(Live.file(entry, options.userDataDir)) + ":" + launch.launchId + ":" + launch.pid;
  if (recoveries.has(key)) return recoveries.get(key);
  const recovery = (async () => {
    try {
      const execute = require("node:util").promisify(require("node:child_process").execFile), pids = new Set([launch.pid]);
      const listing = await execute("/bin/ps", ["-axo", "pid=,ppid="], {timeout: 2000, maxBuffer: 2 * 1024 * 1024});
      const processes = listing.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
      for (let changed = true; changed && pids.size < 512;) {changed = false;for (const [pid, parent] of processes) if (pids.has(parent) && !pids.has(pid)) {pids.add(pid);changed = true;}}
      let output;try {output = await execute("/usr/sbin/lsof", ["-a", "-p", [...pids].join(","), "-d", "txt", "-Fn"], {timeout: 3000, maxBuffer: 4 * 1024 * 1024});}
      catch (error) {output = {stdout: error.stdout || ""};}
      const roots = [...new Set(output.stdout.split("\n").filter(line => line.startsWith("n/") && line.endsWith("/libreshade-macos.dylib")).map(line => path.dirname(line.slice(1))))];
      if (roots.length !== 1 || !isCurrent(entry, launch, options)) return null;
      const accepted = Publication.restoreSealed(roots[0]);return rememberPayload(entry, launch, accepted, options);
    } catch {return null;}
  })();
  recoveries.set(key, recovery);try {return await recovery;} finally {recoveries.delete(key);}
}
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
// A model installed after launch can run live only when this launch bound a
// neural library and reserved the managed neural model store.
function acceptsNeuralModels(launch) {
  const resources = launch?.effectPlanLiveResources;
  return Boolean((resources?.neuralLibrary || launch?.effectPlanNeuralLibrary) && resources?.schema === 1 &&
    typeof resources.modelRoots?.neural === "string" && path.isAbsolute(resources.modelRoots.neural));
}
function managedModel(launch, node) {
  const root = launch?.effectPlanLiveResources?.modelRoots?.lossless, version = node.settings?.modelVersion;
  // An omitted version is selected and validated from the installed catalog
  // during preparation. This admission check does not validate model contents.
  if (!version) return Boolean(root && launch.effectPlanLiveResources.schema === 1);
  if (require("../runtime/custom-runtime").isPath(version)) {
    const binding = launch?.effectPlanBindings?.[version];
    return Boolean(binding?.path && allowsModel(launch, binding.path, "lossless"));
  }
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
  if (!allowsModel(launch, model.modelPath, "lossless"))
    throw new Error("Restart the game to use models outside its authorized graphics storage.");
  return model;
}
function resolveNeuralNode(node,options={}){
  const {userDataDir,settings,neuralModels}=options;
  if(!node.enabled||node.settings?.modelPath||!userDataDir)return node;
  const operation=require('../effects/providers').modelOperation(node,options);if(!operation)return node;
  const model=require('../effects/neural-selection.mjs').selectNeuralModel(operation,neuralModels||require('./neural').listModels(userDataDir),{defaultVersion:require('../runtime/custom-runtime').defaultVersion(settings,'graphics-neural-models'),defaultVersions:settings?.runtimes?.['graphics-neural-models']?.defaultVersions});
  return model?{...node,settings:{...node.settings,modelPath:model.modelPath}}:node;
}
function nodeUnavailableReason(launch, node, neuralLibrary,options) {
  if (node.enabled && launch?.graphicsAttachment?.available === false) return launch.graphicsAttachment.reason;
  node=resolveNeuralNode(node,options);
  if (launch?.effectPlanAPI !== 1) return "The running game has no ordered graphics connection.";
  if (!node.enabled) return null;
  if (require("../effects/providers").modelOperation(node,options) && !allowsNeural(launch, node.settings?.modelPath, neuralLibrary))
    return "The neural provider or selected model is unavailable to this running game. An installed compatible model can be selected during play.";
  if (node.kind === "temporal" && !require("../effects/providers").neural(node) && !(node.method==="xess"&&launch.effectPlanLiveResources?.xess) && !launch.effectPlanLiveResources?.temporal?.methods?.includes(node.method) && !(launch.effectPlanTemporalMethods || launch.liveTemporalMethods || []).includes(node.method))
    return "The running renderer has no matching scene-input binding for this temporal method.";
  if (["ls1", "lsfg"].includes(node.method) && !modelForNode(launch, node) && !managedModel(launch, node))
    return "The selected Lossless Scaling model or mode is unavailable to this running game. Import or select a compatible model.";
  return null;
}
function supportsPlan(launch, plan, neuralLibrary,options) {
  return launch?.effectPlanAPI === 1 && (!plan || plan.enabled === false || plan.video.every(node => !nodeUnavailableReason(launch, node, neuralLibrary,options)));
}
function attachmentUnavailable(entry, reason, {userDataDir} = {}) {
  const launch = read(entry, {userDataDir});
  if (launch?.schema !== 1 || launch.phase !== "prepared" || !launchIdentity(launch.launchId)) return false;
  const detail = String(reason || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
  if (!detail) return false;
  const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json");
  const warnings = (Array.isArray(launch.graphicsWarnings) ? launch.graphicsWarnings : []).filter(row => row.id !== "native-attachment");
  Writable.atomicWrite(file, JSON.stringify({...launch, graphicsAttachment: {available: false, reason: detail},
    graphicsWarnings: [...warnings, {id: "native-attachment", reason: detail}]}), {root: userDataDir});
  return true;
}
// Called only after optional preparation produced the child's environment.
// Reading an old record never makes it a binding for an unfiltered launch.
function bind(entry, pid, {userDataDir} = {}) {
  if (!validPid(pid)) return false;
  const launch = read(entry, {userDataDir});
  if (launch?.schema !== 1 || launch.phase !== "prepared" || typeof launch.launchId !== "string") return false;
  const file = path.join(path.dirname(Live.file(entry, userDataDir)), "launch.json");
  Writable.atomicWrite(file, JSON.stringify({...launch, pid, phase: "spawned", boundAt: new Date().toISOString()}), {root: userDataDir});
  try {
    const files = payloadFiles(entry, userDataDir, launch.launchId), cached = payloadCache.get(files.record);
    if (cached && cached.record.phase === "prepared") rememberPayload(entry, {...launch, pid, phase: "spawned"}, cached.payload, {userDataDir});
    else if (fs.existsSync(files.record)) {
      const record = JSON.parse(fs.readFileSync(files.record, "utf8"));
      if (record.schema === 1 && record.launchId === launch.launchId && record.phase === "prepared")
        Writable.atomicWrite(files.record, JSON.stringify({...record, pid, phase: "spawned"}), {root: userDataDir});
    }
  } catch { /* Mapped-image recovery remains available for older launches. */ }
  if(launch.effectPlanLiveResources?.xess)require("../runtime/gpu-compute-broker").bind(launch.effectPlanLiveResources.xess,pid);
  return true;
}
module.exports = {matches, read, bind, isCurrent, supportsPlan, nodeUnavailableReason,resolveNeuralNode, modelForNode, allowsModel, allowsNeural, acceptsNeuralModels, resolveModel, attachmentUnavailable,
  preparePayload, payload, resolvePayload};
