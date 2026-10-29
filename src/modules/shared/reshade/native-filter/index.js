// Typed selection of compiled image algorithms; descriptors contain no code.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Writable=require("../../writable-input"),Bundle=require("../shader-bundle");
const format="native",entryFile="effect.mclfilter",maximum=64*1024;
const fogParameters=Object.freeze([
 {name:"Distance",label:"Distance",type:"float",default:[1000],min:.0001,max:1000000},
 {name:"Opacity",label:"Opacity",type:"float",default:[1],min:0,max:1},
 {name:"CurveStart",label:"Curve start",type:"float",default:[0],min:0,max:1},
 {name:"CurveEnd",label:"Curve end",type:"float",default:[1],min:0,max:1},
 {name:"Center",label:"Center",type:"float",default:[0],min:0,max:1},
 {name:"Curved",label:"Curved",type:"bool",default:[1],min:0,max:1},
 {name:"Dithering",label:"Dithering",type:"bool",default:[1],min:0,max:1},
 {name:"Quantize",label:"Quantization",type:"float",default:[255],min:0,max:255},
 {name:"AutoColor",label:"Automatic color",type:"bool",default:[0],min:0,max:1},
 {name:"Red",label:"Red",type:"float",default:[0],min:0,max:16},
 {name:"Green",label:"Green",type:"float",default:[0],min:0,max:16},
 {name:"Blue",label:"Blue",type:"float",default:[0],min:0,max:16}
]);
const methods=Object.freeze({
 "histogram-exposure":Object.freeze({label:"Histogram exposure",purpose:"Colour and tone",license:"MIT",sourceUrl:"https://github.com/procrastinine/maclauncher",inputPolicy:"source",parameters:Object.freeze([
  {name:"KeyGray",label:"Target gray",type:"float",default:[.18],min:.001,max:1},
  {name:"LowPercentile",label:"Low percentile",type:"float",default:[.1],min:0,max:.99},
  {name:"HighPercentile",label:"High percentile",type:"float",default:[.9],min:.01,max:1},
  {name:"MinEV",label:"Minimum EV",type:"float",default:[-8],min:-24,max:24},
  {name:"MaxEV",label:"Maximum EV",type:"float",default:[8],min:-24,max:24},
  {name:"Compensation",label:"Compensation",type:"float",default:[0],min:-24,max:24},
  {name:"AdaptationSpeed",label:"Adaptation speed",description:"Exposure adaptation per second. Zero applies the measured exposure immediately.",type:"float",default:[3],min:0,max:60},
  {name:"CutThreshold",label:"Cut threshold",description:"EV change for an image-derived histogram cut reset. Zero disables this estimate.",type:"float",default:[4],min:0,max:16}
 ])}),
 "local-laplacian":Object.freeze({label:"Local Laplacian",purpose:"Colour and tone",license:"MIT",sourceUrl:"https://github.com/halide/Halide",revision:"d62903bbf5166e05841e1346837c8367e2296a83",inputPolicy:"srgb-sdr",parameters:Object.freeze([
  {name:"Detail",label:"Detail",type:"float",default:[1],min:-1,max:4},
  {name:"Contrast",label:"Contrast",type:"float",default:[1],min:0,max:4},
  {name:"Samples",label:"Intensity samples",type:"int",default:[8],min:2,max:16}
 ])}),
 "cmaa2":Object.freeze({label:"CMAA2",purpose:"Anti-aliasing and blur",license:"Apache-2.0 and MIT",sourceUrl:"https://github.com/GameTechDev/CMAA2",revision:"071c6b0857559f4e36f614362e6d2aab1b61938a",inputPolicy:"source",parameters:Object.freeze([
  {name:"Quality",label:"Quality",type:"int",default:[2],min:0,max:3,options:[{value:0,label:"Low"},{value:1,label:"Medium"},{value:2,label:"High"},{value:3,label:"Ultra"}]},
  {name:"ExtraSharpness",label:"Preserve detail",type:"bool",default:[0],min:0,max:1}
 ])}),
 "xegtao":Object.freeze({label:"XeGTAO",license:"MIT",sourceUrl:"https://github.com/GameTechDev/XeGTAO",revision:"a5b1686c7ea37788eeb3576b5be47f7c03db532c",inputPolicy:"source",requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true}),sceneInputs:Object.freeze(["depth","projectionMatrix"]),parameters:Object.freeze([
  {name:"Radius",label:"Radius",type:"float",default:[.5],min:.0001,max:100000},
  {name:"Strength",label:"Strength",type:"float",default:[1],min:0,max:1},
  {name:"Quality",label:"Quality",type:"int",default:[2],min:0,max:3,options:[{value:0,label:"Low"},{value:1,label:"Medium"},{value:2,label:"High"},{value:3,label:"Ultra"}]},
  {name:"DenoisePasses",label:"Denoising",type:"int",default:[1],min:0,max:3,options:[{value:0,label:"Off"},{value:1,label:"Sharp"},{value:2,label:"Medium"},{value:3,label:"Soft"}]}
 ])}),
 "cacao":Object.freeze({label:"CACAO",license:"MIT",sourceUrl:"https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",revision:"c6efa6bf7f2027b3ec94f28578bb5965eabb9e55",inputPolicy:"source",requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true}),sceneInputs:Object.freeze(["depth","projectionMatrix"]),parameters:Object.freeze([
  {name:"Radius",label:"Radius",type:"float",default:[1.2],min:.0001,max:100000},
  {name:"Strength",label:"Strength",type:"float",default:[1],min:0,max:5},
  {name:"Quality",label:"Quality",type:"int",default:[4],min:0,max:4,options:[{value:0,label:"Lowest"},{value:1,label:"Low"},{value:2,label:"Medium"},{value:3,label:"High"},{value:4,label:"Adaptive"}]},
  {name:"BlurPasses",label:"Blur",type:"int",default:[2],min:0,max:8},
  {name:"Sharpness",label:"Sharpness",type:"float",default:[.98],min:0,max:1},
  {name:"HalfResolution",label:"Half resolution",type:"bool",default:[0],min:0,max:1},
  {name:"FadeDistance",label:"Fade distance",type:"float",default:[300],min:.0001,max:100000}
 ])}),
 "depth-fog":Object.freeze({label:"Depth fog",license:"MIT",sourceUrl:"https://github.com/luluco250/FXShaders",revision:"76365e35c48e30170985ca371e67d8daf8eb9a98",inputPolicy:"source",requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true}),sceneInputs:Object.freeze(["depth","projectionMatrix"]),parameters:fogParameters}),
 "depth-outlines":Object.freeze({label:"Depth outlines",license:"MIT",sourceUrl:"https://github.com/luluco250/FXShaders",revision:"76365e35c48e30170985ca371e67d8daf8eb9a98",inputPolicy:"source",requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true}),sceneInputs:Object.freeze(["depth","projectionMatrix"]),parameters:Object.freeze([
  {name:"Threshold",label:"Threshold",type:"float",default:[.9],min:0,max:1},
  {name:"Strength",label:"Strength",type:"float",default:[1],min:0,max:1}
 ])}),
 "ffx-dof":Object.freeze({label:"FidelityFX DoF",license:"MIT",sourceUrl:"https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",revision:"c6efa6bf7f2027b3ec94f28578bb5965eabb9e55",inputPolicy:"source",requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true}),sceneInputs:Object.freeze(["depth","projectionMatrix"]),parameters:Object.freeze([
  {name:"FocusDistance",label:"Focus distance",description:"Distance from the camera in scene view-space units.",type:"float",default:[10],min:.0001,max:1000000},
  {name:"BlurRadius",label:"Blur radius",description:"Maximum circle-of-confusion radius in the current image's output pixels.",type:"float",default:[12],min:0,max:256},
  {name:"Quality",label:"Quality",description:"Number of sample rings in the original depth-of-field kernel.",type:"int",default:[3],min:1,max:8},
  {name:"MergeRings",label:"Merge sample rings",type:"bool",default:[1],min:0,max:1}
 ])}),
 "screen-space-reflections":Object.freeze({label:"Screen-space reflections",license:"MIT",sourceUrl:"https://github.com/godotengine/godot",revision:"4c311cbee68c0b66ff8ebb8b0defdd9979dd2a41",inputPolicy:"source",
  requirements:Object.freeze({depth:true,motion:false,projectionMatrix:true,sceneAovs:Object.freeze(["normal","roughness","resolvedRadiance","resolvedSpecular","metallic"])}),
  sceneInputs:Object.freeze(["depth","projectionMatrix","normal","roughness","resolvedRadiance","resolvedSpecular","metallic"]),parameters:Object.freeze([
   {name:"MaxSteps",label:"Ray steps",type:"int",default:[64],min:1,max:512},
   {name:"DepthTolerance",label:"Depth tolerance",description:"Intersection tolerance in scene view-space units.",type:"float",default:[.2],min:.0001,max:1000},
   {name:"FadeIn",label:"Fade in",type:"float",default:[.15],min:0,max:64},
   {name:"FadeOut",label:"Fade out",type:"float",default:[2],min:0,max:64},
   {name:"RoughnessQuality",label:"Roughness filtering",type:"int",default:[2],min:0,max:3,options:[{value:0,label:"Off"},{value:1,label:"Low"},{value:2,label:"Medium"},{value:3,label:"High"}]},
   {name:"Strength",label:"Strength",type:"float",default:[1],min:0,max:1}
  ])}),
 "estimated-depth-fog":Object.freeze({label:"Estimated depth fog",purpose:"Depth",license:"MIT",sourceUrl:"https://github.com/luluco250/FXShaders",revision:"76365e35c48e30170985ca371e67d8daf8eb9a98",inputPolicy:"source",modelOperation:"depth-anything-v2-small",parameters:Object.freeze([
  {name:"InputSize",label:"Depth input size",description:"Short-axis size for depth estimation, in multiples of 14. Larger values increase GPU work and memory.",type:"int",default:[252],min:14,max:4088,step:14},
  ...fogParameters.filter(parameter=>parameter.name!=="Distance")
 ])}),
 "ffx-lens":Object.freeze({label:"FidelityFX Lens",purpose:"Lighting and lens",license:"MIT",sourceUrl:"https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",revision:"c6efa6bf7f2027b3ec94f28578bb5965eabb9e55",inputPolicy:"source",preservesCoordinates:false,parameters:Object.freeze([
  {"name":"GrainScale","label":"Grain scale","type":"float","default":[1],"min":0.25,"max":64},
  {"name":"GrainAmount","label":"Grain amount","type":"float","default":[0.15],"min":0,"max":1},
  {"name":"ChromaticAberration","label":"Chromatic aberration","type":"float","default":[0.25],"min":0,"max":10},
  {"name":"Vignette","label":"Vignette","type":"float","default":[0.2],"min":0,"max":2},
  {"name":"GrainSeed","label":"Grain seed","type":"int","default":[0],"min":0,"max":16777215,"step":1},
  {"name":"AnimateGrain","label":"Animate grain","type":"bool","default":[1],"min":0,"max":1,"step":1}
 ])}),
 "ffx-blur":Object.freeze({label:"FidelityFX Blur",purpose:"Anti-aliasing and blur",license:"MIT",sourceUrl:"https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK",revision:"c6efa6bf7f2027b3ec94f28578bb5965eabb9e55",inputPolicy:"source",preservesCoordinates:true,parameters:Object.freeze([
  {"name":"KernelSize","label":"Kernel size","type":"int","default":[9],"min":3,"max":21,"step":2},
  {"name":"SigmaPreset","label":"Sigma","type":"int","default":[1],"min":0,"max":2,"step":1,"options":[{"value":0,"label":"1.6"},{"value":1,"label":"2.8"},{"value":2,"label":"4.0"}]}
 ])})
});
// The included collection lists each method once, from this table; its pointer
// file (<method>.mclfilter) names the method.
const collection=Object.freeze(Object.entries(methods).map(([id,spec])=>Object.freeze({id,label:spec.label,...(spec.purpose?{purpose:spec.purpose}:{}),file:id+".mclfilter",
 requires:[...(spec.sceneInputs||[])],nativeMethod:id,...(spec.modelOperation?{modelOperation:spec.modelOperation}:{}),license:spec.license,sourceUrl:spec.sourceUrl,...(spec.revision?{revision:spec.revision}:{})})));
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function input(file){if(!path.isAbsolute(file||"")||!/\.mclfilter$/i.test(file)||/[\x00-\x1f]/.test(file))throw Error("Choose a .mclfilter image-effect descriptor.");const canonical=fs.realpathSync(file),stat=fs.statSync(canonical);if(!stat.isFile()||stat.size>maximum)throw Error("The image-effect descriptor must be a file of at most 64 KiB.");return canonical;}
function parse(text){
 if(typeof text!=="string"||Buffer.byteLength(text)>maximum)throw Error("The image-effect descriptor exceeds 64 KiB.");let value;try{value=JSON.parse(text);}catch{throw Error("The image-effect descriptor is not valid JSON.");}
 if(!value||typeof value!=="object"||Array.isArray(value)||value.schema!==1||Object.keys(value).some(key=>!["schema","method","parameters"].includes(key))||typeof value.method!=="string"||!Object.hasOwn(methods,value.method))throw Error("Choose a supported compiled image algorithm.");
 const spec=methods[value.method],overrides=value.parameters===undefined?{}:value.parameters;if(!overrides||typeof overrides!=="object"||Array.isArray(overrides)||Object.keys(overrides).some(key=>!spec.parameters.some(p=>p.name===key)))throw Error("The image-effect parameters are invalid.");
 const parameters=spec.parameters.map(parameter=>{const supplied=Object.hasOwn(overrides,parameter.name)?overrides[parameter.name]:parameter.default[0],scalar=parameter.type==="bool"&&typeof supplied==="boolean"?Number(supplied):supplied;if(!Number.isFinite(scalar)||scalar<parameter.min||scalar>parameter.max||["int","bool"].includes(parameter.type)&&!Number.isSafeInteger(scalar))throw Error("The image-effect parameter is outside its supported range: "+parameter.label);return {...parameter,default:[scalar]};});
 const declaration={schema:1,method:value.method,parameters:Object.fromEntries(parameters.map(p=>[p.name,p.default[0]]))};
 if(["depth-fog","estimated-depth-fog"].includes(value.method)&&declaration.parameters.CurveStart>=declaration.parameters.CurveEnd)throw Error("Fog curve start must be below curve end.");
 if(value.method==="ffx-blur"&&!(declaration.parameters.KernelSize%2))throw Error("Blur kernel size must be an odd number of pixels.");
 if(value.method==="estimated-depth-fog"&&declaration.parameters.InputSize%14)throw Error("Depth input size must be a multiple of 14.");
 if(value.method==="histogram-exposure"&&(declaration.parameters.LowPercentile>=declaration.parameters.HighPercentile||declaration.parameters.MinEV>declaration.parameters.MaxEV))throw Error("Exposure needs ordered percentile and EV limits.");
 return {declaration,metadata:{schema:1,format,method:value.method,label:spec.label,parameters,requirements:spec.requirements||[],rgbCompatible:true,inputPolicy:spec.inputPolicy,output:{domain:"RGB",extent:"input"},...(spec.modelOperation?{modelOperation:spec.modelOperation}:{}),traits:{category:"effects",neural:false,rgbCompatible:true,inputPlanes:["rgb"],preservesCoordinates:spec.preservesCoordinates!==false,outputExtentEditable:false,inputPolicy:spec.inputPolicy,inputDomain:"RGB",outputDomain:"RGB",...(spec.modelOperation?{modelOperation:spec.modelOperation,gpuWorkScope:"external-queues"}:{}),...(spec.sceneInputs?{sceneInputs:[...spec.sceneInputs]}:{})}}};
}
function metadata(value){
 if(value?.format!==format||!Array.isArray(value.parameters)||value.parameters.some(p=>!p||typeof p.name!=="string"||!Array.isArray(p.default)||p.default.length!==1))throw Error("The native image-effect metadata is invalid.");
 const checked=parse(JSON.stringify({schema:value.schema,method:value.method,parameters:Object.fromEntries(value.parameters.map(p=>[p.name,p.default[0]]))})).metadata;
 if(new Set(value.parameters.map(p=>p.name)).size!==value.parameters.length||value.parameters.length!==checked.parameters.length||value.inputPolicy!==checked.inputPolicy||value.output?.domain!=="RGB"||value.output?.extent!=="input")throw Error("The native image-effect contract is invalid.");
 return require("../libplacebo").metadata({...value,...checked});
}
const provider={id:format,entryFile,label:"Native image effects",parseMetadata:metadata};
async function inspect(file,{signal}={}){signal?.throwIfAborted();return parse(await fs.promises.readFile(input(file),"utf8")).metadata;}
async function prepare(file,{userDataDir,signal}={}){
 file=input(file);signal?.throwIfAborted();const parsed=parse(await fs.promises.readFile(file,"utf8")),contents=Buffer.from(JSON.stringify(parsed.declaration)+"\n"),base=path.join(userDataDir,"graphics/shaders/native");Writable.assertOwnDirectory(userDataDir,base);
 const temporary=path.join(base,".prepare-"+crypto.randomUUID());await fs.promises.mkdir(temporary);
 try{signal?.throwIfAborted();const files=[{path:entryFile,size:contents.length,sha256:hash(contents)}];await fs.promises.writeFile(path.join(temporary,entryFile),contents,{mode:0o600});await fs.promises.writeFile(path.join(temporary,"metadata.json"),JSON.stringify({...parsed.metadata,files}),{mode:0o600});
  const verified=Bundle.verify(temporary,provider),destination=path.join(base,verified.revision);signal?.throwIfAborted();
  if(fs.existsSync(destination))Bundle.verify(destination,provider);else try{await fs.promises.rename(temporary,destination);}catch(error){if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error;Bundle.verify(destination,provider);}
  return {...verified,directory:destination,effect:path.join(destination,entryFile)};
 }finally{await fs.promises.rm(temporary,{recursive:true,force:true});}
}
function sourceAvailability(file,{features={}}={}){const method=parse(fs.readFileSync(input(file),"utf8")).declaration.method;return features.providers?.native?.methods?.includes(method)?null:"The selected graphics processor does not contain the "+methods[method].label+" image filter.";}
module.exports={format,input,parse,metadata,inspect,prepare,methods,collection,sourceAvailability,verifyBundle:directory=>Bundle.verify(directory,provider)};
