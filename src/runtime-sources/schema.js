'use strict';
const {getKind}=require('../core/component-kinds');
function object(value,name){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(name+' must be an object.');}
function validateSource(source){
 object(source,'Runtime source');
 for(const key of ['id','kind','label'])if(typeof source[key]!=='string'||!source[key])throw new TypeError('Runtime source requires '+key+'.');
 if(!getKind(source.kind))throw new TypeError('Unknown runtime kind.');
 if(source.order!==undefined&&!Number.isFinite(source.order))throw new TypeError('Source order must be numeric.');
 for(const key of Object.keys(source))if(!['id','kind','label','order','upstream','vulkan','vulkanFeatures','dxgi','included','graphicsPolicy'].includes(key))console.warn('Unknown runtime source key: '+key);
 if(source.upstream){object(source.upstream,'upstream');const upstream=source.upstream;if(upstream.github){if(!/^[\w.-]+\/[\w.-]+$/.test(upstream.github))throw new TypeError('Invalid upstream repository.');object(upstream.assets,'upstream assets');for(const pattern of Object.values(upstream.assets))new RegExp(pattern);}else if(!Object.hasOwn(upstream,'builds')&&!Object.hasOwn(upstream,'app'))throw new TypeError('Unknown upstream.');}
 if(source.included&&!Array.isArray(source.included))throw new TypeError('Included components must be an array.');
 // The DXGI provider a Direct3D 12 translator presents through: an engine, from a first version on.
 if(source.dxgi!==undefined&&(!source.dxgi||typeof source.dxgi.engine!=='string'||!source.dxgi.engine||source.dxgi.from!==undefined&&typeof source.dxgi.from!=='string'))throw new TypeError('A DXGI need names an engine and an optional first version.');
 // Vulkan device features that a translator's versions from `from` on require of the driver.
 if(source.vulkanFeatures!==undefined&&(!Array.isArray(source.vulkanFeatures)||!source.vulkanFeatures.every(rule=>rule&&typeof rule.from==='string'&&Array.isArray(rule.features)&&rule.features.every(feature=>typeof feature==='string'&&feature))))throw new TypeError('Vulkan features must be a list of { from, features } rules.');
 // A Wine whose loader picks its Direct3D libraries by one environment value: the variable, its default and
 // builtin values, and each other value with the included components it loads, in order, and the Wine Unix
 // module its first component renders through.
 if(source.graphicsPolicy!==undefined){const policy=source.graphicsPolicy,ids=new Set((source.included||[]).filter(embed=>embed.kind==='d3d-translator').map(embed=>embed.id));
  object(policy,'graphicsPolicy');
  for(const key of ['variable','default','builtins'])if(typeof policy[key]!=='string'||!policy[key])throw new TypeError('A graphics policy requires '+key+'.');
  if(!/^[A-Z_][A-Z0-9_]*$/.test(policy.variable))throw new TypeError('A graphics policy variable is an environment variable name.');
  if(!Array.isArray(policy.values)||!policy.values.every(entry=>entry&&typeof entry.value==='string'&&entry.value&&Array.isArray(entry.lanes)&&entry.lanes.length&&entry.lanes.every(lane=>ids.has(lane))&&
    (entry.architectures===undefined||Array.isArray(entry.architectures)&&entry.architectures.every(cpu=>['x64','x86','arm64'].includes(cpu)))&&
    (entry.graphicsModule===undefined||['winemetal','winevulkan'].includes(entry.graphicsModule))))
   throw new TypeError('Graphics policy values name included Direct3D components, optional x64, x86 or arm64 programs and an optional winemetal or winevulkan graphics module.');
  // A value whose loader also takes a separately installed build of a component engine from a folder named by another
  // variable: that variable, the engines, and the files the loader requires in the folder.
  for(const entry of policy.values)if(entry.directory!==undefined){const directory=entry.directory;object(directory,'A graphics policy directory');
   if(!/^[A-Z_][A-Z0-9_]*$/.test(directory.variable||'')||directory.variable===policy.variable||!Array.isArray(directory.engines)||!directory.engines.length||!directory.engines.every(engine=>typeof engine==='string'&&/^[a-z0-9-]+$/.test(engine))||
     !Array.isArray(directory.files)||!directory.files.length||!directory.files.every(file=>typeof file==='string'&&file&&!file.startsWith('/')&&!file.split('/').includes('..')))
    throw new TypeError('A graphics policy directory names its variable, component engines and required root-relative files.');}}
 return source;
}
function validateBuild(build){object(build,'Runtime build');for(const key of ['id','kind','version'])if(typeof build[key]!=='string')throw new TypeError('Build requires '+key+'.');if(!getKind(build.kind))throw new TypeError('Unknown runtime kind.');if(!Array.isArray(build.binaries))throw new TypeError('Build binaries must be an array.');return build;}
function validateDeclared(intended,binaries){
 if(!intended)return true;
 const cpus=typeof intended==='string'?[intended]:Object.values(intended).flat();
 const measured=[...new Set(binaries.flatMap(binary=>binary.architectures||[binary.machine]).filter(Boolean))];
 const normalize=cpu=>({x64:'x86_64',aarch64:'arm64',x86:'i386'})[cpu]||cpu;
 if(measured.length&&cpus.length&&!cpus.some(cpu=>measured.map(normalize).includes(normalize(cpu))))throw new Error('Runtime architecture mismatch: intended '+cpus.join(', ')+'; measured '+measured.join(', '));return true;
}
module.exports={validateSource,validateBuild,validateDeclared};
