'use strict';
const definitions=[['wine','runtimeId'],['d3d-renderer','translatorRenderer'],...Array.from({length:5},(_,i)=>['d3d'+(i+8),'translatorD3D'+(i+8)]),['vulkan-driver','translatorVulkan'],['video','translatorVideo'],['cpu.x86_64','translatorCpuX64'],['cpu.i386','translatorCpuX86']];
const ROLES=definitions.map(([id,settingsKey])=>({id,settingsKey}));
function normalizeChoice(value,{builds=[],sources=[]}={}){if(!value||value==='auto'||value==='automatic')return 'automatic';if(value==='inherit'||/^(source|build):/.test(value))return value;return sources.some(source=>source.id===value)?'source:'+value:'build:'+value;}
function projectRuntimeRoles({plan={},settings={},optionLists={},source={},sources=[],wine}={}){
 const result={roleKeys:[]},inventory=[...(plan.inventory?.included||[]),...(plan.inventory?.choices||[]),...(plan.roles||[]).map(row=>row.used).filter(Boolean)];
 const data=source.source||source,automatic=source.labels?.automatic||data.label+"'s automatic choice",environment=source.labels?.environment;
 for(const role of ROLES){const row=plan.roles?.find(row=>row.id===role.id)||plan.components?.[role.id];if(!row&&!(role.id==='wine'&&wine))continue;
  let options=row?.options||optionLists[role.settingsKey+'Options']||[];const output=[{value:'automatic',label:automatic,kind:'automatic',sourceId:data.id||''}];if(environment)output.push({value:'inherit',label:environment,kind:'environment',sourceId:data.id||''});
  const groups=new Map();for(const option of options){if(!option.value||['auto','automatic','inherit'].includes(option.value))continue;const item=option.description||inventory.find(item=>item.id===String(option.value).replace(/^build:/,''));const sourceId=option.sourceId||item?.sourceId||item?.source?.id||typeof item?.source==='string'&&item.source||data.id;const declaration=sources.find(source=>source.id===sourceId)||data.included?.find(source=>source.id===sourceId)||{};const label=declaration.label||item?.engine||option.label;const entry={value:option.value,label:option.label,kind:'build',sourceId,...(item?.version?{version:String(item.version)}:{}),...(option.prerelease||item?.prerelease?{prerelease:true}:{})};if(option.disabled===true&&option.measuredMismatch===true)continue;if(!groups.has(sourceId))groups.set(sourceId,{label,entries:[]});groups.get(sourceId).entries.push(entry);}
  for(const [sourceId,group]of groups){output.push({value:'source:'+sourceId,label:group.label,kind:'source',sourceId});if(group.entries.length>1)for(const item of group.entries)output.push({...item,value:normalizeChoice(item.value),label:group.label+' · '+(item.version||item.label)});}
  const saved=settings[role.settingsKey];if(saved&&!['auto','automatic','inherit'].includes(saved)&&!options.some(option=>option.value===saved||option.value==='build:'+saved))output.push({value:saved,label:String(saved)+' (unavailable)',kind:'build',sourceId:data.id||''});
  result.roleKeys.push(role.settingsKey);result[role.settingsKey]=output;
 }
 return result;
}
module.exports={ROLES,normalizeChoice,projectRuntimeRoles};
