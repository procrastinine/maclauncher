const fs = require("node:fs"), path = require("node:path");
const Source = require("./source.json"), Native = require("../../runtime/bundled-native");
const DEFAULTS = Object.freeze({ modelPath: null, temporal: false, intensity: 1 });
let physicalArchitecture;
function hostArchitecture() {
  if(physicalArchitecture)return physicalArchitecture;
  physicalArchitecture=process.arch;
  if(process.platform==="darwin"&&process.arch==="x64")try{
    if(require("node:child_process").execFileSync("/usr/sbin/sysctl",["-n","hw.optional.arm64"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()==="1")physicalArchitecture="arm64";
  }catch{}
  return physicalArchitecture;
}
function settings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key)))
    throw new Error("Choose supported neural rendering settings.");
  const result = { ...DEFAULTS, ...value };
  if (result.modelPath !== null && (typeof result.modelPath !== "string" || !path.isAbsolute(result.modelPath) || /[\0\r\n]/.test(result.modelPath)) ||
      typeof result.temporal !== "boolean" || typeof result.intensity !== "number" || !Number.isFinite(result.intensity) || result.intensity < 0 || result.intensity > 1)
    throw new Error("Choose a local model, temporal mode and an intensity from 0 to 1.");
  return result;
}
function inspectedModel(file,method) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error("Choose a local neural model package.");
  const inspected=require("./models").inspectPackage(fs.realpathSync(file));
  if(method&&inspected.operation!==method&&!(method==="mlx-sr-scene"&&inspected.operation==="mlx-sr-image"))
    throw new Error("The selected model belongs to a different neural operation.");
  return inspected;
}
function model(file,method){return inspectedModel(file,method).canonical;}
function packageScale(inspected,method){
  const operation=require("../../effects/providers").MODEL_OPERATIONS[method||inspected.operation];
  const scale=require("./restoration-models").ARCHITECTURES[inspected.value.architecture]?.scale||operation?.scale||1;
  if(operation?.scales&&!operation.scales.includes(scale))throw new Error("The selected model has an unsupported intrinsic output scale.");
  return scale;
}
function modelScale(file,method){return packageScale(inspectedModel(file,method),method);}
const OPERATIONS=Object.freeze({"mlx-dlss":"neural-rendering","mlx-vsr":"video-super-resolution","mlx-sr-image":"image-super-resolution","mlx-sr-scene":"scene-super-resolution","mlx-interpolation":"interpolation","realesrgan":"image-restoration","nafnet":"image-restoration","realcugan":"image-restoration","rife":"interpolation"});
const ATTACHMENTS=Object.freeze({"depth-anything-v2-small":"relative-inverse-depth"});
function settingsForMethod(method,value={}) {
  if(!Object.hasOwn(OPERATIONS,method))throw new Error("Choose a supported neural operation.");
  const {method:_method,operation:_operation,denoiseStrength=1,...fields}=value||{};
  if(method!=="realesrgan"&&value?.denoiseStrength!=null||typeof denoiseStrength!=="number"||!Number.isFinite(denoiseStrength)||denoiseStrength<0||denoiseStrength>1)throw new Error("Choose a denoise strength from 0 to 1 for paired general SRVGG weights.");
  const selected=settings(fields);
  if(["mlx-vsr","realesrgan","nafnet","realcugan"].includes(method))selected.temporal=false;
  if(["realesrgan","realcugan","nafnet","rife"].includes(method))selected.intensity=1;
  if(method==="rife")selected.temporal=false;
  if(method==="realesrgan")selected.denoiseStrength=denoiseStrength;
  return {...selected,method,operation:OPERATIONS[method]};
}
function prepareMethod(method,value,context) {
  const selected=settingsForMethod(method,value),prepared=prepare({modelPath:selected.modelPath,intensity:selected.intensity,temporal:selected.temporal},{...context,modelOperation:method});
  if(method!=="mlx-dlss") {
    const installed=resolve(context.root,context);
    if(!installed?.descriptor.operations?.includes(method))throw new Error("This neural operation requires an updated graphics provider.");
  }
  return {...prepared,settings:{...prepared.settings,method,operation:OPERATIONS[method],...(method==="realesrgan"?{denoiseStrength:selected.denoiseStrength}:{})}};
}
// A dormant process needs the immutable path for future live selections. This
// is an authorization candidate, not provider discovery or compatibility proof.
// Explicit preparation validates the provider and its complete closure.
function libraryPath(root, {platform = process.platform, graphicsArchitecture = process.arch,hostArchitecture:physicalHost} = {}) {
  return platform === "darwin" && (physicalHost==null||physicalHost==="arm64") && ["arm64","x64","x86_64"].includes(graphicsArchitecture) && path.isAbsolute(root || "") ?
    path.join(root, "neural", Source.library) : null;
}
function resolve(root, { platform = process.platform, macOSVersion, graphicsArchitecture = process.arch,hostArchitecture:physicalHost } = {}) {
  if (platform !== "darwin" || (physicalHost||hostArchitecture())!=="arm64" || !["arm64","x64","x86_64"].includes(graphicsArchitecture) || !Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), Source.minimumMacOS)) return null;
  try {
    const directory = fs.realpathSync(path.join(root, "neural")), descriptor = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
    if (descriptor.providerABI !== Source.providerABI || descriptor.commit !== Source.commit || descriptor.library !== Source.library ||
        descriptor.minimumMacOS !== Source.minimumMacOS || descriptor.architectures?.join() !== "arm64" || !Array.isArray(descriptor.files)) return null;
    if(descriptor.operations!=null&&(!Array.isArray(descriptor.operations)||descriptor.operations.some(method=>!Object.hasOwn(OPERATIONS,method)&&!Object.hasOwn(ATTACHMENTS,method))))return null;
    if(descriptor.operations?.some(method=>Object.hasOwn(ATTACHMENTS,method))&&descriptor.estimatedDepthAPI!==1)return null;
    const library = path.join(directory, Source.library);
    if (!fs.statSync(library).isFile()) return null;
    const service=graphicsArchitecture!=="arm64";
    if(service&&(!descriptor.files.some(row=>row.path==="maclauncher-neural-service")||!fs.statSync(path.join(directory,"maclauncher-neural-service")).isFile()))return null;
    return { directory, library, descriptor,execution:service?"service":"in-process",supportedMethods:descriptor.operations||["mlx-dlss"] };
  } catch { return null; }
}
function prepare(value, { root, ...options }) {
  const selected = settings(value), installed = resolve(root, options);
  if (!installed) throw new Error("The neural GPU provider is unavailable for this processor, system or architecture.");
  const expected=options.modelOperation||"mlx-dlss";
  if(Object.hasOwn(ATTACHMENTS,expected)&&(!installed.supportedMethods.includes(expected)||installed.descriptor.estimatedDepthAPI!==1))
    throw new Error("The selected graphics provider does not supply scalar relative-depth inference.");
  if (!selected.modelPath) throw new Error("Choose a local neural rendering model.");
  // Verify the immutable provider closure only on explicit preparation. A file
  // verified earlier in this process is reused (decision D3(b)); each launch
  // checks the neural directory's identities beforehand.
  for (const row of installed.descriptor.files) {
    if (typeof row.path !== "string" || path.isAbsolute(row.path) || row.path.split(/[\\/]/).some(part => !part || part === "..") || !/^[a-f0-9]{64}$/.test(row.sha256 || ""))
      throw new Error("The neural rendering provider inventory is invalid.");
    if (row.path.startsWith("notices/") || row.path === "maclauncher-neural-video" && !options.offlineVideo) continue;
    try { require("../payload-verification").verifyFile(installed.directory, row, {reuse: true}); }
    catch { throw new Error("The neural rendering provider changed. Reinstall the selected provider."); }
  }
  if (!installed.descriptor.files.some(row => row.path === Source.library)) throw new Error("The neural provider library is missing from its inventory.");
  const inspected=inspectedModel(selected.modelPath,expected),intrinsicScale=packageScale(inspected,expected);
  const operation=require("../../effects/providers").MODEL_OPERATIONS[expected],architectures=installed.descriptor.modelArchitectures?.[expected];
  if(operation?.scales&&(Array.isArray(architectures)?!architectures.includes(inspected.value.architecture):intrinsicScale!==operation.scale))
    throw new Error("The selected graphics provider does not supply this model architecture. Select a compatible provider or model.");
  return { settings: { ...selected, modelPath: inspected.canonical }, intrinsicScale,
    environment: { RESHADE_NEURAL_LIBRARY: installed.library, RESHADE_NEURAL_ROOT: installed.directory },execution:installed.execution };
}
module.exports = { DEFAULTS, settings,settingsForMethod,prepareMethod,OPERATIONS, model, modelScale,libraryPath, resolve, prepare,
  listModels: userDataDir => require("./models").listInstalled(userDataDir),
  modelIdentity: (userDataDir, modelPath) => require("./models").identityForPath(userDataDir, modelPath) };
