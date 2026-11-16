'use strict';
const {cpuLabel}=require('./cpu-labels.mjs');
const definitions=[['wine','runtimeId','Wine'],['d3d-renderer','translatorRenderer','Default Direct3D engine'],...Array.from({length:5},(_,i)=>[`d3d${i+8}`,`translatorD3D${i+8}`,`Direct3D ${i+8}`]),['vulkan-driver','translatorVulkan','Vulkan driver'],['video','translatorVideo','Video codecs'],['ddraw','cncDdraw','DirectDraw'],['cpu.x86_64','translatorCpuX64','x64 CPU translator'],['cpu.i386','translatorCpuX86','x86 CPU translator'],['nvapi','translatorNvapi','NVAPI'],['ngx','translatorNgx','NGX']];
const ROLES=Object.freeze(definitions.map(([id,settingsKey,label])=>Object.freeze({id,settingsKey,label})));
function normalizeChoice(value,{builds=[],sources=[]}={}){
 if(!value||value==='auto'||value==='automatic')return 'automatic';
 if(value==='inherit'||/^(?:source|build):/.test(value))return value;
 return builds.some(build=>build.id===value||build.aliases?.includes(value))?`build:${value}`:sources.some(source=>source.id===value||source.engine===value)?`source:${value}`:`build:${value}`;
}
function badges(build,host={}){return [...new Set((build?.files||build?.binaries||[]).flatMap(binary=>binary.format==='macho'?(binary.cpuSlices||binary.architectures||[]).map(arch=>cpuLabel(arch,{hostArchitecture:host.hardwareArch||host.hostArch})):
 binary.format==='pe'?[cpuLabel(typeof binary.machine==='number'?require('./binary-arch').peArchitecture(binary.machine):binary.machine,{windows:true})]:[]).filter(Boolean))];}
function execution(build,host={}){
 if(build?.execution)return build.execution.startsWith('fex')?'fex':build.execution;
 const images=(build?.files||build?.binaries||[]).filter(b=>b.format==='macho'&&(b.cpuSlices||b.architectures||[]).length);
 const hardware=host.hardwareArch||host.hostArch;if(!images.length||!hardware)return undefined;
 if(images.every(b=>(b.cpuSlices||b.architectures).includes(hardware)))return 'native';
 if(hardware==='arm64'&&images.every(b=>(b.cpuSlices||b.architectures).includes('x86_64')))return 'rosetta';
 return undefined;
}
function projectRuntimeRoles({plan,settings={},optionLists={},source={},sources=[],host={},wine}={}){
 const automatic=source.labels?.automatic||'Automatic', environment=source.labels?.environment;
 const rows=plan.roles||Object.entries(plan.components||{}).map(([id,row])=>({...row,id}));
 const roles=[];
 const processExecution=plan.processes?.[0]?.execution||(wine?execution(wine,host):undefined);
 const presentedExecution=build=>build?.execution?execution(build,host):(build?.files||build?.binaries||[]).some(file=>file.format==='pe')?processExecution:execution(build,host);
 for(const definition of ROLES){
  const row=rows.find(row=>row.id===definition.id);if(!row&&!(definition.id==='wine'&&wine))continue;
  const value=definition.id==='wine'?(wine?.source||source.id||''):settings[definition.settingsKey]??'';
  const used=row?.used||(definition.id==='wine'?wine:null), options=(row?.options||optionLists[definition.settingsKey+'Options']||[]).map(option=>{
   const item=option.description||[...(plan.inventory?.included||[]),...(plan.inventory?.choices||[])].find(item=>item.id===option.value);
   const kind=option.kind||(option.value==='inherit'?'environment':!option.value||['auto','automatic'].includes(option.value)?'automatic':String(option.value).startsWith('source:')?'source':'build');
   return {...option,value:kind==='automatic'?'automatic':kind==='environment'?'inherit':/^(?:source|build):/.test(option.value)?option.value:`build:${option.value}`,kind,label:kind==='automatic'?automatic:kind==='environment'?environment||option.label:option.label,badges:option.badges||badges(item,host),...(item?{execution:presentedExecution(item)}:{})};
  });
  const sourceOptions=new Map();
  for(const option of options){if(option.kind!=='build')continue;const item=option.description||[...(plan.inventory?.included||[]),...(plan.inventory?.choices||[])].find(item=>option.value===`build:${item.id}`);const sourceId=item?.sourceId||option.sourceId;if(!sourceId||sourceOptions.has(sourceId)||options.some(row=>row.value===`source:${sourceId}`))continue;
   const declaration=sources.find(row=>row.id===sourceId)||(source.source||source).embeds?.find(row=>row.id===sourceId);
   sourceOptions.set(sourceId,{value:`source:${sourceId}`,label:declaration?.label||item.engine||sourceId,kind:'source',sourceId,badges:badges(item,host),...(presentedExecution(item)?{execution:presentedExecution(item)}:{})});
  }
  const insertion=options.findIndex(option=>option.kind==='build');options.splice(insertion<0?options.length:insertion,0,...sourceOptions.values());
  if(!options.some(option=>option.kind==='automatic'))options.unshift({value:'automatic',label:automatic,kind:'automatic',badges:[]});
  const label=used?.label||used?.engine||automatic;
  roles.push({...definition,required:definition.id==='wine'||definition.id.startsWith('cpu.'),value,used:{label,version:String(used?.version||''),badges:badges(used,host),execution:presentedExecution(used)},fallback:row?.fallback?{reason:row.reason||row.fallback.reason,notice:'Saved selection (unavailable)'}:null,layers:row?.layers||[],options});
 }
 const downloads=(plan.downloads||[]).map(item=>typeof item==='string'?{label:item,bytes:0}:{label:item.label||item.build||item.id,bytes:item.bytes||0});
 return {summary:plan.summary||roles.filter(role=>role.used?.label).map(role=>`${role.label}: ${role.used.label}`).join(' · '),provisional:plan.provisional===true||Boolean(wine&&!processExecution),downloads,roleKeys:roles.map(role=>role.settingsKey),...Object.fromEntries(roles.map(role=>[role.settingsKey,role.options])),roles};
}
module.exports={ROLES,normalizeChoice,projectRuntimeRoles,badges};
