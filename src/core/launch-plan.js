'use strict';
const {getKind} = require('./component-kinds');
const {peMachineCode}=require('./binary-arch');

// This table applies to measured binaries, independently of publisher names.
function acceptsBinary(processHost, guestArch, integration, binary) {
  if(binary.format==='macho') return typeof processHost==='string'&&binary.architectures?.includes(processHost)
    ? {accepted:true} : {accepted:false,reason:`Host library has no ${processHost} Mach-O slice.`};
  if(binary.format==='pe') {
    const nativeHybrid=integration==='arm64ec' && guestArch==='x86_64' && ['arm64ec','arm64x'].includes(binary.machine);
    if(peMachineCode(guestArch)&&peMachineCode(binary.machine)&&(binary.machine===guestArch || nativeHybrid)) return {accepted:true};
    return {accepted:false,reason:`PE ${binary.machine} cannot load in ${guestArch} (${integration}).`};
  }
  return {accepted:false,reason:`No ${binary.format} integration is selected for this process.`};
}
const provides=b=>[...(getKind(b.kind)?.provides||[]),...(b.interfaces?.provides||[])];
const requires=b=>[...(getKind(b.kind)?.requires||[]),...(b.interfaces?.requires||[])];
const versionParts=v=>String(v||'').split('.').map(n=>Number(n)||0);
function versionAtLeast(actual,minimum) {const a=versionParts(actual),b=versionParts(minimum);for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)!==(b[i]||0))return(a[i]||0)>(b[i]||0);}return true;}

