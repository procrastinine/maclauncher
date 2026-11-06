const test=require('node:test'),assert=require('node:assert/strict');
const {supportsInput,ensureInputRuntime}=require('../src/modules/nxnative/prepare');
function fixture(){
 const old={version:'old',config:{}},next={version:'next',config:{capabilities:{keylessInputs:['nup','dump'],packageSelection:true}}},events=[];
 let installed=false;
 const tools={id:'nxnative-tools',getState:()=>({installed:installed?[{version:'next',ready:true}]:[{version:'old',ready:true}],catalog:{versions:['next'],versionRequirements:{}}}),
 resolveSelection:(_entry,_settings,_root,options={})=>({install:(options.version==='next'||installed)?next:old}),
 refreshCatalog:async()=>events.push('refresh'),installRuntime:async options=>{assert.equal(options.version,'next');events.push('install');installed=true;return next;}};
 const context={userDataDir:'/synthetic-profile',settings:{},confirmRuntimeInstall:async()=>{events.push('consent');return true;},onEntryChange(){},onRuntimeStateChange:()=>events.push('state')};
 const entry={},selection={version:'git-'+'a'.repeat(40),sourceInstall:{root:'/synthetic-source'},install:old,runtime:{config:old.config}};
 const deps={runtimeManager:{toolsManager:tools},runtimeForSelection:async value=>({config:value.install.config})};
 return{old,next,tools,entry,selection,context,deps,events,setInstalled:()=>{installed=true;}};
}
test('feature requirements depend on input and package choice, never a runtime version',()=>{
 assert.equal(supportsInput({config:{}},{format:'nsp'},'latest'),true);
 for(const format of ['nup','dump'])assert.equal(supportsInput({config:{}},{format},'latest'),false);
 assert.equal(supportsInput({config:{capabilities:{keylessInputs:['nup']}}},{format:'nup'},'v7'),false);
 assert.equal(supportsInput({config:{capabilities:{keylessInputs:['nup'],packageSelection:true}}},{format:'nup'},'v7'),true);
});
test('old installed tools require consent before discovery/install and retain a per-game tools choice',async()=>{
 const f=fixture();const selected=await ensureInputRuntime(f.entry,f.context,f.selection,{format:'nup'},'latest',f.deps);
 assert.deepEqual(f.events,['consent','refresh','install','state']);assert.equal(selected.install,f.next);assert.equal(f.entry.runtimeData['nxnative-tools'].version,'next');
 f.events.length=0;await ensureInputRuntime(f.entry,f.context,selected,{format:'nup'},'latest',f.deps);assert.deepEqual(f.events,[]);
});
test('declining a feature update performs no discovery or installation',async()=>{
 const f=fixture();f.context.confirmRuntimeInstall=async()=>{f.events.push('decline');return false;};
 await assert.rejects(ensureInputRuntime(f.entry,f.context,f.selection,{format:'dump'},'latest',f.deps),{name:'AbortError'});assert.deepEqual(f.events,['decline']);
});
test('an already installed capable package is reused offline without download consent',async()=>{
 const f=fixture();f.setInstalled();await ensureInputRuntime(f.entry,f.context,f.selection,{format:'dump'},'v7',f.deps);assert.deepEqual(f.events,[]);assert.equal(f.entry.runtimeData['nxnative-tools'].version,'next');
});
test('a downloaded package still lacking a requested API fails before the game pipeline',async()=>{
 const f=fixture();f.next.config={capabilities:{keylessInputs:['nup']}};
 await assert.rejects(ensureInputRuntime(f.entry,f.context,f.selection,{format:'nup'},'v7',f.deps),/do not support/);
 assert.deepEqual(f.events,['consent','refresh','install','state']);assert.equal(f.entry.runtimeData,undefined);
});
