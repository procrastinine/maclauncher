const path = require("node:path");
const Native = require("../runtime/bundled-native");
const providers = [
  { format: "native", gpuWorkScope: "caller-command-buffer", extensions: [".mclfilter"], label: "Native image effects", module: "./native-filter", rootEnvironment:"RESHADE_NATIVE_FILTER_ROOT" },
  { format: "slangp", gpuWorkScope: "caller-command-buffer", extensions: [".slangp", ".slang"], label: "RetroArch Slang", module: "./retroarch", rootEnvironment: "RESHADE_RETROARCH_ROOT" },
  { format: "libplacebo", gpuWorkScope: "external-queues", extensions: [".glsl", ".hook", ".cube", ".plfilter"], label: "libplacebo", module: "./libplacebo", rootEnvironment: "RESHADE_LIBPLACEBO_ROOT" },
  { format: "magpie", gpuWorkScope: "caller-command-buffer", extensions: [".hlsl"], label: "MagpieFX", module: "./magpie", rootEnvironment: "RESHADE_MAGPIE_ROOT" },
  { format: "isf", gpuWorkScope: "caller-command-buffer", extensions: [".fs", ".isf"], label: "ISF", module: "./isf", rootEnvironment: "RESHADE_ISF_ROOT" }
];
const sourceExtensions=Object.freeze([".fx",...providers.flatMap(provider=>provider.extensions)]);
function entryFile(format) {return ({fx:"effect.prepared.fx",slang:"effect.slangp",slangp:"effect.slangp",libplacebo:"effect.hook",isf:"effect.isf",magpie:"effect.magpie.json",native:"effect.mclfilter"})[format||"fx"]||null;}
function sourceFormat(file){return packaged(file)?.format||"fx";}
function gpuWorkScope(format){
  if(!format||format==="fx")return "caller-command-buffer";
  return providers.find(provider=>provider.format===(format==="slang"?"slangp":format))?.gpuWorkScope;
}
function sceneInputsAvailability(format,bindings,{features={}}={}){
  const selected=require("./shader-scene-bindings").validate(bindings),roles=[...new Set(Object.values(selected))];
  if(!roles.length)return null;
  const key=format==="slang"?"slangp":format||"fx",label=key==="fx"?"ReShadeFX":providers.find(provider=>provider.format===key)?.label||key,
    capability=features.providers?.[key];
  if(features.sceneInputsAPI!==1||capability?.sceneInputsAPI!==1)return `The selected ${label} processor does not support named scene inputs.`;
  const unsupported=roles.filter(role=>!capability.sceneInputRoles?.includes(role));
  return unsupported.length?`The ${label} provider cannot bind ${unsupported.map(require("../effects/operation-contracts.mjs").sceneInputLabel).join(", ")}.`:null;
}
function sceneHistoryAvailability(format,history,{features={}}={}){
  if(!history)return null;
  if(history!=="real")return "The shader history contract is unsupported.";
  const key=format==="slang"?"slangp":format||"fx";
  return features.sceneHistoryAPI===1&&features.providers?.[key]?.sceneHistoryAPI===1?null:
    "The selected shader processor does not support real-frame scene history.";
}
function traitsAvailability(format,traits={},options={}){
  return traits.sourceError||require("./shader-input-policy").availability(traits.inputPolicy,options)||
    sceneInputsAvailability(format,traits.sceneBindings,options)||sceneHistoryAvailability(format,traits.sceneHistory,options);
}
function packaged(file) {
  const extension = path.extname(file || "").toLowerCase(), provider = providers.find(row => row.extensions.includes(extension));
  if(!provider)return null;
  const implementation=require(provider.module);
  return { ...provider, ...implementation, sourceFile:file,
    inspect:async(source,options)=>{
      const Traits=require("./shader-traits"),fs=require("node:fs"),analysis=Traits.analyzeFile(source,provider.format);
      if(analysis.traits.sourceError)throw Error(analysis.traits.sourceError);
      const metadata=await implementation.inspect(source,options);
      if(!Traits.current(analysis,fs.statSync(source)))throw Error("The shader source changed during inspection. Retry the edit.");
      return sourceMetadata(null,provider.format,{...metadata,sourceRevision:analysis.sourceRevision,traits:{...analysis.traits,...metadata.traits}});
    },
    prepare:async(source,options)=>{
      const Traits=require("./shader-traits"),fs=require("node:fs"),analysis=Traits.analyzeFile(source,provider.format);
      if(analysis.traits.sourceError)throw Error(analysis.traits.sourceError);
      const reason=traitsAvailability(provider.format,analysis.traits,{features:options.features});if(reason)throw Error(reason);
      const result=await implementation.prepare(source,options);
      if(!Traits.current(analysis,fs.statSync(source)))throw Error("The shader source changed during preparation. Retry the edit.");
      // Read geometry from the immutable provider output, including expanded
      // Slang references and the actual Magpie compiler declaration.
      const metadata=provider.format==="magpie"
        ? sourceMetadata(null,provider.format,{...result.metadata,traits:JSON.parse(fs.readFileSync(result.effect,"utf8")).traits})
        : sourceMetadata(result.effect,provider.format,result.metadata);
      if(analysis.traits.inputPolicy){metadata.inputPolicy=analysis.traits.inputPolicy;metadata.traits={...metadata.traits,inputPolicy:analysis.traits.inputPolicy,...(analysis.traits.inputPolicy==="linear-source"?{sharedOnly:true}:{})};}
      if(analysis.traits.sceneBindings){metadata.sceneBindings=analysis.traits.sceneBindings;metadata.traits={...metadata.traits,sceneBindings:analysis.traits.sceneBindings,sceneInputs:analysis.traits.sceneInputs};}
      if(analysis.traits.sceneHistory)metadata.traits={...metadata.traits,sceneHistory:analysis.traits.sceneHistory};
      // A provider may rewrite comments out of its immutable entry. Preserve
      // the verified source declaration, checked against prepared geometry.
      if(analysis.traits.outputResize!==undefined){
        metadata.traits=require("./shader-resize-contract").apply("// @OUTPUT_RESIZE "+analysis.traits.outputResize,metadata.traits);
        metadata.outputContract=Traits.outputContract(metadata.traits);
      }
      metadata.sourceRevision=analysis.sourceRevision;
      return {...result,metadata};
    }
  };
}
function sourceMetadata(file,format,metadata){
  const Traits=require("./shader-traits"),analyzed=file?Traits.analyzeFile(file,format).traits:{};
  const traits={...analyzed,...metadata.traits,
    ...(Array.isArray(metadata.stages)?{stages:metadata.stages}:{}),
    ...(typeof metadata.rgbCompatible==="boolean"?{rgbCompatible:metadata.rgbCompatible}:{}),
    ...(typeof metadata.requiresDerivedPlanes==="boolean"?{requiresDerivedPlanes:metadata.requiresDerivedPlanes}:{})};
  if(traits.inputPolicy==="linear-source")traits.sharedOnly=true;
  return {...metadata,traits,outputContract:Traits.outputContract(traits),...(traits.inputPolicy?{inputPolicy:traits.inputPolicy}:{}),...(traits.sceneBindings?{sceneBindings:traits.sceneBindings}:{})};
}
function availability(format, { features = {}, graphicsArchitecture = process.arch, compilerArchitecture=process.arch, macOSVersion,sceneHistory,inputPolicy } = {}) {
  const historyReason=require("./shader-input-policy").availability(inputPolicy,{features})||sceneHistoryAvailability(format,sceneHistory,{features});if(historyReason)return historyReason;
  if (format === "slang") format = "slangp";
  if (!format || format === "fx") return null;
  const provider = providers.find(row => row.format === format);
  if (!provider || !features.formats?.includes(format)) return `The ${provider?.label || format} provider is unavailable in this application build.`;
  const specification = features.providers?.[format], architecture = graphicsArchitecture === "x64" ? "x86_64" : graphicsArchitecture;
  if (specification?.architectures && !specification.architectures.includes(architecture)) return `The ${provider.label} provider requires ${specification.architectures.join(" or ")} game processes.`;
  if (specification?.minimumMacOS && !Native.versionAtLeast(macOSVersion || Native.systemVersionSync(), specification.minimumMacOS))
    return `The ${provider.label} provider requires macOS ${specification.minimumMacOS} or later.`;
  const compilerISA=compilerArchitecture==="x64"?"x86_64":compilerArchitecture,compilerMinimum=specification?.compilerMinimumMacOSByArchitecture?.[compilerISA];
  if(compilerMinimum&&!Native.versionAtLeast(macOSVersion||Native.systemVersionSync(),compilerMinimum))return `The ${provider.label} shader compiler requires macOS ${compilerMinimum} or later on this Mac.`;
  return null;
}
function requireAvailable(provider, options) {
  const reason = availability(provider.format, options)||provider.sourceAvailability?.(provider.sourceFile,options);if (reason) throw new Error(reason);
  return provider;
}
module.exports = { packaged, sourceMetadata, availability, traitsAvailability, sceneInputsAvailability, sceneHistoryAvailability, requireAvailable, entryFile, sourceFormat, sourceExtensions, gpuWorkScope };
