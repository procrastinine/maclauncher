'use strict';
const definitions=[['wine','runtimeId'],['d3d-renderer','translatorRenderer'],...Array.from({length:5},(_,i)=>['d3d'+(i+8),'translatorD3D'+(i+8)]),['vulkan-driver','translatorVulkan'],['video','translatorVideo'],['cpu.x86_64','translatorCpuX64'],['cpu.i386','translatorCpuX86']];
const ROLES=definitions.map(([id,settingsKey])=>({id,settingsKey}));
const AUTOMATIC=new Set(['','auto','automatic']);
function normalizeChoice(value,{sources=[]}={}){if(!value||AUTOMATIC.has(value))return 'automatic';if(value==='inherit'||/^(source|build):/.test(value))return value;return sources.some(source=>source.id===value)?'source:'+value:'build:'+value;}
// Every option names its source: a source file or one of the Wine's included
// components. A build's label is "<source label> · <version>".
function projectRuntimeRoles({plan={},settings={},optionLists={},source={},sources=[],wine}={}){
 const data=source.source||source,included=data.included||[];
 const automatic=source.labels?.automatic||data.label+"'s automatic choice",environment=source.labels?.environment;
 const inventory=[...(plan.inventory?.included||[]),...(plan.inventory?.choices||[])];
 const declared=id=>id&&(sources.find(item=>item.id===id)||included.find(item=>item.id===id));
 const itemFor=value=>inventory.find(item=>item.id===String(value).replace(/^build:/,''));
 const origin=item=>declared(item?.sourceId)||(item?.included?included.find(entry=>entry.engine===item.engine&&(!item.templateComponent||entry.parts?.some(part=>part.name===item.templateComponent))):null)||
  {id:item?.id,label:[data.label,item?.engine].filter(Boolean).join(' ')};
 const result={roleKeys:[]};
 for(const role of ROLES){
  const row=plan.roles?.find(row=>row.id===role.id)||plan.components?.[role.id];if(!row&&!(role.id==='wine'&&wine))continue;
  const output=[{value:'automatic',label:automatic,kind:'automatic',sourceId:data.id}];
  if(environment&&role.id!=='wine')output.push({value:'inherit',label:environment,kind:'environment',sourceId:data.id});
  const groups=new Map();
  for(const option of row?.options||optionLists[role.settingsKey+'Options']||[]){
   if(!option.value||AUTOMATIC.has(option.value)||option.value==='inherit')continue;
   const item=option.description||itemFor(option.value),from=item?origin(item):{id:String(option.value),label:option.label};
   if(!groups.has(from.id))groups.set(from.id,{label:from.label,builds:[]});
   groups.get(from.id).builds.push({value:normalizeChoice(option.value),kind:'build',sourceId:from.id,version:String(item?.version||option.label),
    exact:String(option.value).replace(/^build:/,'').split(':').slice(1).join(':'),...(option.prerelease||item?.prerelease?{prerelease:true}:{})});
  }
  for(const [sourceId,group]of groups){
   output.push({value:'source:'+sourceId,label:group.label,kind:'source',sourceId});
   if(group.builds.length<2)continue;
   const repeated=new Set(group.builds.map(build=>build.version).filter((version,index,all)=>all.indexOf(version)!==index));
   for(const {exact,...build}of group.builds)output.push({...build,label:group.label+' · '+(repeated.has(build.version)&&exact?exact:build.version)});
  }
  const saved=settings[role.settingsKey];
  if(saved&&!AUTOMATIC.has(saved)&&saved!=='inherit'&&!output.some(option=>option.value===normalizeChoice(saved))){
   const id=String(saved).replace(/^(?:source|build):/,''),item=itemFor(saved),from=declared(id)||(item&&origin(item));
   output.push({value:saved,label:from?(item?from.label+' · '+item.version:from.label):id,kind:String(saved).startsWith('source:')?'source':'build',sourceId:from?.id||id,disabled:true});
  }
  result.roleKeys.push(role.settingsKey);result[role.settingsKey]=output;
 }
 return result;
}
module.exports={ROLES,normalizeChoice,projectRuntimeRoles};