/** Resolve measured builds. Input order carries the catalog/default preference. */
function resolvePlan({target,choices={},builds=[],system={}}={}) {
  const excluded=[],unsatisfied=[],seen=new Set();
  function exclude(build,reason) {const row={kind:build.kind,source:build.source,build:build.id,reason},key=JSON.stringify(row);if(!seen.has(key)){seen.add(key);excluded.push(row);}return reason;}
  const chosenByUser=b=>!choices[b.kind] || choices[b.kind]==='automatic' || choices[b.kind]===b.source;
  const usable=b=>{
    if(!getKind(b.kind))return 'Unknown component kind.';
    if(b.available===false)return b.unavailableReason||'This build is unavailable.';
    if(!Array.isArray(b.binaries))return 'Measured binary facts are unavailable.';
    if(!chosenByUser(b))return 'Another source is selected for this kind.';
    return null;
  };
  function systemHas(token) {
    if(token.startsWith('macos>='))return /^\d+(?:\.\d+){0,2}$/.test(system.macOS||'')&&/^\d+(?:\.\d+){0,2}$/.test(token.slice(7))&&versionAtLeast(system.macOS,token.slice(7));
    return (system.provides||[]).includes(token);
  }
  function copy(state){return new Map(state);}
  function checked(build,host,guest,integration) {
    const issue=usable(build);if(issue)return issue;
    if(!build.binaries.length && build.kind!=='cpu-translator')return 'Measured binary facts are unavailable.';
    for(const binary of build.binaries){const check=acceptsBinary(host,guest,integration,binary);if(!check.accepted)return check.reason;}
    return null;
  }
  function* solve(tokens,state,context,trail=new Set()) {
    if(!tokens.length){yield state;return;}
    const [token,...rest]=tokens;
    if(systemHas(token)||[...state.values()].some(b=>provides(b).includes(token))){yield* solve(rest,state,context,trail);return;}
    if(trail.has(token))return;
    const nextTrail=new Set(trail);nextTrail.add(token);
    const candidates=builds.filter(b=>provides(b).includes(token)).sort((a,b)=>{
      if(context.integration!=='arm64ec')return 0;
      const native=b=>b.binaries?.some(f=>f.format==='pe'&&['arm64ec','arm64x'].includes(f.machine))?1:0;
      return native(b)-native(a);
    });
    for(const candidate of candidates) {
      if(state.has(candidate.kind) && state.get(candidate.kind).id!==candidate.id){exclude(candidate,'Another build already fills this kind.');continue;}
      const issue=checked(candidate,context.host,context.guest,context.integration);if(issue){exclude(candidate,issue);continue;}
      let resolved=false;
      for(const dependencies of solve(requires(candidate),copy(state),context,nextTrail)){
        if(dependencies.has(candidate.kind)&&dependencies.get(candidate.kind).id!==candidate.id)continue;
        if(candidate.parent && ![...dependencies.values()].some(b=>b.id===candidate.parent)){exclude(candidate,'The required parent build is not selected.');continue;}
        const next=copy(dependencies);next.set(candidate.kind,candidate);
        for(const complete of solve(rest,next,context,trail)){resolved=true;yield complete;}
      }
      if(!resolved)exclude(candidate,'A required interface or capability is unavailable.');
    }
  }
  const satisfyAll=(tokens,state,context)=>solve(tokens,state,context).next().value||null;
  function* translators(format,arch,host,integration,state,context) {
    for(const candidate of builds.filter(b=>b.kind==='cpu-translator')) {
      const issue=usable(candidate);if(issue){exclude(candidate,issue);continue;}
      const reaches=candidate.reach?.filter(r=>r.guestFormat===format&&r.guestArch===arch&&r.hostArch===host&&(!integration||r.integration===integration))||[];
      if(!reaches.length){exclude(candidate,`No declared ${format}/${arch} reach for ${host}.`);continue;}
      for(const reach of reaches){
      if(reach&&Object.keys(reach).some(key=>!['guestFormat','guestArch','hostArch','integration','requires'].includes(key))){exclude(candidate,'The translator reach contains unsupported constraints.');continue;}
      if(format==='macho' && (!system.rosettaAvailable||reach.integration!=='process')){exclude(candidate,'Rosetta is unavailable for this macOS process.');continue;}
      const ctx={...context,integration:reach.integration};
      const binaryIssue=checked(candidate,ctx.host,ctx.guest,ctx.integration);if(binaryIssue){exclude(candidate,binaryIssue);continue;}
      let reached=false;
      for(const next of solve([...requires(candidate),...(reach.requires||[])],copy(state),ctx)){
        if(candidate.parent&&![...next.values()].some(build=>build.id===candidate.parent)){exclude(candidate,'The required parent build is not selected.');continue;}
        reached=true;next.set(candidate.kind,candidate);yield {state:next,integration:reach.integration,build:candidate};
      }
      if(!reached)exclude(candidate,'The translator requires an unavailable host interface.');
      }
    }
  }

  const guest=target?.binaries?.find(b=>b.format==='pe')?.machine;
  if(!guest)return {satisfied:false,components:[],processes:[],downloads:[],excluded,unsatisfied:['A measured Windows target is required.']};
  for(const process of builds.filter(b=>b.kind==='wine')) {
    const issue=usable(process);if(issue){exclude(process,issue);continue;}
    const hosts=[...new Set(process.binaries.filter(b=>b.format==='macho').flatMap(b=>b.architectures||[]))];
    const ordered=[system.hostArch,...hosts.filter(a=>a!==system.hostArch)].filter(a=>hosts.includes(a));
    for(const host of ordered) {
      const hostIssue=process.binaries.filter(b=>b.format==='macho').map(b=>acceptsBinary(host,guest,'native',b)).find(result=>!result.accepted);
      if(hostIssue){exclude(process,hostIssue.reason);continue;}
      if(![system.hostArch,'x86_64'].includes(host) || host==='x86_64' && !['arm64','x86_64'].includes(system.hostArch)){exclude(process,`Cannot start a ${host} macOS process on ${system.hostArch}.`);continue;}
      const initial=new Map([['wine',process]]),processExecution=host===system.hostArch?'native':'rosetta';
      const hostRoutes=host===system.hostArch?[{state:initial}]:translators('macho',host,system.hostArch,'process',initial,{host,guest,integration:'native'});
      let foundHost=false;
      for(const hostRoute of hostRoutes){
        foundHost=true;
        const native=host==='x86_64'&&['x86_64','i386'].includes(guest)||host==='arm64'&&guest==='arm64';
        const guestRoutes=native?[{state:hostRoute.state,integration:'native',build:null}]:translators('pe',guest,host,null,hostRoute.state,{host,guest,integration:'native'});
        let foundGuest=false;
        for(const guestRoute of guestRoutes){
          foundGuest=true;
          let state=guestRoute.state;const integration=guestRoute.integration,guestTranslation=guestRoute.build;
          const context={host,guest,integration};
          const needs=[...(target.requires||[]),...requires(process)];
          for(const [kind,source] of Object.entries(choices))if(source&&source!=='automatic'&&kind!=='wine'&&kind!=='cpu-translator'){
            const explicit=builds.filter(b=>b.kind===kind&&b.source===source);
            if(!explicit.length){const reason=`The selected ${kind} source ${source} is unavailable.`;if(!unsatisfied.includes(reason))unsatisfied.push(reason);state=null;break;}
            const token=provides(explicit[0])[0];if(token)needs.push(token);else{state=null;break;}
          }
          if(state)state=satisfyAll(needs,state,context);
          if(!state){exclude(process,'The selected components have unsatisfied capabilities.');continue;}
          for(const candidate of builds){const problem=checked(candidate,host,guest,integration);if(problem)exclude(candidate,problem);}
          const components=[...state.values()].map(b=>{
            const binaries=b.binaries.map(binary=>({...structuredClone(binary),execution:binary.format==='macho'?processExecution:
              binary.format==='pe'&&binary.machine==='x86_64'&&guestTranslation?`fex(${guestTranslation.id})`:processExecution}));
            const executions=[...new Set(binaries.map(binary=>binary.execution))];
            return {kind:b.kind,source:b.source,build:b.id,installed:b.installed===true,
              ...(b.kind==='wine'?{execution:processExecution}:executions.length===1?{execution:executions[0]}:{}),
              binaries,adapter:getKind(b.kind).adapter};
          });
          const selectedIds=new Set(components.map(component=>component.build));
          return {satisfied:true,target:{guestArch:guest,execution:guestTranslation?`fex(${guestTranslation.id})`:processExecution},components,processes:[{build:process.id,hostArch:host,guestArch:guest,integration,execution:processExecution}],downloads:components.filter(b=>!b.installed).map(b=>b.build),excluded:excluded.filter(row=>!selectedIds.has(row.build)),unsatisfied};
        }
        if(!foundGuest)exclude(process,'The guest requires an unavailable CPU translator.');
      }
      if(!foundHost)exclude(process,'The host process requires an unavailable CPU translator.');
    }
  }
  if(choices.wine&&choices.wine!=='automatic'&&!builds.some(build=>build.kind==='wine'&&build.source===choices.wine))unsatisfied.push(`The selected Wine source ${choices.wine} is unavailable.`);
  unsatisfied.push('No complete execution plan satisfies the selected sources and capabilities.');
  return {satisfied:false,components:[],processes:[],downloads:[],excluded,unsatisfied};
}
module.exports={acceptsBinary,resolvePlan};
