const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Writable = require("../writable-input");
const Libplacebo = require("./libplacebo");
const Traits = require("./shader-traits");
const MpvHook=require("./mpv-hook-contract");
const SceneBindings=require("./shader-scene-bindings");
const {sceneInputNames,sceneInputRequirements}=require("../effects/operation-contracts.mjs");
const executeFile = require("node:util").promisify(require("node:child_process").execFile);
const {Worker, isMainThread, parentPort, workerData} = require("node:worker_threads");
const preparedGroups = new Map();

const PHASES = new Map([
  ["RGB", 0], ["LUMA", 1], ["CHROMA", 2], ["ALPHA", 3], ["CHROMA_SCALED", 4], ["ALPHA_SCALED", 4],
  ["NATIVE", 5], ["MAIN", 6], ["MAINPRESUB", 6], ["LINEAR", 7], ["SIGMOID", 8],
  ["PREKERNEL", 9], ["POSTKERNEL", 10], ["SCALED", 11], ["PREOUTPUT", 12], ["OUTPUT", 13]
]);
const BUILTINS = new Set([...PHASES.keys(), "HOOKED", "XYZ"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const explicitGeometry = node => Boolean(node.outputSize || node.presentationScale || node.resolutionAuto);

function describe(source) {
  const phases = [], contextPhases=[],hookPhases=[],symbols = new Set(),sourceReferences=new Set();
  let block=null,inHeader=false,invalid=false,geometry=false;
  const flush=()=>{if(!block?.hooks.length||MpvHook.constantCondition(block.when)===false)return;
    // OUTPUT dimensions are the already-known destination rectangle, not a
    // dependency on a future OUTPUT texture callback.
    const dependencies=[...block.binds,...MpvHook.expressionTextures(block.expressions.join(" ")).filter(name=>name!=="OUTPUT")];
    for(const name of block.hooks){if(!PHASES.has(name)){invalid=true;return;}const phase=PHASES.get(name);phases.push(phase);contextPhases.push(phase);hookPhases.push(phase);}
    for(const name of dependencies){
      const original=["NATIVE","NATIVE_CROPPED","PREKERNEL"].includes(name);
      if(original)sourceReferences.add(name);
      if(PHASES.has(name)){phases.push(PHASES.get(name));if(!original)contextPhases.push(PHASES.get(name));}
    }
    for(const name of block.hooks)if(/^(?:CHROMA|ALPHA)(?:_SCALED)?$/.test(name)&&(!block.save||block.save===name)){
      const identity=(text,axis)=>!text||["HOOKED",name].some(input=>text===input+"."+axis||text===input+"."+(axis==="w"?"width":"height"));
      if(!identity(block.width,"w")||!identity(block.height,"h"))geometry=true;
    }
  };
  for (const line of source.split(/\r?\n/)) {
    const directive = /^\s*\/\/!\s*(\w+)(?:\s+(.*?))?\s*$/.exec(line);
    if(!directive){if(line.trim()&&!line.trim().startsWith("//"))inHeader=false;continue;}
    if(!inHeader){flush();block={hooks:[],binds:[],expressions:[]};inHeader=true;}
    const [,kind,name=""]=directive;
    if(kind==="HOOK")block.hooks.push(name);
    else if(kind==="BIND")block.binds.push(name);
    else if(kind==="WHEN"){block.when=name;block.expressions.push(name);}
    else if(kind==="WIDTH"||kind==="HEIGHT"){block.expressions.push(name);block[kind.toLowerCase()]=name;}
    else if(kind==="SAVE")block.save=name;
    if(["SAVE","PARAM","TEXTURE","BUFFER"].includes(kind)&&/^[A-Za-z_]\w*$/.test(name)&&!BUILTINS.has(name))symbols.add(name);
  }
  flush();if(invalid||!phases.length)return null;
  try{for(const name of Object.keys(SceneBindings.parse(source))){if(BUILTINS.has(name))return null;symbols.add(name);}}catch{return null;}
  return {first: Math.min(...phases), last: Math.max(...phases),contextFirst:Math.min(...contextPhases),firstHook:Math.min(...hookPhases),symbols,geometry,sourceReferences:[...sourceReferences],readsOutput:/\bOUTPUT\.(?:w|h|width|height)\b/.test(source)};
}
// Grouped and individual rows share one geometry classifier.
const Contracts=require("../effects/contracts.mjs");
const geometryBoundary=traits=>Contracts.shaderResizes({traits});
function stageRange(stages){
  if(!Array.isArray(stages)||!stages.length||stages.some(stage=>!PHASES.has(stage)))return null;
  const phases=stages.map(stage=>PHASES.get(stage));return {first:Math.min(...phases),last:Math.max(...phases)};
}

// Original parsers own execution. This transform only isolates program-owned
// names; built-in planes and their source-grid meanings remain unchanged.
function namespace(source, symbols, prefix) {
  const names = [...symbols].sort((a, b) => b.length - a.length);
  const rename = token => {
    const name = names.find(name => token === name || token.startsWith(name + "_"));
    return name ? prefix + token : token;
  };
  return source.split(/\r?\n/).map(line => {
    if (/^\s*\/\/!\s*(DESC|WHEN|WIDTH|HEIGHT|OFFSET|COMPONENTS|COMPUTE|SIZE|FORMAT|FILTER|BORDER|TYPE|MINIMUM|MAXIMUM|STEP)\b/.test(line)) {
      // Expressions may refer to SAVE textures and parameters, while human
      // descriptions must stay unchanged.
      if (/^\s*\/\/!\s*DESC\b/.test(line)) return line;
    }
    return line.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, rename);
  }).join("\n");
}

function combine(members,{preserveSourceReferences=false}={}) {
  let previous = -1,geometry=false;
  const parameters = {}, programs = [];
  for (let index = 0; index < members.length; index++) {
    const member = members[index], profile = describe(member.source);
    if (!profile || (preserveSourceReferences?profile.contextFirst:profile.first) < previous || geometry) return null;
    let bindings;try{bindings={...SceneBindings.parse(member.source),...SceneBindings.validate(member.sceneBindings)};}catch{return null;}
    for(const name of Object.keys(bindings)){if(BUILTINS.has(name))return null;profile.symbols.add(name);}
    previous = profile.last;
    geometry=profile.geometry||!preserveSourceReferences&&geometryBoundary(Traits.inspect(member.source,"libplacebo"));
    const prefix = `mlg${index}_`;
    const declarations=Object.entries(bindings).map(([name,role])=>`//!SCENE_INPUT ${name} ${role}`).join("\n");
    programs.push(namespace((declarations?declarations+"\n":"")+member.source, profile.symbols, prefix));
    for (const [name, value] of Object.entries(member.parameters || {})) {
      if (!profile.symbols.has(name)) return null;
      parameters[prefix + name] = value;
    }
  }
  const source=programs.join("\n\n");if(Traits.inspect(source,"libplacebo").sourceError)return null;
  return {source, parameters};
}

function requestedTargets(nodes){
  let target={kind:"source",x:1,y:1},rounded=false;const targets=[];
  for(const node of nodes){
    if(node.outputSize){if(!node.outputSize.width||!node.outputSize.height)return null;target={kind:"absolute",x:node.outputSize.width,y:node.outputSize.height};rounded=false;}
    else if(node.presentationScale!==undefined||node.outputExtent==="presentation"){target={kind:"presentation",x:node.presentationScale??1,y:node.presentationScale??1};rounded=target.x!==1;}
    else if(node.outputScale){
      if(rounded)return null;
      target={...target,x:target.x*node.outputScale.x,y:target.y*node.outputScale.y};
      rounded=!Number.isInteger(node.outputScale.x)||!Number.isInteger(node.outputScale.y);
    }
    if(!Number.isFinite(target.x)||!Number.isFinite(target.y)||target.x<=0||target.y<=0||target.kind==="presentation"&&target.x!==target.y)return null;
    targets.push({...target});
  }
  return targets;
}
const cleared=Object.freeze({outputSize:undefined,outputScale:undefined,outputExtent:undefined,presentationScale:undefined});
function targetFields(target){
  if(target.kind==="absolute")return {...cleared,outputSize:{width:target.x,height:target.y}};
  if(target.kind==="presentation")return target.x===1?{...cleared,outputExtent:"presentation"}:{...cleared,presentationScale:target.x};
  return {...cleared,...(target.x!==1||target.y!==1?{outputScale:{x:target.x,y:target.y}}:{})};
}
async function referencePrograms(nodes,load){
  const result=[];
  for(let start=0;start<nodes.length;start++){
    const first=nodes[start];if(!first.enabled||first.kind!=="shader"||first.format!=="libplacebo"||explicitGeometry(first))continue;
    const members=[],compiled=[],profiles=[],candidates=[];let previous=-1,linked=false;
    for(let end=start;end<nodes.length;end++){
      const node=nodes[end];if(!node.enabled||node.kind!=="shader"||node.format!=="libplacebo"||node.planeGroupMembers||(node.inputPolicy||"source")!==(first.inputPolicy||"source"))break;
      const {source,traits,profile}=await load(end);
      // The native renderer owns its RGB saved stages. Keep plane-grid
      // mutations on the existing conservative plane-group path.
      if(!profile||traits.requiresDerivedPlanes||profile.geometry||profile.firstHook<PHASES.get("MAIN")||profile.contextFirst<previous)break;
      if(!members.length&&!geometryBoundary(traits)&&!traits.authoredResize)break;
      const manual=explicitGeometry(node)||Boolean(node.outputScale&&(node.outputScale.x!==traits.outputScale?.x||node.outputScale.y!==traits.outputScale?.y));
      if(manual&&!members.length)break;
      if(members.length&&profile.sourceReferences.length)linked=true;
      members.push({source,parameters:node.parameters,sceneBindings:node.sceneBindings});compiled.push(node);profiles.push(profile);previous=profile.last;
      if(linked){
        const targets=requestedTargets(compiled),final=targets?.at(-1);
        // A condition on OUTPUT must see the same target as in its original
        // row. A differently sized intermediate canvas remains a boundary.
        if(final&&profiles.every((value,i)=>!value.readsOutput||JSON.stringify(targets[i])===JSON.stringify(final))){
          candidates.push({count:members.length,end:end+1,target:final});
        }
      }
      if(manual)break;
    }
    for(const candidate of candidates.reverse()){
      const selected=combine(members.slice(0,candidate.count),{preserveSourceReferences:true});
      if(!selected)continue;
      result[start]={start,end:candidate.end,source:selected.source,traits:Traits.inspect(selected.source,"libplacebo"),ids:compiled.slice(0,candidate.count).map(value=>value.id),sourceReferenceGroup:true,output:targetFields(candidate.target)};break;
    }
  }
  return result.filter(Boolean);
}

async function programs(nodes) {
  const loaded=new Map(),load=index=>{if(!loaded.has(index))loaded.set(index,fs.promises.readFile(nodes[index].file,"utf8").then(source=>({source,traits:Traits.inspect(source,"libplacebo"),profile:describe(source)})));return loaded.get(index);};
  const result = [],references=new Map((await referencePrograms(nodes,load)).map(group=>[group.start,group]));
  for (let index = 0; index < nodes.length;) {
    const reference=references.get(index);if(reference){result.push(reference);index=reference.end;continue;}
    const first = nodes[index];
    if (!first.enabled || first.kind !== "shader" || first.format !== "libplacebo" || explicitGeometry(first)) {index++;continue;}
    const members = [], compiled = [];
    let previous = -1, last = index, output = {};
    while (last < nodes.length) {
      const node = nodes[last];
      if (!node.enabled || node.kind !== "shader" || node.format !== "libplacebo" || node.planeGroupMembers || explicitGeometry(node)) break;
      if((node.inputPolicy||"source")!==(first.inputPolicy||"source"))break;
      const {source,traits,profile}=await load(last);
      if(node.outputScale && (node.outputScale.x !== traits.outputScale?.x || node.outputScale.y !== traits.outputScale?.y)) break;
      if (!traits.requiresDerivedPlanes) break;
      if (!profile || profile.first < previous) break;
      previous = profile.last;
      members.push({source, parameters: node.parameters,sceneBindings:node.sceneBindings});compiled.push(node);last++;
      output=Contracts.shaderDefaultOutput({traits});
      if(profile.geometry||geometryBoundary(traits))break;
    }
    if (members.length < 2) {index++;continue;}
    const selected = combine(members);
    if (!selected) {index++;continue;}
    // Only the last member may resize. The group keeps that member's own
    // output target; combined declarations can hide its resize context.
    result.push({start: index, end: last, source: selected.source,
      traits: Traits.inspect(selected.source, "libplacebo"), ids: compiled.map(node => node.id), output: {...cleared, ...output}});
    index = last;
  }
  return result;
}

function compilePrograms(nodes, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData: {kind: "plane-programs", nodes}, execArgv: []});
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;finished = true;signal?.removeEventListener("abort", abort);
      if (error) reject(error);else resolve(value);
    };
    const abort = () => {void worker.terminate();finish(signal.reason || Object.assign(new Error("Shader preparation was cancelled."), {name: "AbortError"}));};
    signal?.addEventListener("abort", abort, {once: true});
    worker.once("message", message => message.error ? finish(new Error(message.error)) : finish(null, message.groups));
    worker.once("error", error => finish(error));
    worker.once("exit", code => {if (!finished) finish(new Error(`Shader preparation stopped (${code}).`));});
    if (signal?.aborted) abort();
  });
}

