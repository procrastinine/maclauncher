'use strict';
const {getKind}=require('../core/component-kinds');
function object(value,name){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(name+' must be an object.');}
function validateSource(source){
 object(source,'Runtime source');
 for(const key of ['id','kind','label'])if(typeof source[key]!=='string'||!source[key])throw new TypeError('Runtime source requires '+key+'.');
 if(!getKind(source.kind))throw new TypeError('Unknown runtime kind.');
 if(source.order!==undefined&&!Number.isFinite(source.order))throw new TypeError('Source order must be numeric.');
 for(const key of Object.keys(source))if(!['id','kind','label','order','upstream','vulkan','vulkanFeatures','dxgi','included'].includes(key))console.warn('Unknown runtime source key: '+key);
 if(source.upstream){object(source.upstream,'upstream');const upstream=source.upstream;if(upstream.github){if(!/^[\w.-]+\/[\w.-]+$/.test(upstream.github))throw new TypeError('Invalid upstream repository.');object(upstream.assets,'upstream assets');for(const pattern of Object.values(upstream.assets))new RegExp(pattern);}else if(!Object.hasOwn(upstream,'builds')&&!Object.hasOwn(upstream,'app'))throw new TypeError('Unknown upstream.');}
 if(source.included&&!Array.isArray(source.included))throw new TypeError('Included components must be an array.');
 // The DXGI provider a Direct3D 12 translator presents through: an engine, from a first version on.
 if(source.dxgi!==undefined&&(!source.dxgi||typeof source.dxgi.engine!=='string'||!source.dxgi.engine||source.dxgi.from!==undefined&&typeof source.dxgi.from!=='string'))throw new TypeError('A DXGI need names an engine and an optional first version.');
 // Vulkan device features that a translator's versions from `from` on require of the driver.
 if(source.vulkanFeatures!==undefined&&(!Array.isArray(source.vulkanFeatures)||!source.vulkanFeatures.every(rule=>rule&&typeof rule.from==='string'&&Array.isArray(rule.features)&&rule.features.every(feature=>typeof feature==='string'&&feature))))throw new TypeError('Vulkan features must be a list of { from, features } rules.');
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
