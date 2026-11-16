'use strict';
const {getKind}=require('./component-kinds');
const {acceptsBinary}=require('./binary-compatibility');
const {selectLogicalLibraries,fileProvides}=require('./logical-libraries');
const {normalizeChoice}=require('./runtime-roles');
const provides=b=>[...(getKind(b.kind)?.provides||[]),...(b.interfaces?.provides||[]),...(b.binaries||[]).flatMap(fileProvides)];
// Kind requirements are never admission policy. Every dependency belongs to a build.
const requires=b=>(b.interfaces?.requires||[]).filter(token=>!token.startsWith('license:'));
const versionAtLeast=(a,b)=>{const x=String(a||'').split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++)if((x[i]||0)!==(y[i]||0))return(x[i]||0)>(y[i]||0);return true;};
const roleFor=(token,kind)=>token.startsWith('api:d3d')?token.slice(4):token==='api:dxgi'?'dxgi':({'vulkan-driver':'vulkan-driver',media:'video',nvapi:'nvapi',ngx:'ngx'})[kind]||kind;
function resolvePlan({target,choices={},builds=[],sources=[],system={},environment={},capabilities={},scene={}}={}){
 const excluded=[],failures=[],fallBacks=[],sourceById=new Map(sources.map(s=>[s.id,s]));
 const report=(b,reason)=>{if(!excluded.some(e=>e.build===b.id&&e.reason===reason))excluded.push({kind:b.kind,source:b.source,build:b.id,reason});return reason;};
 const systemHas=token=>token.startsWith('macos>=')?Boolean(system.macOS)&&versionAtLeast(system.macOS,token.slice(7)):(system.provides||[]).includes(token)||token===`cpu:${system.hostArch}`;
 const sourceOf=b=>sourceById.get(b.source)||{};
 function choice(role,kind){return normalizeChoice(choices[role]??choices[kind],{builds,sources});}
 function explicitMatches(b,value){return value==='automatic'||value==='inherit'||value===`build:${b.id}`||b.aliases?.some(a=>value===`build:${a}`)||value===`source:${b.source}`||value===`source:${sourceOf(b).manager?.engine}`;}
 function issue(b){if(!getKind(b.kind))return 'Unknown component kind.';if(b.available===false)return b.unavailableReason||'This build is unavailable.';if(!Array.isArray(b.binaries)||(!b.binaries.length&&b.kind!=='cpu-translator'&&!(b.installed===false&&b.measured===false&&b.declares)))return 'Measured binary facts are unavailable.';return null;}
 const selectedHas=(state,token)=>token.startsWith('entitlement:')?[...state.values()].some(row=>row.build.kind==='wine'&&row.build.measured===true&&provides(row.build).includes(token)):systemHas(token)||[...state.values()].some(row=>provides(row.build).includes(token)||row.tokens?.includes(token));
 function ordered(candidates,role,context,state){const wine=[...state.values()].find(x=>x.build.kind==='wine')?.build,source=sourceOf(wine||{}),automatic=source.automatic?.[role]||[];
  const positions=new Map();automatic.forEach((entry,index)=>{entry=typeof entry==='string'?{embed:entry}:entry;if(entry.requires?.some(t=>!selectedHas(state,t)))return;const when=entry.when;if(when?.setting){const equal=environment[when.setting]===when.equals;if(when.not?equal:!equal)return;}if(when?.selected){const matches=[...state.values()].some(row=>row.role===when.selected.role&&row.build.engine===when.selected.engine);if(when.not&&!when.setting?matches:!matches)return;}positions.set(entry.embed,index);});
  return [...candidates].sort((a,b)=>{const rank=x=>positions.has(x.id)?positions.get(x.id):positions.has(x.id.split(':').pop())?positions.get(x.id.split(':').pop()):1e6;const ar=rank(a),br=rank(b);if(ar!==br)return ar-br;if(a.installed!==b.installed)return a.installed?-1:1;const ao=sourceOf(a).order??a.order??1e6,bo=sourceOf(b).order??b.order??1e6;if(ao!==bo)return ao-bo;if(a.source===b.source){const av=String(a.version),bv=String(b.version);if(av!==bv)return av.localeCompare(bv,undefined,{numeric:true})*-1;}if(context.integration==='arm64ec'){const native=x=>x.binaries.some(f=>f.format==='pe'&&['arm64ec','arm64x'].includes(f.machine));if(native(a)!==native(b))return native(a)?-1:1;}return 0;});
 }
 function select(b,context,needed,role){const problem=issue(b);if(problem)return{reason:problem};
  if(b.installed===false&&b.measured===false&&b.declares){
   if(b.declares.macho&&!b.declares.macho.includes(context.host))return{accepted:false,reason:`Declared offer has no ${context.host} host architecture.`};
   if(b.declares.pe&&!b.declares.pe.some(machine=>acceptsBinary(context.host,context.cpuGuest?(context.integration==='wow64'?'arm64':'x86_64'):context.guest,context.cpuGuest?'arm64ec':context.integration,{format:'pe',machine}).accepted))return{accepted:false,reason:'Declared offer has no compatible guest architecture.'};
   return{accepted:true,binaries:[],provisional:true};
  }
  return selectLogicalLibraries({build:b,hostArch:context.host,guestArch:context.guest,integration:context.integration,needed,libraries:target?.libraries?.[role],infrastructure:b.kind==='cpu-translator'&&context.cpuGuest===true});}
 function* solve(tokens,state,context,trail=new Set()){
  if(!tokens.length){yield state;return;}const [token,...rest]=tokens;
  if(token.startsWith('license:')||selectedHas(state,token)){yield* solve(rest,state,context,trail);return;}if(trail.has(token))return;const nextTrail=new Set(trail).add(token);
  const wine=[...state.values()].find(row=>row.role==='wine')?.build,source=sourceOf(wine||{}),delegatedRole=token.startsWith('api:d3d')?token.slice(4):null;
  if(delegatedRole&&source.selector&&choice(delegatedRole,'d3d-translator')==='automatic'){
   const next=new Map(state);next.set(delegatedRole,{role:delegatedRole,build:wine,binaries:[],tokens:[token],delegated:{key:source.selector.key,value:source.selector.automatic,reason:`decided by ${source.label} at launch`}});yield* solve(rest,next,context,trail);return;
  }
  const pendingOffer=b=>b.kind==='d3d-translator'&&b.installed===false&&b.measured===false&&b.declares?.pe?.length&&/^api:(?:d3d(?:8|9|10|11|12)|dxgi)$/.test(token);
  const all=builds.filter(b=>(provides(b).includes(token)||pendingOffer(b))&&b.kind!=='wine');
  const requested=choice(roleFor(token,all[0]?.kind),all[0]?.kind);
  const ranked=ordered(all,roleFor(token,all[0]?.kind),context,state);
  if(requested!=='automatic'&&requested!=='inherit'){
   const original=builds.find(b=>explicitMatches(b,requested)),wine=[...state.values()].find(row=>row.build.kind==='wine')?.build;
   const rank=b=>explicitMatches(b,requested)?0:original?.engine&&b.engine===original.engine&&b.parent===wine?.id?1:2;
   ranked.sort((a,b)=>rank(a)-rank(b));
  }
  for(const candidate of ranked){
   const role=roleFor(token,candidate.kind),value=choice(role,candidate.kind),explicit=value!=='automatic'&&value!=='inherit';
   const wanted=all.filter(b=>explicitMatches(b,value));

   if(candidate.kind==='cpu-translator'&&[...state.values()].some(row=>row.build.kind==='cpu-translator'&&row.role.startsWith('cpu.')&&row.build.id!==candidate.id)){report(candidate,'Another build already fills this CPU translation role.');continue;}
   if(state.has(role)&&state.get(role).build.id!==candidate.id){report(candidate,'Another build already fills this role.');continue;}
   if(candidate.parent&&![...state.values()].some(x=>x.build.id===candidate.parent)){report(candidate,'The required parent build is not selected.');continue;}
   const parts=select(candidate,context,[token],role);if(parts.reason||parts.accepted===false){report(candidate,parts.reason);continue;}
   const next=new Map(state);next.set(role,{role,build:candidate,binaries:parts.binaries,...(pendingOffer(candidate)&&!provides(candidate).includes(token)?{tokens:[token],capabilitiesPending:[token]}:{})});
   let found=false;for(const dependencies of solve(requires(candidate),next,context,nextTrail))for(const complete of solve(rest,dependencies,context,trail)){found=true;yield complete;}
   if(!found)report(candidate,'A required interface or capability is unavailable.');
  }
 }
 function* translator(format,arch,host,integration,state,context){
  const role=format==='macho'?'cpu.host':`cpu.${arch}`;
  for(const b of builds.filter(b=>b.kind==='cpu-translator')){
   const problem=issue(b);if(problem){report(b,problem);continue;}
   if(!explicitMatches(b,choice(role,b.kind)))continue;
   if(b.parent&&![...state.values()].some(x=>x.build.id===b.parent)){report(b,'The required parent build is not selected.');continue;}
   const reaches=(b.reach||[]).filter(r=>r.guestFormat===format&&r.guestArch===arch&&r.hostArch===host&&(!integration||r.integration===integration)&&(!r.guestOS||r.guestOS===(format==='pe'?'windows':'darwin'))&&(!r.hostPlatform||r.hostPlatform===(system.platform||'darwin')));
   if(!reaches.length){report(b,`No declared ${format}/${arch} reach for ${host}.`);continue;}
   for(const reach of reaches){if(Object.keys(reach).some(key=>!['guestFormat','guestArch','guestOS','hostPlatform','hostArch','integration','requires'].includes(key))){report(b,'The translator reach contains unsupported constraints.');continue;}if(format==='macho'&&(!system.rosettaAvailable||reach.integration!=='process')){report(b,'Rosetta is unavailable for this macOS process.');continue;}
    const ctx={...context,integration:reach.integration,cpuGuest:format==='pe'},parts=select(b,ctx,[],role);if(parts.reason||parts.accepted===false){report(b,parts.reason);continue;}
    const next=new Map(state);next.set(role,{role,build:b,binaries:parts.binaries,reach});
    for(const complete of solve([...requires(b),...(reach.requires||[])],next,ctx))yield{state:complete,integration:reach.integration,build:b};
   }
  }
 }
 function result(state,context,process,targetExecution){
  // A final closure check prevents a dependency from being lost during assignment.
  for(const row of state.values())for(const token of [...requires(row.build),...(row.reach?.requires||[])])if(!token.startsWith('license:')&&!selectedHas(state,token))return null;
  const merged=new Map();for(const row of state.values()){let c=merged.get(row.build.id);if(!c){c={kind:row.build.kind,source:row.build.source,build:row.build.id,installed:row.build.installed===true,measured:row.build.measured!==false,adapter:getKind(row.build.kind).adapter,binaries:[],roles:[],capabilitiesPending:[]};merged.set(row.build.id,c);}c.roles.push(row.role);c.capabilitiesPending.push(...(row.capabilitiesPending||[]));for(const b of row.binaries||[])if(!c.binaries.some(f=>f.path===b.path))c.binaries.push({...structuredClone(b),execution:b.format==='macho'?context.execution:b.format==='pe'&&['arm64ec','arm64x','arm64'].includes(b.machine)&&context.host==='arm64'?'native':context.guestTranslator&&b.machine==='x86_64'?`fex(${context.guestTranslator.id})`:context.execution});}
  const components=[...merged.values()].map(c=>{const executions=[...new Set(c.binaries.map(b=>b.execution))];return{...c,...(executions.length===1?{execution:executions[0]}:{})};});
  const roles=[...state.values()].filter(r=>!r.role.startsWith('dependency:')).map(row=>{const saved=choice(row.role,row.build.kind),fallback=!explicitMatches(row.build,saved)&&saved!=='automatic'&&saved!=='inherit'?{role:row.role,chosen:saved,used:row.build.id,reason:'Saved selection is unavailable or incompatible.'}:null;if(fallback)fallBacks.push(fallback);return{id:row.role,...(row.capabilitiesPending?{capabilitiesPending:row.capabilitiesPending}:{}),value:choices[row.role]??choices[row.build.kind]??'automatic',...(row.delegated?{delegated:row.delegated}:{}),used:{...row.build,...(row.delegated?{label:row.delegated.reason}:{}),binaries:components.find(c=>c.build===row.build.id).binaries,execution:components.find(c=>c.build===row.build.id).execution},fallback};});
  const selectedIds=new Set(components.map(c=>c.build)),provisional=components.some(c=>!c.installed||!c.measured);
  const sameScene=scene.final&&scene.hudless&&['frame','pass','geometry','origin','colorDomain'].every(key=>scene.final[key]!==undefined&&scene.final[key]!==null&&scene.final[key]!==''&&scene.final[key]!=='unknown'&&JSON.stringify(scene.final[key])===JSON.stringify(scene.hudless[key]));
  return{satisfied:true,provisional,target:{guestArch:context.guest,execution:targetExecution},components,roles,processes:[process],downloads:components.filter(c=>!c.installed).map(c=>c.build),fallbacks:fallBacks,excluded:excluded.filter(e=>!selectedIds.has(e.build)),unsatisfied:[],graphics:{derivedUiFromFinalHudless:{enabled:capabilities.derivedUiFromFinalHudless===true&&Boolean(sameScene),reason:'UI derived from final and HUD-less color'}}};
 }
 const targetBinary=target?.binaries?.find(b=>b.format==='pe')||target?.binaries?.find(b=>b.format==='macho');
 if(!targetBinary)return{satisfied:false,components:[],processes:[],downloads:[],excluded,unsatisfied:['A measured executable target is required.']};
 if(targetBinary.format==='macho'){
  const hosts=[system.hostArch,...targetBinary.architectures.filter(a=>a!==system.hostArch)].filter(a=>targetBinary.architectures.includes(a));
  for(const host of hosts){const execution=host===system.hostArch?'native':'rosetta';if(execution==='rosetta'&&!(host==='x86_64'&&system.hostArch==='arm64'))continue;const context={host,guest:host,integration:'native',execution};const routes=execution==='native'?[{state:new Map()}]:translator('macho',host,system.hostArch,'process',new Map(),context);for(const route of routes)for(const state of solve(target.requires||[],route.state,context)){const plan=result(state,context,{build:target.id||'target',hostArch:host,guestArch:host,integration:'native',execution},execution);if(plan)return plan;}}
 }else{
  const guest=targetBinary.machine;
  for(const wine of builds.filter(b=>b.kind==='wine')){if(!explicitMatches(wine,choice('wine','wine')))continue;const problem=issue(wine);if(problem){report(wine,problem);continue;}
   const hosts=[...new Set(wine.binaries.length?wine.binaries.filter(b=>b.format==='macho').flatMap(b=>b.architectures):wine.declares?.macho||[])].sort((a,b)=>(b===system.hostArch?1:0)-(a===system.hostArch?1:0));
   for(const host of hosts){if(host!==system.hostArch&&!(host==='x86_64'&&system.hostArch==='arm64'))continue;const execution=host===system.hostArch?'native':'rosetta',context={host,guest,integration:'native',execution};const parts=select(wine,context,[],'wine');if(parts.reason){report(wine,parts.reason);continue;}const initial=new Map([['wine',{role:'wine',build:wine,binaries:parts.binaries}]]),hostRoutes=execution==='native'?[{state:initial}]:translator('macho',host,system.hostArch,'process',initial,context);
    for(const hostRoute of hostRoutes){const native=host==='x86_64'&&['x86_64','i386'].includes(guest)||host==='arm64'&&guest==='arm64',guestRoutes=native?[{state:hostRoute.state,integration:'native'}]:translator('pe',guest,host,null,hostRoute.state,context);let reached=false;
     for(const route of guestRoutes){reached=true;const ctx={...context,integration:route.integration,guestTranslator:route.build};for(const state of solve([...(target.requires||[]),...requires(wine)],route.state,ctx)){const plan=result(state,ctx,{build:wine.id,hostArch:host,guestArch:guest,integration:ctx.integration,execution},route.build?`fex(${route.build.id})`:execution);if(plan)return plan;}}
     if(!reached)report(wine,'The guest requires an unavailable CPU translator.');
    }
   }
  }
 }
 failures.push('No complete execution plan satisfies the selected sources and capabilities.');return{satisfied:false,components:[],roles:[],processes:[],downloads:[],excluded,unsatisfied:failures};
}
module.exports={acceptsBinary,resolvePlan,selectLogicalLibraries};
// Existing saved-description inputs have one compatibility adapter. The old
// selector module paths are removed; all live imports use this resolver package.
module.exports.resolveLegacyPlan=input=>require('./runtime-resolution/translator-plan').resolvePlan(input);
module.exports.resolveLegacyApiRoles=(plan,input)=>require('./runtime-resolution/translator-plan').resolveApiRoles(plan,input);
