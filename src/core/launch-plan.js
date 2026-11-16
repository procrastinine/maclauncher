'use strict';
const {acceptsBinary,normalizeHostArchitecture}=require('./binary-compatibility');
const {selectLogicalLibraries,fileProvides}=require('./logical-libraries');
function resolvePlan(input={}){
 if(input.wine)return require('./runtime-resolution/wine-plan').resolveWine(input.wine,input.wineDependencies);
 const {target={},system={},builds=[],sources=[],choices={}}=input;
 const sourceOf=build=>sources.find(source=>source.id===(build.sourceId||build.source))||{};
 const matches=(build,value)=>!value||['automatic','auto','inherit'].includes(value)||value==='source:'+(build.sourceId||build.source)||value==='build:'+build.id||value===build.id||build.aliases?.includes(value.replace(/^build:/,''));
 const order=items=>[...items].sort((a,b)=>(sourceOf(a).order??a.order??999)-(sourceOf(b).order??b.order??999)||(a.installed===b.installed?0:a.installed?-1:1)||String(b.version).localeCompare(String(a.version),undefined,{numeric:true}));
 const image=target.binaries?.[0]||{},guest=normalizeHostArchitecture(image.machine||target.guestArch),wine=order(builds.filter(build=>build.kind==='wine'&&matches(build,choices.wine)))[0];
 const host=normalizeHostArchitecture(input.hostArch||wine?.binaries?.find(binary=>binary.format==='macho')?.architectures?.find(arch=>arch===normalizeHostArchitecture(system.hostArch))||wine?.binaries?.find(binary=>binary.format==='macho')?.architectures?.[0]||wine?.intendedCPU||system.hostArch);
 const components=[],roles=[],excluded=[],fallbacks=[];
 const add=(build,role,needed=[])=>{const selected=selectLogicalLibraries({build,hostArch:host,guestArch:guest,needed,libraries:target.libraries?.[role],infrastructure:build.kind==='cpu-translator'});if(!selected.accepted){excluded.push({build:build.id,reason:selected.reason});return false;}let component=components.find(item=>item.build===build.id);if(!component){component={build:build.id,sourceId:build.sourceId||build.source,source:build.sourceId||build.source,kind:build.kind,installed:build.installed===true,measured:build.measured===true,binaries:[],roles:[]};components.push(component);}component.roles.push(role);for(const binary of selected.binaries)if(!component.binaries.some(item=>item.path===binary.path))component.binaries.push(binary);roles.push({id:role,value:choices[role]||'automatic',used:build});return true;};
 if(wine&&!add(wine,'wine'))return {satisfied:false,components:[],roles:[],excluded,downloads:[],unsatisfied:['Wine has no matching architecture.']};
 if(host==='arm64'&&['x86_64','i386'].includes(guest)){
  const cpu=order(builds.filter(build=>build.kind==='cpu-translator'&&(!build.parent||build.parent===wine?.id)&&matches(build,choices['cpu.'+guest])));if(cpu.length)add(cpu[0],'cpu.'+guest);
 }
 const rolesNeeded=target.roles||Object.keys(target.libraries||{});
 for(const role of rolesNeeded){const value=choices[role]||choices[role.startsWith('d3d')?'d3d-translator':role]||'automatic';const kind=role.startsWith('d3d')?'d3d-translator':role==='video'?'media':role;
  // Automatic belongs to the selected Wine; managed builds require an explicit choice.
  const candidates=order(builds.filter(build=>build.kind===kind&&(!build.parent||build.parent===wine?.id)&&(!['automatic','inherit','auto'].includes(value)||build.parent===wine?.id)));
  const preferred=candidates.filter(build=>matches(build,value)),fallback=candidates.filter(build=>build.parent===wine?.id&&!preferred.includes(build));
  for(const build of [...preferred,...fallback]){const known=(build.binaries||[]).flatMap(fileProvides);if(role.startsWith('d3d')&&role!=='d3d-renderer'&&known.length&&!known.includes(role))continue;if(add(build,role,[role])){if(!matches(build,value))fallbacks.push({role,chosen:value,used:build.id});break;}}
 }
 const needsVulkan=roles.some(role=>sourceOf(role.used).vulkan===true);
 if(needsVulkan&&!roles.some(role=>role.id==='vulkan-driver')){const value=choices['vulkan-driver']||'automatic';for(const build of order(builds.filter(build=>build.kind==='vulkan-driver'&&(!build.parent||build.parent===wine?.id)&&(!['automatic','inherit'].includes(value)||build.parent===wine?.id)&&matches(build,value))))if(add(build,'vulkan-driver'))break;}
 const downloads=components.filter(component=>!component.installed).map(component=>component.build),execution=host&&system.hostArch?(host===normalizeHostArchitecture(system.hostArch)?'native':'rosetta'):undefined;
 return {satisfied:true,provisional:downloads.length>0,components,roles,downloads,fallbacks,excluded,unsatisfied:[],processes:[{build:wine?.id||target.id,hostArch:host,guestArch:guest,execution,expectedTranslated:execution?Number(execution==='rosetta'):undefined}]};
}
module.exports={resolvePlan,acceptsBinary,selectLogicalLibraries,resolveLegacyPlan:input=>require('./runtime-resolution/translator-plan').resolvePlan(input),resolveLegacyApiRoles:(plan,input)=>require('./runtime-resolution/translator-plan').resolveApiRoles(plan,input)};
