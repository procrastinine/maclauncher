'use strict';
const fs=require('node:fs'),path=require('node:path');
function filesFor(install) {
 const root=install.translatorRoot||install.payloadRoot||install.root||install.installDir;
 const described=install.translator||install.installationMetadata?.translator;
 const files=described?.files?.filter(file=>['pe','macho','elf'].includes(file.format)).map(file=>path.isAbsolute(file.path)?file.path:path.join(root,file.relative||file.path));
 if(files?.length)return {root,files};
 const declared=install.manifest?.files||[];
 const binaries=declared.filter(file=>file.architectures?.length||/\.(?:dll|dylib|so)$/i.test(file.path||''));
 return {root,files:binaries.length?binaries.map(file=>path.join(root,file.path)):[install.executablePath].filter(Boolean)};
}
function listBuilds({manager,sources,context={},projectAvailableBuild}={}) {
 const {measureBuild}=require('../runtime-sources/installed-build');
 const installed=manager.core.listInstalled(context.userDataDir),result=[];
 for(const row of installed) {
  const selected=manager.resolveSelection(null,context.settings||{},context.userDataDir,{version:row.version,verification:'status'});
  if(!selected.ready||!selected.install)continue;
  const install=selected.install,pin=install.catalogEntry||row.catalogEntry||{};
  const source=sources.find(s=>s.manager?.sectionId===pin.catalogSourceId)||sources[0];
  const {root,files}=filesFor(install),id=source.id+':'+row.version;
  try {
   if(!files.length)throw new Error('The installed graphics build has no measured binary inventory.');
   const asset=pin.asset?.filename||pin.asset?.name||install.asset?.filename||'';
   const declaration=source.assets?.length===1?source.assets[0]:source.assets?.find(rule=>new RegExp(rule.match).test(asset));
   // Retained installations predate source declarations. Their verified bytes
   // keep their measured ABI rather than inheriting a newer asset's claims.
   const aggregate={};
   for(const file of files){const binary=require('../core/binary-arch').inspectBinary(file);for(const arch of binary.format==='macho'?binary.architectures:[binary.machine]){aggregate[binary.format]||=[];if(!aggregate[binary.format].includes(arch))aggregate[binary.format].push(arch);}}
   const declares=install.declares||install.installationMetadata?.declares||aggregate;
   const build=measureBuild({source,root,files:files.map(file=>path.relative(root,file)),declares,id,version:row.version,provenance:install.sourceIdentity||{}});
   result.push({...build,root,measured:true,engine:manager.translatorEngine||manager.translator?.engine,
    legacy:{managerId:manager.id,version:row.version,defaultVersion:context.settings?.runtimes?.[manager.id]?.defaultVersion}});
  }catch(error){result.push({id,source:source.id,kind:source.kind,version:row.version,installed:true,measured:false,binaries:[],available:false,unavailableReason:error.message});}
 }
 const pins=manager.core.listDiscoveredCatalog?.({userDataDir:context.userDataDir})||[];
 for(const pin of pins) {
  if(installed.some(row=>row.version===pin.version))continue;
  const source=sources.find(s=>s.manager?.sectionId===pin.catalogSourceId)||sources[0];
  const asset=Object.entries(source.upstream?.assets||{}).map(([intendedCPU,match])=>({intendedCPU,match})).find(rule=>new RegExp(rule.match,'i').test(pin.asset?.filename||pin.asset?.name||''));
  if(asset||source.upstream?.builds) {
   const project=projectAvailableBuild||require('../runtime-sources/available-build').projectAvailableBuild;
   result.push(project({source,asset,id:source.id+':'+pin.version,version:pin.version,bytes:pin.asset?.bytes,
    provenance:{managerId:manager.id,catalogEntry:pin}}));
  }
 }
 return result;
}
module.exports={listBuilds,filesFor};
