'use strict';
const {getKind} = require('./component-kinds');

// This table applies to measured binaries, independently of publisher names.
function acceptsBinary(processHost, guestArch, integration, binary) {
  if(binary.format==='macho') return binary.architectures?.includes(processHost)
    ? {accepted:true} : {accepted:false,reason:`Host library has no ${processHost} Mach-O slice.`};
  if(binary.format==='pe') {
    const nativeHybrid=integration==='arm64ec' && guestArch==='x86_64' && ['arm64ec','arm64x'].includes(binary.machine);
    if(binary.machine===guestArch || nativeHybrid) return {accepted:true};
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
    if(token.startsWith('macos>='))return Boolean(system.macOS)&&versionAtLeast(system.macOS,token.slice(7));
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
  function translator(format,arch,host,integration,state,context) {
    for(const candidate of builds.filter(b=>b.kind==='cpu-translator')) {
      const issue=usable(candidate);if(issue){exclude(candidate,issue);continue;}
      const reach=candidate.reach?.find(r=>r.guestFormat===format&&r.guestArch===arch&&r.hostArch===host&&(!integration||r.integration===integration));
      if(reach&&Object.keys(reach).some(key=>!['guestFormat','guestArch','hostArch','integration','requires'].includes(key))){exclude(candidate,'The translator reach contains unsupported constraints.');continue;}
      if(!reach){exclude(candidate,`No declared ${format}/${arch} reach for ${host}.`);continue;}
      if(format==='macho' && (!system.rosettaAvailable||reach.integration!=='process')){exclude(candidate,'Rosetta is unavailable for this macOS process.');continue;}
      const ctx={...context,integration:reach.integration};
      const binaryIssue=checked(candidate,ctx.host,ctx.guest,ctx.integration);if(binaryIssue){exclude(candidate,binaryIssue);continue;}
      let next=satisfyAll([...requires(candidate),...(reach.requires||[])],copy(state),ctx);
      if(!next){exclude(candidate,'The translator requires an unavailable host interface.');continue;}
      next.set(candidate.kind,candidate);return {state:next,integration:reach.integration,build:candidate};
    }
    return null;
  }
  const guest=target?.binaries?.find(b=>b.format==='pe')?.machine;
  if(!guest)return {satisfied:false,components:[],processes:[],downloads:[],excluded,unsatisfied:['A measured Windows target is required.']};
  for(const process of builds.filter(b=>b.kind==='wine')) {
    const issue=usable(process);if(issue){exclude(process,issue);continue;}
    const hosts=[...new Set(process.binaries.filter(b=>b.format==='macho').flatMap(b=>b.architectures||[]))];
    const ordered=[system.hostArch,...hosts.filter(a=>a!==system.hostArch)].filter(a=>hosts.includes(a));
    for(const host of ordered) {
      if(![system.hostArch,'x86_64'].includes(host) || host==='x86_64' && !['arm64','x86_64'].includes(system.hostArch)){exclude(process,`Cannot start a ${host} macOS process on ${system.hostArch}.`);continue;}
      let state=new Map([['wine',process]]),integration='native',guestTranslation=null,processExecution='native';
      if(host!==system.hostArch) {
        const route=translator('macho',host,system.hostArch,'process',state,{host,guest,integration});
        if(!route){exclude(process,'The host process requires an unavailable CPU translator.');continue;}
        state=route.state;processExecution='rosetta';
      }
      const native=host==='x86_64'&&['x86_64','i386'].includes(guest)||host==='arm64'&&guest==='arm64';
      if(!native) {
        const route=translator('pe',guest,host,null,state,{host,guest,integration});
        if(!route){exclude(process,'The guest requires an unavailable CPU translator.');continue;}
        state=route.state;integration=route.integration;guestTranslation=route.build;
      }
      const context={host,guest,integration};
      const needs=[...(target.requires||[]),...requires(process)];
      for(const [kind,source] of Object.entries(choices))if(source&&source!=='automatic'&&kind!=='wine'&&kind!=='cpu-translator'){
        const explicit=builds.filter(b=>b.kind===kind&&b.source===source);
        if(!explicit.length){state=null;break;}
        const token=provides(explicit[0])[0];if(token)needs.push(token);else{state=null;break;}
      }
      if(state)state=satisfyAll(needs,state,context);
      if(!state){exclude(process,'The selected components have unsatisfied capabilities.');continue;}
      for(const candidate of builds){const problem=checked(candidate,host,guest,integration);if(problem)exclude(candidate,problem);}
      const components=[...state.values()].map(b=>{
        const binaries=b.binaries.map(binary=>({...structuredClone(binary),execution:binary.format==='macho'?processExecution:
          binary.format==='pe'&&binary.machine==='x86_64'&&guestTranslation?`fex(${guestTranslation.id})`:'native'}));
        const executions=[...new Set(binaries.map(binary=>binary.execution))];
        return {kind:b.kind,source:b.source,build:b.id,installed:b.installed===true,
          ...(b.kind==='wine'?{execution:processExecution}:executions.length===1?{execution:executions[0]}:{}),
          binaries,adapter:getKind(b.kind).adapter};
      });
      return {satisfied:true,components,processes:[{build:process.id,hostArch:host,guestArch:guest,integration,execution:processExecution}],downloads:components.filter(b=>!b.installed).map(b=>b.build),excluded,unsatisfied};
    }
  }
  unsatisfied.push('No complete execution plan satisfies the selected sources and capabilities.');
  return {satisfied:false,components:[],processes:[],downloads:[],excluded,unsatisfied};
}
module.exports={acceptsBinary,resolvePlan};