async function prepare(nodes, options) {
  if (options.features?.providers?.libplacebo?.planeGroups !== true ||
      nodes.filter(node => node.enabled && node.kind === "shader" && node.format === "libplacebo").length < 2) return nodes;
  const identity = await Promise.all(nodes.map(async ({parameters, ...node}) => {
    if (!node.enabled || node.kind !== "shader" || node.format !== "libplacebo") return {id: node.id, kind: node.kind, enabled: node.enabled};
    const stat = await fs.promises.lstat(node.file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("A prepared shader resource changed.");
    return {...node, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]};
  }));
  const key = hash(JSON.stringify([options.root, identity]));
  let groups = preparedGroups.get(key);
  if (!groups) {
    // Parsing and rewriting potentially large shader sources stays off the
    // launcher thread. Repeated scalar edits reuse immutable compiled bundles.
    groups = await compilePrograms(nodes, options.signal);
    for (const group of groups) {
    options.signal?.throwIfAborted();
    const directory = path.join(options.userDataDir, "graphics", "shaders", "plane-groups");
    Writable.assertOwnDirectory(options.userDataDir, directory);
    const temporary = path.join(directory, `.group-${crypto.randomUUID()}.hook`);
    try {
      Writable.atomicWrite(temporary, group.source, {root: options.userDataDir});
      const bundle = await Libplacebo.prepare(temporary, {...options, execute: options.execute || executeFile});
      group.bundle = {effect: bundle.effect, revision: bundle.revision};delete group.source;
    } finally {await fs.promises.rm(temporary, {force: true});}
    }
    preparedGroups.set(key, groups);
    if (preparedGroups.size > 16) preparedGroups.delete(preparedGroups.keys().next().value);
  }
  const result = [];let cursor = 0;
  for (const group of groups) {
    result.push(...nodes.slice(cursor, group.start));
    const compiled = nodes.slice(group.start, group.end), first = compiled[0], parameters = {}, traits = group.traits;
    for (let index = 0; index < compiled.length; index++)
      for (const [name, value] of Object.entries(compiled[index].parameters || {})) parameters[`mlg${index}_` + name] = value;
    result.push({...first, file: group.bundle.effect, key: hash(JSON.stringify(group.ids)), revision: group.bundle.revision,
      parameters, planeGroupMembers: group.ids, preservesCoordinates: compiled.every(node => node.preservesCoordinates),
      requirements:sceneInputRequirements([...compiled.flatMap(node=>sceneInputNames(node.requirements)),...(traits.sceneInputs||[])]),
      sceneBindings:traits.sceneBindings,
      ...group.output});
    cursor = group.end;
  }
  result.push(...nodes.slice(cursor));
  return result;
}

module.exports = {describe, stageRange, namespace, combine, prepare};
if (!isMainThread && workerData?.kind === "plane-programs") {
  programs(workerData.nodes).then(groups => parentPort.postMessage({groups}), error => parentPort.postMessage({error: error.message}))
    .finally(() => parentPort.close());
}
