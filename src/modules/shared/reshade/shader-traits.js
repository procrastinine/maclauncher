// Descriptive metadata only. Original provider parsers remain authoritative for
// executable shader syntax, resources, parameters and supported input stages.
const fs = require("node:fs"), path = require("node:path");
const VERSION = 19, MAX_FILE_BYTES = 8 * 1024 * 1024, fileCache = new Map();
const MpvHook=require("./mpv-hook-contract");
const Resize=require("./shader-resize-contract");
let metadataSnapshot;
// A synchronous catalog read shares dependency stats between presets. The
// scope ends before returning, so the next read observes source/include edits.
function withMetadataSnapshot(read) {
  if (metadataSnapshot) return read();
  metadataSnapshot = new Map();
  try { return read(); } finally { metadataSnapshot = undefined; }
}
function metadataStat(file) {
  if (!metadataSnapshot) return fs.statSync(file);
  if (!metadataSnapshot.has(file)) {
    try { metadataSnapshot.set(file, {stat: fs.statSync(file)}); }
    catch (error) { metadataSnapshot.set(file, {error}); }
  }
  const result = metadataSnapshot.get(file);
  if (result.error) throw result.error;
  return result.stat;
}
const RGB = new Set(["RGB", "MAIN", "MAINPRESUB", "NATIVE", "LINEAR", "SIGMOID", "PREKERNEL", "POSTKERNEL", "SCALED", "PREOUTPUT", "OUTPUT"]);
const FRAME = new Set([...RGB, "LUMA"]);
function expression(text, sizes, hooked, axis) {
  const stack = [];
  for (const token of text.trim().split(/\s+/)) {
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) stack.push({ value: Number(token), degree: 0 });
    else if (/^[A-Za-z_][A-Za-z0-9_]*\.[wh]$/.test(token)) {
      const [name, dimension] = token.split(".");
      // Cross-axis and display-dependent expressions need actual runtime sizes.
      if (dimension !== axis || name === "OUTPUT") return null;
      const value = sizes.get(name === "HOOKED" ? hooked : name);
      if (!value) return null;
      stack.push({ value: value[axis === "w" ? "x" : "y"], degree: 1 });
    } else if (["*", "/"].includes(token) && stack.length >= 2) {
      const b = stack.pop(), a = stack.pop(); stack.push(token === "*"
        ? { value: a.value * b.value, degree: a.degree + b.degree }
        : { value: a.value / b.value, degree: a.degree - b.degree });
    } else return null;
    if (stack.length > 64 || stack.some(({ value, degree }) => !Number.isFinite(value) || !Number.isFinite(degree))) return null;
  }
  // A relative output extent must remain linear in one input dimension.
  // Numeric-only WIDTH/HEIGHT expressions instead describe absolute pixels.
  return stack.length === 1 && stack[0].degree === 1 && stack[0].value >= 1 / 16 && stack[0].value <= 16 ? stack[0].value : null;
}
function inputPolicy(text,format){
  // The current ReShade compiler declares an eight-bit display backbuffer.
  // An explicitly HDR-aware source may opt into the source image contract.
  return require("./shader-input-policy").declared(text)||(format==="fx"?"srgb-sdr":undefined);
}
function inspect(text,format){
  const traits=inspectSource(text,format);if(traits.sourceError||typeof text!=="string")return traits;
  try{const result=Resize.apply(text,require("./shader-scene-bindings").apply(text,{...traits,...(traits.inputPolicy==="linear-source"?{sharedOnly:true}:{})}));
    // FX passes use a source-sized effect canvas; its requested target fit is
    // after those passes. ISF's final canvas uses the supplied default target.
    // Scratch texture dimensions do not redefine either output contract.
    if(format==="fx"||format==="isf")return result.outputResize&&result.outputResize!=="none"?{...result,compositeTarget:format==="fx"}:{...result,preservesSize:true};
    return result;
  }catch(error){return {...traits,sourceError:error.message};}
}
function inspectSource(text, format) {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return { category: "effects", neural: false };
  let policy;try{policy=inputPolicy(text,format);}catch(error){return {category:"effects",neural:false,sourceError:error.message};}
  if(format==="native")try{const metadata=require("./native-filter").parse(text).metadata;return {...metadata.traits,...(metadata.output?.extent==="input"?{preservesSize:true,geometryKnown:true}:{})};}catch(error){return {category:"effects",neural:false,sourceError:error.message};}
  if(format==="libplacebo"&&text.trimStart().startsWith("{"))try{return {...require("./libplacebo-filter").parse(text).metadata.traits,preservesSize:true};}catch(error){return {category:"effects",neural:false,sourceError:error.message};}
  if(format==="magpie")try{return require("./magpie/parse").parse(text).traits;}catch(error){return {category:"effects",neural:false,sourceError:error.message};}
  if(format==="isf")try{return require("./isf").parse(text).metadata.traits;}catch(error){return {category:"effects",neural:false,sourceError:error.message};}
  if(format==="slang"||format==="slangp")return {...require("./retroarch-traits").inspect(text,format),...(policy?{inputPolicy:policy}:{})};
  const descriptions = [], stages = new Set(), sizes = new Map([...FRAME].map(name => [name, {x: 1, y: 1}]));
  let block = null, outputScale = null, unknownGeometry = false, requiresVideoPlanes = false,declaredHooks=false;
  let conditionalGeometry = false, displayDependentGeometry = false, sizingDeclared = false, authoredResize = false, requestedResize = false;
  const inputPlanes = new Set();
  const outputHooks = new Set(),kernelContexts=[],publishedDirections=[],requestedDirections=[],unknownSizes=new Set(),geometryRules=[];
  // Saved textures sized from the output carry their proven resize directions
  // to a published hook sized from them (for example a two-pass EASU/RCAS).
  const outputSaves = new Map(),absoluteSizes=[];
  const flush = () => {
    if (!block?.hooks.length) return;
    const condition=MpvHook.constantCondition(block.when);
    if(condition===false)return;
    const frameOutput = block.hooks.some(hook => FRAME.has(hook) && (!block.save || block.save === hook));
    if(frameOutput)geometryRules.push({stages:block.hooks.filter(hook=>FRAME.has(hook)),width:block.width||"HOOKED.w",height:block.height||"HOOKED.h",when:block.when||"1"});
    const conditionSizes=new Map(sizes);if(block.hooks.length===1)conditionSizes.set("HOOKED",sizes.get(block.hooks[0]));
    const postKernel=block.hooks.every(hook=>["POSTKERNEL","SCALED","PREOUTPUT","OUTPUT"].includes(hook));
    const outputNames=new Set(["OUTPUT",...(postKernel?["POSTKERNEL","SCALED","PREOUTPUT","HOOKED"]:[])]);
    const conditionDirections=MpvHook.resizeCondition(block.when,{sizes:conditionSizes,outputNames});
    if(frameOutput)kernelContexts.push(!block.width&&!block.height&&block.hooks.every(hook=>["POSTKERNEL","SCALED","PREOUTPUT","OUTPUT"].includes(hook))?conditionDirections:null);
    const sizeText=[block.width,block.height].filter(Boolean).join(" "),saved=MpvHook.expressionTextures(sizeText).filter(name=>outputSaves.has(name));
    const outputSized=/\bOUTPUT\.[wh]\b/.test(sizeText)||saved.length>0;
    if(!frameOutput&&block.save&&(outputSized||/\bOUTPUT\.[wh]\b/.test(block.when||"")))
      outputSaves.set(block.save,conditionDirections||(saved.length?outputSaves.get(saved[0]):null));
    // Feature textures and reconstructed chroma planes do not resize the frame.
    // Only a published full-frame hook contributes a resolution contract.
    if (frameOutput && (block.width || block.height)) {
      sizingDeclared = true;
      if (outputSized){requestedResize=true;const inherited=saved.map(name=>outputSaves.get(name));
        requestedDirections.push(conditionDirections||(inherited.length&&inherited.every(value=>value?.join()===inherited[0]?.join())?inherited[0]:null));}
      if (block.when&&condition===null) { conditionalGeometry = true;unknownGeometry = true; }
      if (outputSized||/\bOUTPUT\.[wh]\b/.test(block.when||"")) {
        displayDependentGeometry = true;unknownGeometry = true;
      }
    }
    const dependencies=[...block.binds,...MpvHook.expressionTextures([block.width,block.height,block.when].filter(Boolean).join(" "))];
    if (dependencies.some(name => /^(?:LUMA|CHROMA|CHROMA_SCALED|ALPHA|ALPHA_SCALED)$/.test(name)) ||
        !block.hooks.some(name => RGB.has(name)) && block.hooks.some(name => /^(?:LUMA|CHROMA|CHROMA_SCALED|ALPHA|ALPHA_SCALED)$/.test(name))) requiresVideoPlanes = true;
    for (const hooked of block.hooks) {
      stages.add(hooked);
      const plane=name=>/^(?:CHROMA|ALPHA)(?:_SCALED)?$/.test(name)?name.split("_")[0].toLowerCase():name==="LUMA"?"luma":name==="XYZ"?"xyz":RGB.has(name)?"rgb":null;
      for(const name of [hooked,...dependencies]){const value=plane(name==="HOOKED"?hooked:name);if(value)inputPlanes.add(value);}
      const initial = sizes.get(hooked);
      const x = block.width ? expression(block.width, sizes, hooked, "w") : initial?.x;
      const y = block.height ? expression(block.height, sizes, hooked, "h") : initial?.y;
      const target = block.save || hooked;
      const publishes = !block.save || block.save === hooked;
      if (publishes && FRAME.has(hooked) && (block.width || block.height)) {
        if(x!==1||y!==1)authoredResize=true;
        const rx=initial&&x!=null?x/initial.x:null,ry=initial&&y!=null?y/initial.y:null;
        publishedDirections.push(rx==null||ry==null?null:rx>=1&&ry>=1&&(rx>1||ry>1)?"upscale":rx<=1&&ry<=1&&(rx<1||ry<1)?"downsample":rx===1&&ry===1?"preserve":null);
        outputHooks.add(hooked);
        // Whole-number WIDTH and HEIGHT publish a fixed pixel size.
        const pixels=[block.width,block.height].map(value=>/^\s*\d+\s*$/.test(value||"")?Number(value):0);
        absoluteSizes.push(pixels.every(value=>value>=1&&value<=16384)?{width:pixels[0],height:pixels[1]}:null);
        if (outputHooks.size > 1) unknownGeometry = true;
      }
      if (x == null || y == null) {
        sizes.delete(target);
        unknownSizes.add(target);
        if (publishes && FRAME.has(hooked)) { unknownGeometry = true;outputScale = null; }
        continue;
      }
      // A conditional SAVE has a known size whenever it exists. Consumers
      // cannot execute without their bound texture. Preserve that fact unless
      // another possible writer gives the same resource a different extent.
      if(block.when&&condition===null&&!publishes){
        const previous=sizes.get(target);
        if(unknownSizes.has(target)||previous&&(previous.x!==x||previous.y!==y)){sizes.delete(target);unknownSizes.add(target);continue;}
      }else unknownSizes.delete(target);
      sizes.set(target, {x, y});
      if (publishes && FRAME.has(hooked) && (block.width || block.height)) outputScale = {x, y};
    }
  };
  if (format === "libplacebo") {
    let inHeader = false;
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*\/\/!\s*(\w+)(?:\s+(.*?))?\s*$/.exec(line);
      if (!match) { if (line.trim() && !line.trim().startsWith("//")) inHeader = false; continue; }
      if (!inHeader) { flush(); block = {hooks: [], binds: []}; inHeader = true; }
      const [, key, raw = ""] = match, value = raw.trim();
      if (key === "HOOK") {block.hooks.push(value);declaredHooks=true;}
      if (key === "BIND") block.binds.push(value);
      if (key === "SAVE") block.save = value;
      if (key === "WIDTH") block.width = value;
      if (key === "HEIGHT") block.height = value;
      if (key === "WHEN") block.when = value;
      if (key === "DESC" && value && descriptions.length < 32) descriptions.push(value.slice(0, 512));
    }
    flush();
  }
  const description = descriptions[0] || "", declarations = descriptions.join(" ");
  const resizeContext=kernelContexts.length&&kernelContexts.every(value=>value?.length===1&&value[0]===kernelContexts[0]?.[0])?kernelContexts[0][0]:null;
  const possibleResizeDirections=conditionalGeometry&&publishedDirections.length&&publishedDirections.every(value=>value!==null)?[...new Set(publishedDirections.filter(value=>value!=="preserve"))]:null;
  const outputScaleRange=possibleResizeDirections?.length===1&&outputScale?
    {min:{x:Math.min(1,outputScale.x),y:Math.min(1,outputScale.y)},max:{x:Math.max(1,outputScale.x),y:Math.max(1,outputScale.y)}}:null;
  const outputSize=absoluteSizes.length===1&&!conditionalGeometry?absoluteSizes[0]:null;
  const targetResizeDirections=requestedDirections.length&&requestedDirections.every(value=>value?.length===1&&value[0]===requestedDirections[0]?.[0])?requestedDirections[0]:null;
  const neural = /(?:^|[^a-z0-9])(?:CNN|FSRCNNX?|ArtCNN|NNEDI3?|neural|convolution(?:al)?)(?=$|[^a-z0-9])|Anime4K.*CNN/i.test(declarations);
  const scale = !unknownGeometry && outputScale && (outputScale.x !== 1 || outputScale.y !== 1) ? outputScale : null;
  const category = outputScale && (outputScale.x > 1 || outputScale.y > 1) ? "upscaling" : outputScale && (outputScale.x < 1 || outputScale.y < 1) ? "downscaling" :
    sizingDeclared && unknownGeometry ? "scaling" :
    [...stages].some(stage => /^CHROMA(?:_SCALED)?$/.test(stage)) && ![...stages].some(stage => FRAME.has(stage)) ? "chroma" :
    /\b(?:denoise|deband|restore|restoration|deblur)\b/i.test(declarations) ? "restoration" :
    /\b(?:CRT|scanlines?|phosphor)\b/i.test(declarations) ? "crt" :
    /\b(?:color|colour|tone|gamma|vibrance)\b/i.test(declarations) ? "color" : "effects";
  return { category, neural, ...(policy?{inputPolicy:policy}:{}), ...(description ? {description} : {}),
    ...(scale ? {outputScale: scale} : {}), ...(outputSize ? {outputSize} : {}), ...(conditionalGeometry ? {conditionalGeometry: true} : {}),
    ...(resizeContext?{resizeContext,recommendedPlacement:"during-"+resizeContext}:{}),
    ...(possibleResizeDirections?{possibleResizeDirections}:{}),...(outputScaleRange?{outputScaleRange}:{}),
    ...(targetResizeDirections?{targetResizeDirections}:{}),
    ...(format==="libplacebo"?{geometryRules}:{}),
    ...(displayDependentGeometry ? {displayDependentGeometry: true} : {}), ...(sizingDeclared && unknownGeometry ? {unresolvedGeometry: true} : {}),
    ...(authoredResize?{authoredResize:true}:{}),...(requestedResize?{requestedResize:true}:{}),...(format==="libplacebo"&&!resizeContext&&!requestedResize&&(!authoredResize||sizingDeclared&&outputScale?.x===1&&outputScale?.y===1&&!unknownGeometry)?{preservesSize:true,...(!sizingDeclared?{defaultPreservesSize:true}:{})}:{}),
    ...(format === "libplacebo" ? {stages: [...stages], requiresVideoPlanes: false,
      requiresDerivedPlanes: requiresVideoPlanes, derivedPlaneCompatible: requiresVideoPlanes,
      inputPlanes: [...inputPlanes], outputExtentEditable: !sizingDeclared||requestedResize, ...(!sizingDeclared||requestedResize?{requestedOutputExtent:true}:{}),
      rgbCompatible: requiresVideoPlanes || [...stages].some(stage => RGB.has(stage)) || declaredHooks&&!stages.size, geometryKnown: !unknownGeometry} :
      {rgbCompatible:true,inputPlanes:["rgb"],geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true}) };
}
const groups = { upscaling: "Imported upscalers", downscaling: "Imported downscalers", chroma: "Chroma reconstruction", restoration: "Imported restoration", crt: "Imported CRT", color: "Imported color", effects: "Imported filters" };
// Resize groups come from the shared geometry classifier; other groups are
// descriptive search tags.
function group(traits) {
  const Contracts=require("../effects/contracts.mjs"),row={template:{kind:"shader"},traits:traits||{},outputContract:outputContract(traits||{})};
  const listed=["upscale","downsample"].filter(type=>Contracts.implementationsFor(type,[row]).length);
  return listed.length===1?groups[listed[0]==="upscale"?"upscaling":"downscaling"]:listed.length?"Imported resizers":
    !["upscaling","downscaling","scaling"].includes(traits?.category)&&groups[traits?.category]||groups.effects;
}
function analyzeFile(file, format = "libplacebo") {
  const canonical = fs.realpathSync(file), stat = metadataStat(canonical);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Shader metadata requires a source file up to 8 MiB.");
  const stamp = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
  const identity = `${VERSION}:${format}:${stamp(stat)}`, cached = fileCache.get(canonical);
  if (cached?.identity === identity && current(cached.analysis,stat)) return cached.analysis;
  const stored = persisted(canonical, identity, stat);
  if (stored) { fileCache.set(canonical, { identity, analysis: stored });return stored; }
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    if (stamp(fs.fstatSync(fd)) !== stamp(stat)) throw new Error("The shader source changed while reading metadata.");
    bytes = Buffer.alloc(stat.size);let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error("The shader source changed while reading metadata.");offset += read;
    }
    if (stamp(fs.fstatSync(fd)) !== stamp(stat)) throw new Error("The shader source changed while reading metadata.");
  } finally { fs.closeSync(fd); }
  const source=bytes.toString("utf8");
  let traits,dependencies;
  if(format==="libplacebo"&&/\.cube$/i.test(canonical)){require("./cube-lut").parse(source);traits={...require("./cube-lut").traits,geometryKnown:true,preservesSize:true,requestedOutputExtent:true,outputExtentEditable:true};}
  else if(format==="slang"||format==="slangp"){const result=require("./retroarch-traits").analyze(canonical,source,format),declarations=result.declarations||source;traits=Resize.apply(declarations,require("./shader-scene-bindings").apply(declarations,result.traits));dependencies=result.dependencies;const policy=inputPolicy(declarations,format);if(policy)traits={...traits,inputPolicy:policy};}
  else if(format==="magpie"){
    try{const expanded=require("./magpie/source").read(canonical);traits=inspect(expanded.text,format);dependencies=expanded.dependencies;}
    catch(error){dependencies=error.dependencies;traits={category:"effects",neural:false,rgbCompatible:true,inputPlanes:["rgb"],geometryKnown:false,unresolvedGeometry:true,outputExtentEditable:true,sourceInfo:error.message};}
  }
  else {traits=inspect(source,format);if(format==="fx")dependencies=require("./fx-source-inputs").dependencies(canonical,source);}
  try{traits=Resize.apply(source,traits);}catch(error){traits={...traits,sourceError:error.message};}
  if(traits.inputPolicy==="linear-source")traits={...traits,sharedOnly:true};
  const analysis = { parserVersion: VERSION, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs, sourceCtimeMs: stat.ctimeMs,
    traits, ...(dependencies?.length?{dependencies}:{}) };
  analysis.sourceRevision=sourceRevision(analysis,stat);
  if (parserIdentity()) analysis.parser = parserIdentity();
  if (fileCache.size >= 4096) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(canonical, { identity, analysis });persist(canonical, identity, analysis);return analysis;
}
// The parser is this module and every module it loads by relative path. Its
// source digest keys persisted analyses, so an application update that changes
// any of them analyzes again even when VERSION is unchanged.
function parserIdentity() {
  return require("../source-identity").identity(__filename);
}
// Analyses persist in the application's own data directory (configure), never
// beside shaders or in game folders. An entry is reused only for the same
// parser identity and file identity, and only while its dependency stamps
// still match. Main configures it; other processes keep the in-memory cache.
const MAX_STORED = 8192, MAX_STORE_BYTES = 64 * 1024 * 1024;
let store = null;
function configure({ userDataDir } = {}) {
  if (store?.timer) clearTimeout(store.timer);
  store = userDataDir ? { userDataDir, file: path.join(userDataDir, "graphics", "shader-traits-cache.json"), entries: null, timer: null } : null;
}
function storedEntries() {
  if (!store || store.entries) return store?.entries;
  store.entries = new Map();
  const identity = parserIdentity();
  if (!identity) return store.entries;
  try {
    const stat = fs.lstatSync(store.file);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return store.entries;
    const value = JSON.parse(fs.readFileSync(store.file, "utf8"));
    if (value?.schema === 1 && value.parser === identity && value.entries && typeof value.entries === "object")
      for (const [file, row] of Object.entries(value.entries)) if (typeof row?.identity === "string" && row.analysis?.parser === identity) store.entries.set(file, row);
  } catch {}
  return store.entries;
}
function persisted(file, identity, stat) {
  const row = storedEntries()?.get(file);
  return row?.identity === identity && current(row.analysis, stat) ? row.analysis : null;
}
function persist(file, identity, analysis) {
  const entries = storedEntries();
  if (!entries || !analysis.parser) return;
  entries.delete(file);entries.set(file, { identity, analysis });
  if (entries.size > MAX_STORED) entries.delete(entries.keys().next().value);
  store.timer ||= setTimeout(flush, 1000);store.timer.unref?.();
}
function flush() {
  if (!store?.entries) return;
  clearTimeout(store.timer);store.timer = null;
  try {
    require("../writable-input").atomicWrite(store.file, JSON.stringify({ schema: 1, parser: parserIdentity(), entries: Object.fromEntries(store.entries) }),
      { root: store.userDataDir });
  } catch {}
}
function current(analysis,stat){
  return analysis?.parserVersion===VERSION&&(analysis.parser??null)===parserIdentity()&&analysis.sourceSize===stat.size&&analysis.sourceMtimeMs===stat.mtimeMs&&analysis.sourceCtimeMs===stat.ctimeMs&&
    (!analysis.dependencies||Array.isArray(analysis.dependencies)&&analysis.dependencies.every(row=>{try{const value=metadataStat(row.file);return [value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(":")===row.stamp;}catch{return row.stamp===null;}}));
}
function outputContract(traits={}){
  const sizing=traits.requestedOutputExtent?"stage":traits.conditionalGeometry||traits.displayDependentGeometry||traits.unresolvedGeometry?"shader":traits.outputScale?"intrinsic":"preserve";
  // A preserved extent has no requested output unless one is declared.
  return {domain:"image",sizing,...(traits.outputScale?{scale:traits.outputScale}:{}),extentEditable:sizing==="preserve"?traits.outputExtentEditable===true:traits.outputExtentEditable!==false,resizeDirections:Resize.forTraits(traits),...(traits.outputScaleRange?{scaleRange:traits.outputScaleRange}:{}),...(traits.preservesSize===true?{preservesSize:true}:{}),...(traits.compositeTarget?{compositeTarget:true}:{}),...(traits.geometryRules?.length?{geometryRules:traits.geometryRules}:{}),...(traits.resizeContext?{resizeContext:traits.resizeContext}: {})};
}
function sourceRevision(analysis,stat){return require("node:crypto").createHash("sha256").update(JSON.stringify([VERSION,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,analysis?.dependencies||[]])).digest("hex");}
module.exports = { VERSION, inspect, inputPolicy, analyzeFile, current, outputContract, sourceRevision, withMetadataSnapshot, group, configure, flush, parserIdentity };
